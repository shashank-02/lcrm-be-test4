import { Router } from 'express';
import { logger } from '../../config/logger';
import { z } from 'zod';
import { asyncHandler, ok, created } from '../../common/http';
import { badRequest, forbidden, notFound } from '../../common/errors';
import { validate } from '../../middleware/validate';
import { hasPermission, requirePermission } from '../../middleware/auth';
import { idParam, normalise } from '../../common/crud';
import { CallLog, Note, Status, Task, User, Lead } from '../../models';
import { logActivity } from '../../services/activity.service';
import { getLeadInScope, markContacted, objectId } from './lead.service';
import { notifyOwnerOfAdminAction } from '../../services/scheduler.service';
import { recomputeLeadPriority } from '../../services/prioritization.service';

/** Notes, tasks and call logs — mounted under /leads/:leadId/... */
export const subEntitiesRouter = Router({ mergeParams: true });
const leadParam = z.object({ leadId: objectId });
const dateish = z.union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}/)]).transform((s) => new Date(s));

type UserRef = { id: string; name: string; avatarColor?: string };
async function withUsers<T extends { _id?: unknown; createdById?: unknown; assigneeId?: unknown }>(items: T[]) {
  const ids = Array.from(new Set(items.flatMap((i) => [i.createdById, i.assigneeId]).filter(Boolean).map(String)));
  const users = await User.find({ _id: { $in: ids } }).select('name avatarColor').lean();
  const um = new Map(users.map((u) => [String(u._id), normalise(u) as UserRef]));
  return items.map((i) => ({ ...normalise(i as { _id: unknown }), createdBy: i.createdById ? um.get(String(i.createdById)) ?? null : null, assignee: i.assigneeId ? um.get(String(i.assigneeId)) ?? null : null })) as Array<Omit<T, '_id'> & { id: string; createdBy: UserRef | null; assignee: UserRef | null }>;
}
const visibility = (role: string) => (role === 'admin' ? {} : { hidden: false });

/** Runs a non-essential follow-up write; logs and swallows failures so the primary action's success is preserved. */
async function secondary(label: string, fn: () => Promise<unknown>) { try { await fn(); } catch (err) { logger.warn({ err, label }, 'secondary update after a successful write failed'); } }

// ---------- Notes ----------
subEntitiesRouter.get('/notes', requirePermission('note.view'), validate({ params: leadParam }), asyncHandler(async (req, res) => {
  const lead = await getLeadInScope(req.user!, req.params.leadId);
  ok(res, await withUsers(await Note.find({ leadId: lead._id, ...visibility(req.user!.role) }).sort({ createdAt: -1 }).lean()));
}));
subEntitiesRouter.post('/notes', requirePermission('note.create'), validate({ params: leadParam, body: z.object({ body: z.string().min(1).max(5000), remindAt: dateish.nullable().optional() }) }), asyncHandler(async (req, res) => {
  const lead = await getLeadInScope(req.user!, req.params.leadId);
  const note = await Note.create({ orgId: req.user!.orgId, leadId: lead._id, createdById: req.user!.id, body: req.body.body, remindAt: req.body.remindAt ?? null });
  // The note is the primary write. Everything after it is secondary bookkeeping: a failure there is logged and
  // never reported to the client as a failed save (the note already exists).
  await secondary('note.remarks', () => Lead.updateOne({ _id: lead._id }, { $set: { remarks: req.body.body.slice(0, 500) } }));
  await secondary('note.activity', () => logActivity({ orgId: req.user!.orgId, leadId: lead._id, userId: req.user!.id, type: 'note_added', description: req.body.body.slice(0, 200), payload: { noteId: note._id } }));
  await secondary('note.notify', () => notifyOwnerOfAdminAction(req.user!, lead, 'admin_note', req.body.body.slice(0, 140)));
  created(res, (await withUsers([note.toObject()]))[0]);
}));
subEntitiesRouter.patch('/notes/:id', requirePermission('note.edit'), validate({ params: leadParam.merge(idParam), body: z.object({ body: z.string().min(1).max(5000) }) }), asyncHandler(async (req, res) => {
  const lead = await getLeadInScope(req.user!, req.params.leadId);
  const note = await Note.findOne({ _id: req.params.id, leadId: lead._id });
  if (!note) throw notFound('Note');
  // Edit is governed purely by the note.edit permission (admin-controlled), regardless of author.
  if (!hasPermission(req.user!, 'note.edit')) throw forbidden('You do not have permission to edit notes');
  note.body = req.body.body; await note.save();
  await logActivity({ orgId: req.user!.orgId, leadId: lead._id, userId: req.user!.id, type: 'note_updated', description: 'Note edited' });
  ok(res, (await withUsers([note.toObject()]))[0]);
}));
subEntitiesRouter.delete('/notes/:id', requirePermission('note.delete'), validate({ params: leadParam.merge(idParam) }), asyncHandler(async (req, res) => {
  const lead = await getLeadInScope(req.user!, req.params.leadId);
  const r = await Note.deleteOne({ _id: req.params.id, leadId: lead._id });
  if (!r.deletedCount) throw notFound('Note');
  await logActivity({ orgId: req.user!.orgId, leadId: lead._id, userId: req.user!.id, type: 'note_deleted', description: 'Note deleted' });
  ok(res, { deleted: true });
}));

// ---------- Tasks ----------
const taskBody = z.object({ title: z.string().min(1).max(200), description: z.string().max(2000).optional(), dueAt: dateish.nullable().optional(), assigneeId: objectId.nullable().optional() });
subEntitiesRouter.get('/tasks', requirePermission('task.view'), validate({ params: leadParam }), asyncHandler(async (req, res) => {
  const lead = await getLeadInScope(req.user!, req.params.leadId);
  ok(res, await withUsers(await Task.find({ leadId: lead._id }).sort({ status: 1, dueAt: 1, createdAt: -1 }).lean()));
}));
subEntitiesRouter.post('/tasks', requirePermission('task.create'), validate({ params: leadParam, body: taskBody }), asyncHandler(async (req, res) => {
  const lead = await getLeadInScope(req.user!, req.params.leadId);
  const task = await Task.create({ ...req.body, orgId: req.user!.orgId, leadId: lead._id, createdById: req.user!.id, assigneeId: req.body.assigneeId ?? lead.ownerId ?? req.user!.id });
  await logActivity({ orgId: req.user!.orgId, leadId: lead._id, userId: req.user!.id, type: 'task_created', description: `Task: ${task.title}`, payload: { taskId: task._id } });
  created(res, (await withUsers([task.toObject()]))[0]);
}));
subEntitiesRouter.patch('/tasks/:id', requirePermission('task.edit'), validate({ params: leadParam.merge(idParam), body: taskBody.partial().extend({ status: z.enum(['open', 'done', 'cancelled']).optional() }) }), asyncHandler(async (req, res) => {
  const lead = await getLeadInScope(req.user!, req.params.leadId);
  const task = await Task.findOne({ _id: req.params.id, leadId: lead._id });
  if (!task) throw notFound('Task');
  task.set(req.body);
  if (req.body.status === 'done' && !task.completedAt) task.completedAt = new Date();
  if (req.body.status === 'open') task.completedAt = null;
  await task.save();
  await logActivity({ orgId: req.user!.orgId, leadId: lead._id, userId: req.user!.id, type: 'task_updated', description: `Task ${task.status}: ${task.title}` });
  ok(res, (await withUsers([task.toObject()]))[0]);
}));
subEntitiesRouter.delete('/tasks/:id', requirePermission('task.delete'), validate({ params: leadParam.merge(idParam) }), asyncHandler(async (req, res) => {
  const lead = await getLeadInScope(req.user!, req.params.leadId);
  const r = await Task.deleteOne({ _id: req.params.id, leadId: lead._id });
  if (!r.deletedCount) throw notFound('Task');
  ok(res, { deleted: true });
}));

// ---------- Call logs ----------
subEntitiesRouter.get('/calls', requirePermission('call.view'), validate({ params: leadParam }), asyncHandler(async (req, res) => {
  const lead = await getLeadInScope(req.user!, req.params.leadId);
  const calls = await CallLog.find({ leadId: lead._id, ...visibility(req.user!.role) }).sort({ createdAt: -1 }).lean();
  const statuses = await Status.find({ orgId: req.user!.orgId }).select('name color').lean();
  const sm = new Map(statuses.map((s) => [String(s._id), normalise(s)]));
  ok(res, (await withUsers(calls)).map((c) => ({ ...c, outcomeStatus: c.outcomeStatusId ? sm.get(String(c.outcomeStatusId)) ?? null : null })));
}));
subEntitiesRouter.post('/calls', requirePermission('call.create'), validate({ params: leadParam, body: z.object({ outcomeStatusId: objectId.nullable().optional(), outcome: z.string().max(80).optional(), subStatus: z.string().max(60).optional(), callStatus: z.enum(['connected', 'not_connected', 'busy', 'no_answer', 'switched_off', 'wrong_number', 'voicemail', '']).optional(), notes: z.string().max(2000).optional(), durationSec: z.number().int().min(0).max(86400).optional(), followUpAt: dateish.nullable().optional(), direction: z.enum(['outbound', 'inbound']).optional(), updateLeadStatus: z.boolean().optional() }) }), asyncHandler(async (req, res) => {
  const lead = await getLeadInScope(req.user!, req.params.leadId);
  let outcome = req.body.outcome ?? '';
  if (req.body.outcomeStatusId) {
    const st = await Status.findOne({ _id: req.body.outcomeStatusId, orgId: req.user!.orgId }).lean();
    if (!st) throw badRequest('Status not found');
    outcome = st.name;
    if (req.body.updateLeadStatus !== false && hasPermission(req.user!, 'lead.update_status')) lead.statusId = st._id as never;
  }
  const call = await CallLog.create({ ...req.body, outcome, orgId: req.user!.orgId, leadId: lead._id, createdById: req.user!.id });
  markContacted(lead);
  if (req.body.followUpAt !== undefined) lead.nextFollowUpAt = req.body.followUpAt;
  if (req.body.notes) lead.remarks = req.body.notes.slice(0, 500);
  await lead.save();
  await logActivity({ orgId: req.user!.orgId, leadId: lead._id, userId: req.user!.id, type: 'call_logged', description: `Call: ${outcome || 'logged'}${req.body.subStatus ? ` / ${req.body.subStatus}` : ''}${req.body.notes ? ` — ${req.body.notes.slice(0, 160)}` : ''}`, payload: { callId: call._id, durationSec: call.durationSec, callStatus: req.body.callStatus ?? '' } });
  recomputeLeadPriority(req.user!.orgId, lead._id).catch(() => undefined);
  created(res, (await withUsers([call.toObject()]))[0]);
}));

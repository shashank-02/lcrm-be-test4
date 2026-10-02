import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok } from '../../common/http';
import { forbidden, notFound } from '../../common/errors';
import { validate } from '../../middleware/validate';
import { requirePermission, hasPermission } from '../../middleware/auth';
import { idParam, normalise } from '../../common/crud';
import { Notification, TopUpReminder, Lead, User, TOPUP_OUTCOMES } from '../../models';
import { buildMeta } from '../../common/pagination';
import { logActivity } from '../../services/activity.service';
import { leadScope } from '../../services/scope.service';
import { dayjs } from '../../common/dates';

export const notificationsRouter = Router();
const FILTERS = ['all', 'unread', 'followups', 'assignments', 'admin', 'reminders'] as const;

const listQuery = z.object({ filter: z.enum(FILTERS).default('all'), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(30), priority: z.enum(['high', 'medium', 'normal']).optional() });

notificationsRouter.get('/', requirePermission('notification.view'), validate({ query: listQuery }), asyncHandler(async (req, res) => {
  const q = req.query as unknown as z.infer<typeof listQuery>;
  const f: Record<string, unknown> = { userId: req.user!.id, status: { $nin: ['completed', 'dismissed', 'snoozed'] } };
  if (q.filter === 'unread') f.status = 'pending';
  else if (q.filter !== 'all') f.category = q.filter;
  if (q.priority) f.priority = q.priority;
  const [items, total, unread] = await Promise.all([
    Notification.find(f).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Notification.countDocuments(f),
    Notification.countDocuments({ userId: req.user!.id, status: 'pending' }),
  ]);
  ok(res, { items: items.map(normalise), unread }, buildMeta({ page: q.page, limit: q.limit, sortDir: 'desc' }, total));
}));

/** Tiny endpoint polled by the bell icon. */
notificationsRouter.get('/unread-count', requirePermission('notification.view'), asyncHandler(async (req, res) => {
  const [unread, highPending] = await Promise.all([
    Notification.countDocuments({ userId: req.user!.id, status: 'pending' }),
    Notification.find({ userId: req.user!.id, status: 'pending', priority: 'high' }).sort({ createdAt: -1 }).limit(5).lean(),
  ]);
  ok(res, { unread, popups: highPending.map(normalise) });
}));

notificationsRouter.post('/read-all', requirePermission('notification.view'), asyncHandler(async (req, res) => {
  const r = await Notification.updateMany({ userId: req.user!.id, status: 'pending' }, { $set: { status: 'read', readAt: new Date() } });
  ok(res, { updated: r.modifiedCount });
}));

async function own(req: import('express').Request) {
  const n = await Notification.findOne({ _id: req.params.id, userId: req.user!.id });
  if (!n) throw notFound('Notification');
  return n;
}
notificationsRouter.post('/:id/read', requirePermission('notification.view'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const n = await own(req); if (n.status === 'pending') { n.status = 'read'; n.readAt = new Date(); await n.save(); } ok(res, n.toJSON());
}));
notificationsRouter.post('/:id/complete', requirePermission('notification.view'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const n = await own(req); n.status = 'completed'; n.actionedAt = new Date(); await n.save(); ok(res, n.toJSON());
}));
notificationsRouter.post('/:id/dismiss', requirePermission('notification.view'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const n = await own(req); n.status = 'dismissed'; n.actionedAt = new Date(); await n.save(); ok(res, n.toJSON());
}));
notificationsRouter.post('/:id/snooze', requirePermission('notification.view'), validate({ params: idParam, body: z.object({ minutes: z.number().int().min(5).max(7 * 24 * 60).default(60) }) }), asyncHandler(async (req, res) => {
  const n = await own(req); n.status = 'snoozed'; n.snoozedUntil = new Date(Date.now() + req.body.minutes * 60_000); await n.save(); ok(res, n.toJSON());
}));

// ---------- Top-up reminders ----------
export const topupRouter = Router();
const topupList = z.object({ status: z.enum(['scheduled', 'due', 'snoozed', 'completed', 'dismissed', 'open']).optional(), ownerId: z.string().optional(), from: z.string().optional(), to: z.string().optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) });

/** Admin/manager view of upcoming, due and completed top-up follow-ups within their lead scope. */
topupRouter.get('/', requirePermission('topup.view'), validate({ query: topupList }), asyncHandler(async (req, res) => {
  const q = req.query as unknown as z.infer<typeof topupList>;
  const leadIds = await Lead.find(leadScope(req.user!)).select('_id').limit(20000).lean();
  const f: Record<string, unknown> = { orgId: req.user!.orgId, leadId: { $in: leadIds.map((l) => l._id) } };
  if (q.status === 'open') f.status = { $in: ['scheduled', 'due', 'snoozed'] }; else if (q.status) f.status = q.status;
  if (q.ownerId) f.ownerId = q.ownerId;
  if (q.from || q.to) f.dueAt = { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? { $lte: dayjs(q.to).endOf('day').toDate() } : {}) };
  const [items, total] = await Promise.all([TopUpReminder.find(f).sort({ dueAt: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), TopUpReminder.countDocuments(f)]);
  const [leads, users] = await Promise.all([
    Lead.find({ _id: { $in: items.map((i) => i.leadId) } }).select('name phone').lean(),
    User.find({ _id: { $in: items.flatMap((i) => [i.ownerId, i.completedById]).filter(Boolean) } }).select('name avatarColor').lean(),
  ]);
  const lm = new Map(leads.map((l) => [String(l._id), normalise(l)])); const um = new Map(users.map((u) => [String(u._id), normalise(u)]));
  const summary = await TopUpReminder.aggregate<{ _id: string; n: number }>([{ $match: { orgId: leadIds.length ? items[0]?.orgId ?? req.user!.orgId : req.user!.orgId, leadId: { $in: leadIds.map((l) => l._id) } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  ok(res, { items: items.map((i) => ({ ...normalise(i), lead: lm.get(String(i.leadId)) ?? null, owner: i.ownerId ? um.get(String(i.ownerId)) ?? null : null, completedBy: i.completedById ? um.get(String(i.completedById)) ?? null : null })), summary: Object.fromEntries(summary.map((s) => [s._id, s.n])) }, buildMeta({ page: q.page, limit: q.limit, sortDir: 'asc' }, total));
}));

async function reminderInScope(req: import('express').Request) {
  const r = await TopUpReminder.findOne({ _id: req.params.id, orgId: req.user!.orgId });
  if (!r) throw notFound('Reminder');
  const lead = await Lead.findOne({ _id: r.leadId, ...leadScope(req.user!) }).select('_id name phone ownerId').lean();
  if (!lead) throw forbidden('This lead is outside your visibility');
  return { r, lead };
}

topupRouter.post('/:id/complete', requirePermission('topup.action'), validate({ params: idParam, body: z.object({ outcome: z.enum(TOPUP_OUTCOMES), notes: z.string().max(2000).optional() }) }), asyncHandler(async (req, res) => {
  const { r, lead } = await reminderInScope(req);
  r.status = 'completed'; r.outcome = req.body.outcome; r.outcomeNotes = req.body.notes ?? ''; r.completedAt = new Date(); r.completedById = req.user!.id as never;
  await r.save();
  await Notification.updateMany({ 'ref.kind': 'topup', 'ref.id': r._id, status: { $in: ['pending', 'read', 'snoozed'] } }, { $set: { status: 'completed', actionedAt: new Date() } });
  await logActivity({ orgId: req.user!.orgId, leadId: lead._id, userId: req.user!.id, type: 'topup_completed', description: `Top-up follow-up: ${req.body.outcome.replace(/_/g, ' ')}${req.body.notes ? ` — ${req.body.notes}` : ''}`, payload: { reminderId: r._id, outcome: req.body.outcome } });
  ok(res, r.toJSON());
}));
topupRouter.post('/:id/snooze', requirePermission('topup.action'), validate({ params: idParam, body: z.object({ days: z.number().int().min(1).max(90).default(7) }) }), asyncHandler(async (req, res) => {
  const { r, lead } = await reminderInScope(req);
  r.status = 'snoozed'; r.snoozedUntil = dayjs().add(req.body.days, 'day').toDate(); await r.save();
  await Notification.updateMany({ 'ref.kind': 'topup', 'ref.id': r._id, status: { $in: ['pending', 'read'] } }, { $set: { status: 'snoozed', snoozedUntil: r.snoozedUntil } });
  await logActivity({ orgId: req.user!.orgId, leadId: lead._id, userId: req.user!.id, type: 'topup_snoozed', description: `Top-up reminder snoozed until ${dayjs(r.snoozedUntil).format('DD-MMM-YYYY')}` });
  ok(res, r.toJSON());
}));
topupRouter.post('/:id/dismiss', requirePermission('topup.action'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const { r, lead } = await reminderInScope(req);
  r.status = 'dismissed'; r.completedAt = new Date(); r.completedById = req.user!.id as never; await r.save();
  await Notification.updateMany({ 'ref.kind': 'topup', 'ref.id': r._id, status: { $in: ['pending', 'read', 'snoozed'] } }, { $set: { status: 'dismissed', actionedAt: new Date() } });
  await logActivity({ orgId: req.user!.orgId, leadId: lead._id, userId: req.user!.id, type: 'topup_dismissed', description: 'Top-up reminder dismissed' });
  ok(res, r.toJSON());
}));
/** One-off: create reminders for leads that were already disbursed before this feature. Admin only. */
topupRouter.post('/backfill', requirePermission('admin.project'), asyncHandler(async (req, res) => {
  if (!hasPermission(req.user!, 'admin.project')) throw forbidden();
  const { backfillTopUpReminders } = await import('../../services/topup.service');
  ok(res, { created: await backfillTopUpReminders(req.user!.orgId) });
}));

import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { asyncHandler, ok, created } from '../../common/http';
import { badRequest, forbidden, notFound } from '../../common/errors';
import { validate } from '../../middleware/validate';
import { hasPermission, requirePermission } from '../../middleware/auth';
import { idParam, normalise } from '../../common/crud';
import { buildMeta, buildSort } from '../../common/pagination';
import { Activity, Lead, LEAD_SORTABLE, MessageTemplate, Note, Task, LeadFile, CallLog, Stage, Status, Source, User } from '../../models';
import { leadScope, ownershipFor } from '../../services/scope.service';
import { logActivity, logActivities } from '../../services/activity.service';
import { applyAssignmentRules } from '../../services/assignment.service';
import { notify } from '../../services/notification.service';
import { mailtoLink, renderTemplate, telLink, whatsappLink } from '../../services/template.service';
import {
  assertCanEditLead, assertPhoneAvailable, assignLead, buildListFilter, changeStage, changeStatus, computeQualityScore, decorateLeads,
  getLeadInScope, listQuerySchema, markContacted, objectId, validateCustomFields, type ListQuery,
} from './lead.service';
import { TopUpReminder } from '../../models';
import { fireFbEvents } from '../../services/fb.service';
import { ensureTopUpReminder } from '../../services/topup.service';
import { recomputeLeadPriority } from '../../services/prioritization.service';
import { notifyOwnerOfAdminAction } from '../../services/scheduler.service';

export const leadsRouter = Router();

const dateish = z.union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}/)]).transform((s) => new Date(s));
const nullableDate = z.union([dateish, z.null()]);

const leadBody = z.object({
  name: z.string().max(120).optional(),
  phone: z.string().regex(/^\+?[0-9\s-]{8,16}$/, 'Phone must be 8-15 digits'),
  altPhone: z.string().max(20).optional(),
  email: z.string().email().or(z.literal('')).optional(),
  city: z.string().max(80).optional(),
  state: z.string().max(80).optional(),
  country: z.string().max(80).optional(),
  language: z.string().max(40).optional(),
  stageId: objectId.nullable().optional(),
  statusId: objectId.nullable().optional(),
  sourceId: objectId.nullable().optional(),
  ownerId: objectId.nullable().optional(),
  remarks: z.string().max(2000).optional(),
  nextFollowUpAt: nullableDate.optional(),
  createdAt: dateish.optional(),
  customFields: z.record(z.unknown()).optional(),
  tags: z.array(z.string().max(30)).optional(),
  color: z.string().max(20).optional(),
  priority: z.number().int().min(0).max(5).optional(),
});

const normalisePhone = (p: string) => p.replace(/[\s-]/g, '');

// ---------- list / export ----------
leadsRouter.get(
  '/',
  requirePermission('lead.view'),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ListQuery;
    const filter = buildListFilter(req.user!, q);
    const sort = buildSort({ page: q.page, limit: q.limit, sortBy: q.sortBy, sortDir: q.sortDir }, LEAD_SORTABLE);
    const [rows, total] = await Promise.all([
      Lead.find(filter).sort(sort).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
      Lead.countDocuments(filter),
    ]);
    ok(res, await decorateLeads(req.user!.orgId, rows as never), buildMeta({ page: q.page, limit: q.limit, sortDir: q.sortDir }, total));
  }),
);

/** Tab counts shown on the list header, computed with the same scope/filters (minus the tab). */
leadsRouter.get(
  '/counts',
  requirePermission('lead.view'),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ListQuery;
    const tabs = ['all', 'contacted_today', 'assigned_today', 'created_today', 'followup_today', 'overdue', 'unassigned', 'today_list'] as const;
    const entries = await Promise.all(tabs.map(async (tab) => [tab, await Lead.countDocuments(buildListFilter(req.user!, { ...q, tab }))] as const));
    ok(res, Object.fromEntries(entries));
  }),
);

leadsRouter.get(
  '/export',
  requirePermission('lead.export'),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ListQuery;
    const rows = await Lead.find(buildListFilter(req.user!, q)).sort({ createdAt: -1 }).limit(20000).lean();
    const leads = await decorateLeads(req.user!.orgId, rows as never);
    const customKeys = Array.from(new Set(leads.flatMap((l) => Object.keys((l.customFields as Record<string, unknown>) ?? {}))));
    const headers = ['Name', 'Phone', 'Email', 'City', 'Stage', 'Status', 'Source', 'Owner', 'Team', 'Remarks', 'Next Follow-up', 'Last Contacted', 'Created At', ...customKeys];
    const esc = (v: unknown) => { const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [headers.join(',')];
    for (const l of leads) {
      lines.push([l.name, l.phone, l.email, l.city, l.stage?.name, l.status?.name, l.source?.name, l.owner?.name, l.team?.name, l.remarks, l.nextFollowUpAt, l.lastContactedAt, l.createdAt, ...customKeys.map((k) => (l.customFields as Record<string, unknown>)?.[k])].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\n'));
  }),
);

leadsRouter.get(
  '/check-phone',
  requirePermission('lead.view'),
  validate({ query: z.object({ phone: z.string().min(6) }) }),
  asyncHandler(async (req, res) => {
    const dup = await Lead.findOne({ orgId: req.user!.orgId, phone: normalisePhone(String(req.query.phone)), isDeleted: false }).select('_id name ownerId stageId').lean();
    ok(res, dup ? { exists: true, lead: normalise(dup) } : { exists: false });
  }),
);

// ---------- create ----------
leadsRouter.post(
  '/',
  requirePermission('lead.create'),
  validate({ body: leadBody }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof leadBody>;
    const phone = normalisePhone(body.phone);
    await assertPhoneAvailable(req.user!.orgId, phone);
    const customFields = await validateCustomFields(req.user!.orgId, body.customFields, { partial: false });
    let ownerId: string | null = body.ownerId ?? null;
    if (ownerId && ownerId !== req.user!.id && !hasPermission(req.user!, 'lead.assign')) throw forbidden('You cannot assign leads to others');
    if (!ownerId && req.user!.role === 'agent') ownerId = req.user!.id; // agents own what they create
    const own = await ownershipFor(req.user!.orgId, ownerId);
    const stage = body.stageId ? await Stage.findOne({ _id: body.stageId, orgId: req.user!.orgId }).lean() : await Stage.findOne({ orgId: req.user!.orgId, isActive: true }).sort({ order: 1 }).lean();
    const lead = await Lead.create({
      ...body, phone, customFields, orgId: req.user!.orgId, createdById: req.user!.id,
      stageId: stage?._id ?? null, ...own, assignedAt: own.ownerId ? new Date() : null,
      ...(body.createdAt ? { createdAt: body.createdAt } : {}),
    });
    await logActivity({ orgId: req.user!.orgId, leadId: lead._id, userId: req.user!.id, type: 'created', description: 'Lead created' });
    if (own.ownerId) {
      await logActivity({ orgId: req.user!.orgId, leadId: lead._id, userId: req.user!.id, type: 'assigned', description: 'Assigned on creation', payload: { ownerId } });
      // The new owner learns about leads created on their behalf (notify() ignores self-assignment).
      await notify({ orgId: req.user!.orgId, userId: String(own.ownerId), leadId: lead._id, leadName: lead.name || lead.phone, actorId: req.user!.id, type: 'lead_assigned', title: 'New lead assigned', body: `${lead.name || lead.phone} was created and assigned to you by ${req.user!.name}.` });
    } else await applyAssignmentRules(req.user!.orgId, [lead._id]);
    if (stage?.isWon) await ensureTopUpReminder(req.user!.orgId, lead._id);
    fireFbEvents(req.user!.orgId, 'lead_created', lead._id, { stageId: stage?._id }).catch(() => undefined);
    recomputeLeadPriority(req.user!.orgId, lead._id).catch(() => undefined);
    const fresh = await Lead.findById(lead._id).lean();
    created(res, (await decorateLeads(req.user!.orgId, [fresh as never]))[0]);
  }),
);

// ---------- bulk ----------
const bulkSchema = z.object({
  ids: z.array(objectId).min(1).max(1000),
  action: z.enum(['assign', 'stage', 'status', 'source', 'delete', 'followup', 'today_list', 'field', 'color', 'restore']),
  payload: z.record(z.unknown()).default({}),
});
leadsRouter.post(
  '/bulk',
  validate({ body: bulkSchema }),
  asyncHandler(async (req, res) => {
    const { ids, action, payload } = req.body as z.infer<typeof bulkSchema>;
    const user = req.user!;
    const scope = leadScope(user);
    if (action === 'restore') { if (user.role !== 'admin') throw forbidden(); delete (scope as Record<string, unknown>).isDeleted; }
    const leads = await Lead.find({ _id: { $in: ids }, ...scope });
    if (!leads.length) throw notFound('Leads');
    let affected = 0; const errors: { id: string; message: string }[] = [];
    const need = (p: string) => { if (!hasPermission(user, p)) throw forbidden(`Missing permission: ${p}`); };

    if (action === 'assign') {
      for (const l of leads) { try { await assignLead(user, l, (payload.ownerId as string) ?? null, { comment: payload.comment as string, eraseHistory: !!payload.eraseHistory, bulk: true }); affected++; } catch (e) { errors.push({ id: String(l._id), message: (e as Error).message }); } }
    } else if (action === 'stage') {
      need('lead.bulk_update');
      for (const l of leads) { try { await changeStage(user, l, String(payload.stageId), { remarks: payload.remarks as string | undefined }); affected++; } catch (e) { errors.push({ id: String(l._id), message: (e as Error).message }); } }
    } else if (action === 'status') {
      need('lead.bulk_update');
      for (const l of leads) { try { await changeStatus(user, l, (payload.statusId as string) ?? null, { remarks: payload.remarks as string | undefined }); affected++; } catch (e) { errors.push({ id: String(l._id), message: (e as Error).message }); } }
    } else if (action === 'source') {
      need('lead.bulk_update'); need('lead.update_source');
      const src = payload.sourceId ? await Source.findOne({ _id: payload.sourceId, orgId: user.orgId }).lean() : null;
      if (payload.sourceId && !src) throw badRequest('Source not found');
      const r = await Lead.updateMany({ _id: { $in: leads.map((l) => l._id) } }, { $set: { sourceId: src?._id ?? null } });
      affected = r.modifiedCount;
      await logActivities(leads.map((l) => ({ orgId: user.orgId, leadId: l._id, userId: user.id, type: 'source_changed' as const, description: `Source → ${src?.name ?? '—'} (bulk)` })));
    } else if (action === 'followup') {
      need(payload.nextFollowUpAt ? 'lead.bulk_update' : 'lead.reset_followup');
      const dt = payload.nextFollowUpAt ? new Date(String(payload.nextFollowUpAt)) : null;
      if (dt && Number.isNaN(dt.getTime())) throw badRequest('Invalid date');
      const r = await Lead.updateMany({ _id: { $in: leads.map((l) => l._id) } }, { $set: { nextFollowUpAt: dt } });
      affected = r.modifiedCount;
      await logActivities(leads.map((l) => ({ orgId: user.orgId, leadId: l._id, userId: user.id, type: dt ? 'followup_set' as const : 'followup_reset' as const, description: dt ? `Follow-up set to ${dt.toISOString()} (bulk)` : 'Follow-up reset (bulk)' })));
    } else if (action === 'today_list') {
      const r = await Lead.updateMany({ _id: { $in: leads.map((l) => l._id) } }, { $set: { inTodayList: !!payload.add } });
      affected = r.modifiedCount;
    } else if (action === 'color') {
      const r = await Lead.updateMany({ _id: { $in: leads.map((l) => l._id) } }, { $set: { color: String(payload.color ?? '') } });
      affected = r.modifiedCount;
    } else if (action === 'field') {
      need('lead.bulk_update');
      const key = String(payload.key ?? ''); if (!key) throw badRequest('Field key required');
      const set: Record<string, unknown> = {};
      if (key.startsWith('custom.')) { const v = await validateCustomFields(user.orgId, { [key.slice(7)]: payload.value }, { partial: true }); set[`customFields.${key.slice(7)}`] = v[key.slice(7)]; }
      else if (['city', 'state', 'country', 'language', 'remarks', 'priority'].includes(key)) set[key] = payload.value;
      else throw badRequest('Field cannot be bulk-updated');
      const r = await Lead.updateMany({ _id: { $in: leads.map((l) => l._id) } }, { $set: set });
      affected = r.modifiedCount;
      await logActivities(leads.map((l) => ({ orgId: user.orgId, leadId: l._id, userId: user.id, type: 'bulk_updated' as const, description: `${key} updated (bulk)`, payload: set })));
    } else if (action === 'delete') {
      need('lead.bulk_delete');
      const r = await Lead.updateMany({ _id: { $in: leads.map((l) => l._id) } }, { $set: { isDeleted: true, deletedAt: new Date(), deletedById: user.id } });
      affected = r.modifiedCount;
      await logActivities(leads.map((l) => ({ orgId: user.orgId, leadId: l._id, userId: user.id, type: 'deleted' as const, description: 'Deleted (bulk)' })));
    } else if (action === 'restore') {
      const r = await Lead.updateMany({ _id: { $in: leads.map((l) => l._id) } }, { $set: { isDeleted: false, deletedAt: null, deletedById: null } });
      affected = r.modifiedCount;
      await logActivities(leads.map((l) => ({ orgId: user.orgId, leadId: l._id, userId: user.id, type: 'restored' as const, description: 'Restored' })));
    }
    ok(res, { requested: ids.length, matched: leads.length, affected, errors });
  }),
);

// ---------- single lead ----------
leadsRouter.get(
  '/:id',
  requirePermission('lead.view'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const lead = await Lead.findOne({ _id: req.params.id, ...leadScope(req.user!) }).lean();
    if (!lead) throw notFound('Lead');
    const [decorated, notes, files, tasks, calls, creator] = await Promise.all([
      decorateLeads(req.user!.orgId, [lead as never]),
      Note.countDocuments({ leadId: lead._id, hidden: false }),
      LeadFile.countDocuments({ leadId: lead._id }),
      Task.countDocuments({ leadId: lead._id, status: 'open' }),
      CallLog.countDocuments({ leadId: lead._id, hidden: false }),
      lead.createdById ? User.findById(lead.createdById).select('name').lean() : null,
    ]);
    const stages = await Stage.find({ orgId: req.user!.orgId, isActive: true }).sort({ order: 1 }).select('_id').lean();
    const stageOrder = stages.findIndex((s) => String(s._id) === String(lead.stageId));
    const qualityScore = computeQualityScore({ ...lead, stageOrder: stageOrder < 0 ? 0 : stageOrder, stageCount: stages.length } as never);
    const topUp = await TopUpReminder.findOne({ leadId: lead._id }).sort({ createdAt: -1 }).lean();
    const canEdit = req.user!.role === 'admin' || (lead.ownerId && String(lead.ownerId) === req.user!.id) || req.user!.permissions.has('lead.edit_subordinates');
    ok(res, { ...decorated[0], qualityScore, creator: creator ? normalise(creator) : null, counts: { notes, files, tasks, calls }, topUp: topUp ? normalise(topUp) : null, canEdit });
  }),
);

leadsRouter.patch(
  '/:id',
  requirePermission('lead.edit'),
  validate({ params: idParam, body: leadBody.partial() }),
  asyncHandler(async (req, res) => {
    const lead = await getLeadInScope(req.user!, req.params.id);
    assertCanEditLead(req.user!, lead);
    const body = req.body as Partial<z.infer<typeof leadBody>>;
    const { stageId, statusId, ownerId, customFields, createdAt, ...rest } = body;
    if (stageId !== undefined || statusId !== undefined || ownerId !== undefined) throw badRequest('Use the dedicated stage / status / assign endpoints');
    if (rest.phone) { rest.phone = normalisePhone(rest.phone); await assertPhoneAvailable(req.user!.orgId, rest.phone, lead._id); }
    if (rest.sourceId !== undefined && !hasPermission(req.user!, 'lead.update_source')) throw forbidden('You cannot change the source');
    const changed: string[] = Object.keys(rest);
    if (customFields) { lead.customFields = { ...(lead.customFields as object), ...(await validateCustomFields(req.user!.orgId, customFields, { partial: true })) }; changed.push(...Object.keys(customFields).map((k) => `custom.${k}`)); }
    if (createdAt && req.user!.role === 'admin') lead.set({ createdAt });
    lead.set(rest);
    if (rest.nextFollowUpAt !== undefined) await logActivity({ orgId: req.user!.orgId, leadId: lead._id, userId: req.user!.id, type: rest.nextFollowUpAt ? 'followup_set' : 'followup_reset', description: rest.nextFollowUpAt ? `Follow-up set to ${rest.nextFollowUpAt.toISOString()}` : 'Follow-up reset' });
    await lead.save();
    if (changed.length) { await logActivity({ orgId: req.user!.orgId, leadId: lead._id, userId: req.user!.id, type: 'updated', description: `Updated ${changed.join(', ')}`, payload: { fields: changed } }); await notifyOwnerOfAdminAction(req.user!, lead, 'admin_update', `updated ${changed.slice(0, 4).join(', ')}`); }
    if (customFields && 'disbursedDate' in customFields && (lead.customFields as Record<string, unknown>).disbursedDate) await ensureTopUpReminder(req.user!.orgId, lead._id, { disbursedAt: new Date(String((lead.customFields as Record<string, unknown>).disbursedDate)) });
    recomputeLeadPriority(req.user!.orgId, lead._id).catch(() => undefined);
    ok(res, (await decorateLeads(req.user!.orgId, [lead.toObject() as never]))[0]);
  }),
);

leadsRouter.post(
  '/:id/stage',
  validate({ params: idParam, body: z.object({ stageId: objectId, statusId: objectId.nullable().optional(), remarks: z.string().max(2000).optional(), nextFollowUpAt: nullableDate.optional(), customFields: z.record(z.unknown()).optional() }) }),
  asyncHandler(async (req, res) => {
    const lead = await getLeadInScope(req.user!, req.params.id);
    await changeStage(req.user!, lead, req.body.stageId, req.body);
    ok(res, (await decorateLeads(req.user!.orgId, [lead.toObject() as never]))[0]);
  }),
);

leadsRouter.post(
  '/:id/status',
  validate({ params: idParam, body: z.object({ statusId: objectId.nullable(), remarks: z.string().max(2000).optional(), nextFollowUpAt: nullableDate.optional() }) }),
  asyncHandler(async (req, res) => {
    const lead = await getLeadInScope(req.user!, req.params.id);
    await changeStatus(req.user!, lead, req.body.statusId, req.body);
    ok(res, (await decorateLeads(req.user!.orgId, [lead.toObject() as never]))[0]);
  }),
);

leadsRouter.post(
  '/:id/assign',
  validate({ params: idParam, body: z.object({ ownerId: objectId.nullable(), comment: z.string().max(500).optional(), eraseHistory: z.boolean().optional(), addToTodayList: z.boolean().optional() }) }),
  asyncHandler(async (req, res) => {
    const lead = await getLeadInScope(req.user!, req.params.id);
    await assignLead(req.user!, lead, req.body.ownerId, req.body);
    ok(res, (await decorateLeads(req.user!.orgId, [lead.toObject() as never]))[0]);
  }),
);

leadsRouter.post(
  '/:id/followup',
  validate({ params: idParam, body: z.object({ nextFollowUpAt: nullableDate, remarks: z.string().max(2000).optional() }) }),
  asyncHandler(async (req, res) => {
    const lead = await getLeadInScope(req.user!, req.params.id);
    if (!req.body.nextFollowUpAt && !hasPermission(req.user!, 'lead.reset_followup')) throw forbidden('You cannot reset follow-ups');
    lead.nextFollowUpAt = req.body.nextFollowUpAt;
    if (req.body.remarks !== undefined) lead.remarks = req.body.remarks;
    await lead.save();
    await logActivity({ orgId: req.user!.orgId, leadId: lead._id, userId: req.user!.id, type: req.body.nextFollowUpAt ? 'followup_set' : 'followup_reset', description: req.body.nextFollowUpAt ? `Follow-up set to ${req.body.nextFollowUpAt.toISOString()}` : 'Follow-up reset' });
    ok(res, (await decorateLeads(req.user!.orgId, [lead.toObject() as never]))[0]);
  }),
);

/** Deep-link communications: returns the link to open; logs the touch as an activity. */
leadsRouter.post(
  '/:id/communicate',
  requirePermission('lead.communicate'),
  validate({ params: idParam, body: z.object({ channel: z.enum(['whatsapp', 'email', 'call']), templateId: objectId.optional(), message: z.string().max(5000).optional(), subject: z.string().max(200).optional() }) }),
  asyncHandler(async (req, res) => {
    const lead = await getLeadInScope(req.user!, req.params.id);
    const [stage, status, source, owner] = await Promise.all([
      lead.stageId ? Stage.findById(lead.stageId).select('name').lean() : null,
      lead.statusId ? Status.findById(lead.statusId).select('name').lean() : null,
      lead.sourceId ? Source.findById(lead.sourceId).select('name').lean() : null,
      User.findById(req.user!.id).select('name phone email').lean(),
    ]);
    const ctx = { lead: lead.toObject() as never, owner, stage: stage?.name, status: status?.name, source: source?.name };
    let body = req.body.message ?? ''; let subject = req.body.subject ?? '';
    if (req.body.templateId) {
      const tpl = await MessageTemplate.findOne({ _id: req.body.templateId, orgId: req.user!.orgId, isActive: true }).lean();
      if (!tpl) throw badRequest('Template not found');
      body = renderTemplate(tpl.body, ctx); subject = renderTemplate(tpl.subject ?? '', ctx);
    }
    let link = '';
    if (req.body.channel === 'whatsapp') link = whatsappLink(lead.phone, body);
    else if (req.body.channel === 'email') { if (!lead.email) throw badRequest('Lead has no email address'); link = mailtoLink(lead.email, subject, body); }
    else link = telLink(lead.phone);
    markContacted(lead); await lead.save();
    const type = req.body.channel === 'whatsapp' ? 'whatsapp_sent' : req.body.channel === 'email' ? 'email_sent' : 'call_initiated';
    await logActivity({ orgId: req.user!.orgId, leadId: lead._id, userId: req.user!.id, type, description: req.body.channel === 'call' ? 'Call started' : `${req.body.channel === 'whatsapp' ? 'WhatsApp' : 'Email'} sent${req.body.templateId ? ' (template)' : ''}`, payload: { templateId: req.body.templateId ?? null, preview: body.slice(0, 200) } });
    ok(res, { link, body, subject });
  }),
);

leadsRouter.get(
  '/:id/activities',
  requirePermission('activity.view'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const lead = await getLeadInScope(req.user!, req.params.id);
    const filter: Record<string, unknown> = { leadId: lead._id };
    if (req.user!.role !== 'admin') filter.hidden = false;
    const items = await Activity.find(filter).sort({ createdAt: -1 }).limit(500).lean();
    const users = await User.find({ _id: { $in: items.map((a) => a.userId).filter(Boolean) } }).select('name avatarColor').lean();
    const um = new Map(users.map((u) => [String(u._id), normalise(u)]));
    ok(res, items.map((a) => ({ ...normalise(a), user: a.userId ? um.get(String(a.userId)) ?? null : null })));
  }),
);

leadsRouter.delete(
  '/:id',
  requirePermission('lead.delete'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const lead = await getLeadInScope(req.user!, req.params.id);
    lead.isDeleted = true; lead.deletedAt = new Date(); lead.deletedById = new Types.ObjectId(req.user!.id) as never;
    await lead.save();
    await logActivity({ orgId: req.user!.orgId, leadId: lead._id, userId: req.user!.id, type: 'deleted', description: 'Lead deleted' });
    ok(res, { deleted: true });
  }),
);

leadsRouter.post(
  '/:id/restore',
  requirePermission('lead.delete'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const lead = await Lead.findOne({ _id: req.params.id, orgId: req.user!.orgId, isDeleted: true });
    if (!lead) throw notFound('Deleted lead');
    await assertPhoneAvailable(req.user!.orgId, lead.phone, lead._id);
    lead.isDeleted = false; lead.deletedAt = null; lead.deletedById = null;
    await lead.save();
    await logActivity({ orgId: req.user!.orgId, leadId: lead._id, userId: req.user!.id, type: 'restored', description: 'Lead restored' });
    ok(res, { restored: true });
  }),
);

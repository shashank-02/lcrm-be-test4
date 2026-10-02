import { Types, type FilterQuery } from 'mongoose';
import { z } from 'zod';
import { AppError, badRequest, conflict, forbidden, notFound, validationError } from '../../common/errors';
import type { AuthUser } from '../../common/types';
import { todayRange, dayRange } from '../../common/dates';
import { escapeRegex } from '../../common/mongoose';
import { Activity, CallLog, FieldDefinition, Lead, Note, Source, Stage, StageDirective, Status, Team, User, type LeadDoc } from '../../models';
import { leadScope, canAssignTo, ownershipFor } from '../../services/scope.service';
import { logActivity } from '../../services/activity.service';
import { hasPermission } from '../../middleware/auth';
import { normalise } from '../../common/crud';
import { notify, retargetLeadNotifications } from '../../services/notification.service';
import { ensureTopUpReminder } from '../../services/topup.service';
import { fireFbEvents } from '../../services/fb.service';
import { recomputeLeadPriority } from '../../services/prioritization.service';
import { notifyOwnerOfAdminAction } from '../../services/scheduler.service';
import { TopUpReminder } from '../../models';

const oid = (s: string) => new Types.ObjectId(s);
export const objectId = z.string().refine((v) => Types.ObjectId.isValid(v), 'Invalid id');

export const LEAD_TABS = ['all', 'contacted_today', 'assigned_today', 'created_today', 'followup_today', 'overdue', 'unassigned', 'today_list'] as const;

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  sortBy: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  tab: z.enum(LEAD_TABS).default('all'),
  search: z.string().max(120).optional(),
  ownerId: z.string().optional(),
  teamId: z.string().optional(),
  stageId: z.string().optional(),
  statusId: z.string().optional(),
  sourceId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  ids: z.string().optional(),
  includeDeleted: z.enum(['true', 'false']).optional(),
}).passthrough();
export type ListQuery = z.infer<typeof listQuerySchema>;

const csvIds = (v?: string) => (v ? v.split(',').filter((x) => Types.ObjectId.isValid(x)).map(oid) : []);

/** Build the Mongo filter for a lead list from tab + filters, always inside the caller's scope. */
export function buildListFilter(user: AuthUser, q: ListQuery): FilterQuery<LeadDoc> {
  const scope = leadScope(user);
  if (q.includeDeleted === 'true' && user.role === 'admin') delete (scope as Record<string, unknown>).isDeleted;
  const and: FilterQuery<LeadDoc>[] = [scope];
  const { start, end } = todayRange(user.timezone);

  switch (q.tab) {
    case 'contacted_today': and.push({ lastContactedAt: { $gte: start, $lt: end } }); break;
    case 'assigned_today': and.push({ assignedAt: { $gte: start, $lt: end } }); break;
    case 'created_today': and.push({ createdAt: { $gte: start, $lt: end } }); break;
    case 'followup_today': and.push({ nextFollowUpAt: { $gte: start, $lt: end } }); break;
    case 'overdue': and.push({ nextFollowUpAt: { $lt: start } }); break;
    case 'unassigned': and.push({ ownerId: null }); break;
    case 'today_list': and.push({ inTodayList: true }); break;
    default: break;
  }
  const owners = csvIds(q.ownerId); if (owners.length) and.push({ ownerId: { $in: owners } });
  const teams = csvIds(q.teamId); if (teams.length) and.push({ teamId: { $in: teams } });
  const stages = csvIds(q.stageId); if (stages.length) and.push({ stageId: { $in: stages } });
  const statuses = csvIds(q.statusId); if (statuses.length) and.push({ statusId: { $in: statuses } });
  const sources = csvIds(q.sourceId); if (sources.length) and.push({ sourceId: { $in: sources } });
  const ids = csvIds(q.ids); if (ids.length) and.push({ _id: { $in: ids } });
  if (q.from || q.to) { const r = dayRange(user.timezone, q.from, q.to); and.push({ createdAt: { $gte: r.start, $lte: r.end } }); }
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search.trim()), 'i');
    and.push({ $or: [{ name: rx }, { phone: rx }, { email: rx }, { altPhone: rx }, { remarks: rx }] });
  }
  // custom.<key>=value equality filters
  for (const [k, v] of Object.entries(q)) {
    if (k.startsWith('custom.') && typeof v === 'string' && v !== '') and.push({ [`customFields.${k.slice(7)}`]: v } as FilterQuery<LeadDoc>);
  }
  return and.length === 1 ? and[0] : { $and: and };
}

type Ref = { id: string; name: string; color?: string; avatarColor?: string; isWon?: boolean; isLost?: boolean };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DecoratedLead = Record<string, any> & { id: string; stage: Ref | null; status: Ref | null; source: Ref | null; owner: Ref | null; team: Ref | null };

/** Populate names for owner/stage/status/source without heavy `populate` on every row. */
export async function decorateLeads(orgId: string, leads: Record<string, unknown>[]): Promise<DecoratedLead[]> {
  const [stages, statuses, users, teams] = await Promise.all([
    Stage.find({ orgId }).select('name color isWon isLost').lean(),
    Status.find({ orgId }).select('name color').lean(),
    User.find({ orgId }).select('name avatarColor').lean(),
    Team.find({ orgId }).select('name').lean(),
  ]);
  const sources = await Source.find({ orgId }).select('name').lean();
  const m = (arr: { _id: unknown }[]) => new Map(arr.map((x) => [String(x._id), x]));
  const sm = m(stages), stm = m(statuses), um = m(users), tm = m(teams), som = m(sources);
  return leads.map((l) => ({
    ...normalise(l as { _id: unknown }),
    stage: l.stageId ? sm.get(String(l.stageId)) && normalise(sm.get(String(l.stageId))!) : null,
    status: l.statusId ? stm.get(String(l.statusId)) && normalise(stm.get(String(l.statusId))!) : null,
    source: l.sourceId ? som.get(String(l.sourceId)) && normalise(som.get(String(l.sourceId))!) : null,
    owner: l.ownerId ? um.get(String(l.ownerId)) && normalise(um.get(String(l.ownerId))!) : null,
    team: l.teamId ? tm.get(String(l.teamId)) && normalise(tm.get(String(l.teamId))!) : null,
  })) as unknown as DecoratedLead[];
}

/** Validate/coerce custom field values against admin field definitions. */
export async function validateCustomFields(orgId: string, input: Record<string, unknown> | undefined, opts: { partial: boolean }) {
  const defs = await FieldDefinition.find({ orgId, isActive: true }).lean();
  const out: Record<string, unknown> = {};
  const issues: { path: string; message: string }[] = [];
  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const [k, raw] of Object.entries(input ?? {})) {
    const def = byKey.get(k);
    if (!def) { issues.push({ path: `customFields.${k}`, message: 'Unknown field' }); continue; }
    if (raw === '' || raw === null || raw === undefined) { out[k] = null; continue; }
    switch (def.type) {
      case 'number': case 'currency': case 'percent': {
        const n = Number(raw); if (Number.isNaN(n)) issues.push({ path: `customFields.${k}`, message: `${def.label} must be a number` }); else out[k] = n; break;
      }
      case 'boolean': out[k] = raw === true || raw === 'true' || raw === 1 || raw === '1'; break;
      case 'date': case 'datetime': {
        const d = new Date(String(raw)); if (Number.isNaN(d.getTime())) issues.push({ path: `customFields.${k}`, message: `${def.label} must be a valid date` }); else out[k] = d; break;
      }
      case 'select': if (!def.options.includes(String(raw))) issues.push({ path: `customFields.${k}`, message: `${def.label} must be one of: ${def.options.join(', ')}` }); else out[k] = String(raw); break;
      case 'multiselect': {
        const arr = Array.isArray(raw) ? raw.map(String) : String(raw).split(',').map((s) => s.trim());
        const bad = arr.filter((x) => !def.options.includes(x));
        if (bad.length) issues.push({ path: `customFields.${k}`, message: `${def.label}: invalid option(s) ${bad.join(', ')}` }); else out[k] = arr; break;
      }
      case 'email': if (!/^\S+@\S+\.\S+$/.test(String(raw))) issues.push({ path: `customFields.${k}`, message: `${def.label} must be an email` }); else out[k] = String(raw).toLowerCase(); break;
      default: out[k] = String(raw);
    }
  }
  const flagged = new Set(issues.map((i) => i.path));
  if (!opts.partial) for (const d of defs) if (d.required && !flagged.has(`customFields.${d.key}`) && (out[d.key] === undefined || out[d.key] === null)) issues.push({ path: `customFields.${d.key}`, message: `${d.label} is required` });
  if (issues.length) throw validationError(issues);
  return out;
}

export async function getLeadInScope(user: AuthUser, id: string) {
  const lead = await Lead.findOne({ _id: id, ...leadScope(user) });
  if (!lead) throw notFound('Lead');
  return lead;
}

export async function assertPhoneAvailable(orgId: string, phone: string, excludeId?: unknown) {
  const dup = await Lead.findOne({ orgId, phone, isDeleted: false, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).select('_id name ownerId').lean();
  if (dup) throw conflict('A lead with this phone number already exists', { leadId: String(dup._id), name: dup.name, ownerId: dup.ownerId ? String(dup.ownerId) : null });
}

/** Stage-directive enforcement: mandatory fields / remark / follow-up / roles when entering a stage. */
export async function enforceDirectives(user: AuthUser, lead: InstanceType<typeof Lead>, toStageId: string, patch: { remarks?: string; nextFollowUpAt?: Date | null; customFields?: Record<string, unknown> }) {
  const directives = await StageDirective.find({ orgId: user.orgId, toStageId, isActive: true, $or: [{ fromStageId: null }, { fromStageId: lead.stageId }] }).lean();
  const issues: string[] = [];
  const merged = { ...lead.toObject(), ...patch, customFields: { ...(lead.customFields as Record<string, unknown>), ...(patch.customFields ?? {}) } } as Record<string, unknown> & { customFields: Record<string, unknown> };
  for (const d of directives) {
    if (d.allowedRoles.length && !d.allowedRoles.includes(user.role) && user.role !== 'admin') issues.push(`Only ${d.allowedRoles.join('/')} can move leads to this stage (${d.name})`);
    if (d.requireRemark && !(patch.remarks && patch.remarks.trim())) issues.push(`A remark is required (${d.name})`);
    if (d.requireNextFollowUp && !merged.nextFollowUpAt) issues.push(`A next follow-up date is required (${d.name})`);
    for (const f of d.requiredFields) {
      const v = f.startsWith('custom.') ? merged.customFields[f.slice(7)] : merged[f];
      if (v === undefined || v === null || v === '') issues.push(`Field "${f.replace('custom.', '')}" is required (${d.name})`);
    }
  }
  if (issues.length) throw new AppError(422, 'STAGE_DIRECTIVE', issues[0], { issues });
}

export function markContacted(lead: { firstContactedAt?: Date | null; lastContactedAt?: Date | null; contactCount?: number }) {
  const now = new Date();
  if (!lead.firstContactedAt) lead.firstContactedAt = now;
  lead.lastContactedAt = now;
  lead.contactCount = (lead.contactCount ?? 0) + 1;
}

export async function assignLead(user: AuthUser, lead: InstanceType<typeof Lead>, ownerId: string | null, opts: { comment?: string; eraseHistory?: boolean; addToTodayList?: boolean; bulk?: boolean } = {}) {
  if (!hasPermission(user, opts.bulk ? 'lead.bulk_assign' : 'lead.assign')) throw forbidden('You cannot assign leads');
  if (ownerId && !(await canAssignTo(user, ownerId))) throw forbidden('You can only assign leads to members of your team(s)');
  if (opts.eraseHistory && !hasPermission(user, 'lead.erase_history')) throw forbidden('You cannot erase lead history');
  const prev = lead.ownerId ? String(lead.ownerId) : null;
  const o = await ownershipFor(user.orgId, ownerId);
  lead.ownerId = o.ownerId as never; lead.teamId = o.teamId as never; lead.managerId = o.managerId as never;
  lead.assignedAt = ownerId ? new Date() : null;
  if (opts.addToTodayList !== undefined) lead.inTodayList = opts.addToTodayList;
  await lead.save();
  if (opts.eraseHistory) {
    await Promise.all([
      Activity.updateMany({ leadId: lead._id }, { $set: { hidden: true } }),
      Note.updateMany({ leadId: lead._id }, { $set: { hidden: true } }),
      CallLog.updateMany({ leadId: lead._id }, { $set: { hidden: true } }),
    ]);
    await logActivity({ orgId: user.orgId, leadId: lead._id, userId: user.id, type: 'history_erased', description: 'History hidden from the new owner' });
  }
  const newOwner = ownerId ? await User.findById(ownerId).select('name').lean() : null;
  await logActivity({ orgId: user.orgId, leadId: lead._id, userId: user.id, type: ownerId ? 'assigned' : 'unassigned', description: ownerId ? `Assigned to ${newOwner?.name ?? 'user'}${opts.comment ? ` — ${opts.comment}` : ''}` : 'Owner removed', payload: { previousOwnerId: prev, ownerId, comment: opts.comment ?? '' } });
  if (ownerId) {
    await notify({ orgId: user.orgId, userId: ownerId, leadId: lead._id, leadName: lead.name || lead.phone, actorId: user.id, type: prev ? 'lead_reassigned' : 'lead_assigned', title: prev ? 'Lead reassigned to you' : 'New lead assigned', body: `${lead.name || lead.phone} was assigned to you by ${user.name}${opts.comment ? ` — ${opts.comment}` : ''}.` });
    await retargetLeadNotifications(lead._id, ownerId);
    await TopUpReminder.updateMany({ leadId: lead._id, status: { $in: ['scheduled', 'due', 'snoozed'] } }, { $set: { ownerId } });
  }
}

export async function changeStage(user: AuthUser, lead: InstanceType<typeof Lead>, stageId: string, patch: { remarks?: string; nextFollowUpAt?: Date | null; statusId?: string | null; customFields?: Record<string, unknown> }) {
  if (!hasPermission(user, 'lead.update_stage')) throw forbidden('You cannot update stage');
  const stage = await Stage.findOne({ _id: stageId, orgId: user.orgId, isActive: true }).lean();
  if (!stage) throw badRequest('Stage not found');
  if (String(lead.stageId) === stageId) throw badRequest('Lead is already in this stage');
  await enforceDirectives(user, lead, stageId, patch);
  const prevStage = lead.stageId ? await Stage.findById(lead.stageId).select('name').lean() : null;
  if (patch.customFields) lead.customFields = { ...(lead.customFields as object), ...(await validateCustomFields(user.orgId, patch.customFields, { partial: true })) };
  if (patch.remarks !== undefined) lead.remarks = patch.remarks;
  if (patch.nextFollowUpAt !== undefined) lead.nextFollowUpAt = patch.nextFollowUpAt;
  if (patch.statusId !== undefined) lead.statusId = (patch.statusId ? oid(patch.statusId) : null) as never;
  lead.stageId = oid(stageId) as never;
  markContacted(lead);
  await lead.save();
  await logActivity({ orgId: user.orgId, leadId: lead._id, userId: user.id, type: 'stage_changed', description: `Stage: ${prevStage?.name ?? '—'} → ${stage.name}${patch.remarks ? ` — ${patch.remarks}` : ''}`, payload: { from: prevStage ? String(prevStage._id) : null, to: stageId, remarks: patch.remarks ?? '' } });
  await notifyOwnerOfAdminAction(user, lead, 'admin_stage', `moved ${lead.name || lead.phone} to ${stage.name}`);
  // Disbursed / completed → start the post-disbursement top-up timer (idempotent per disbursement day).
  if (stage.isWon) { await ensureTopUpReminder(user.orgId, lead._id); fireFbEvents(user.orgId, 'lead_won', lead._id, { stageId }).catch(() => undefined); }
  fireFbEvents(user.orgId, 'stage_changed', lead._id, { stageId }).catch(() => undefined);
  recomputeLeadPriority(user.orgId, lead._id).catch(() => undefined);
}

export async function changeStatus(user: AuthUser, lead: InstanceType<typeof Lead>, statusId: string | null, patch: { remarks?: string; nextFollowUpAt?: Date | null }) {
  if (!hasPermission(user, 'lead.update_status')) throw forbidden('You cannot update status');
  let statusName = '—';
  if (statusId) {
    const st = await Status.findOne({ _id: statusId, orgId: user.orgId, isActive: true }).lean();
    if (!st) throw badRequest('Status not found');
    if (st.stageIds.length && lead.stageId && !st.stageIds.some((s) => String(s) === String(lead.stageId))) throw badRequest(`Status "${st.name}" is not available in the current stage`);
    statusName = st.name;
  }
  lead.statusId = (statusId ? oid(statusId) : null) as never;
  if (patch.remarks !== undefined) lead.remarks = patch.remarks;
  if (patch.nextFollowUpAt !== undefined) lead.nextFollowUpAt = patch.nextFollowUpAt;
  markContacted(lead);
  await lead.save();
  await logActivity({ orgId: user.orgId, leadId: lead._id, userId: user.id, type: 'status_changed', description: `Status → ${statusName}${patch.remarks ? ` — ${patch.remarks}` : ''}`, payload: { statusId, remarks: patch.remarks ?? '' } });
  await notifyOwnerOfAdminAction(user, lead, 'admin_status', `set ${lead.name || lead.phone} to ${statusName}`);
  fireFbEvents(user.orgId, 'status_changed', lead._id, { statusId }).catch(() => undefined);
  recomputeLeadPriority(user.orgId, lead._id).catch(() => undefined);
}

/** Subordinate-lead edit guard: editing a lead you do not own requires lead.edit_subordinates (admins exempt). */
export function assertCanEditLead(user: AuthUser, lead: { ownerId?: unknown }) {
  if (user.role === 'admin') return;
  if (lead.ownerId && String(lead.ownerId) === user.id) return;
  if (!hasPermission(user, 'lead.edit_subordinates')) throw forbidden('You can view this lead but cannot edit it');
}

/** Quality score = completeness (40) + engagement (30) + progress (30). Cheap, deterministic, recomputed on save. */
export function computeQualityScore(lead: { name?: string; email?: string; city?: string; sourceId?: unknown; customFields?: Record<string, unknown>; contactCount?: number; nextFollowUpAt?: Date | null; stageOrder?: number; stageCount?: number }) {
  let s = 0;
  if (lead.name) s += 10; if (lead.email) s += 10; if (lead.city) s += 5; if (lead.sourceId) s += 5;
  const filled = Object.values(lead.customFields ?? {}).filter((v) => v !== null && v !== undefined && v !== '').length;
  s += Math.min(10, filled * 2);
  s += Math.min(20, (lead.contactCount ?? 0) * 5); if (lead.nextFollowUpAt) s += 10;
  if (lead.stageCount && lead.stageCount > 1 && lead.stageOrder !== undefined) s += Math.round((lead.stageOrder / (lead.stageCount - 1)) * 30);
  return Math.max(0, Math.min(100, s));
}

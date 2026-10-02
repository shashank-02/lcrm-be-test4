import { Router } from 'express';
import { z } from 'zod';
import { Types, type FilterQuery } from 'mongoose';
import { asyncHandler, ok } from '../../common/http';
import { forbidden } from '../../common/errors';
import { validate } from '../../middleware/validate';
import { hasPermission, requirePermission } from '../../middleware/auth';
import { normalise } from '../../common/crud';
import { dayRange, todayRange, dayjs } from '../../common/dates';
import { Activity, CallLog, ImportJob, Lead, Session, Source, Stage, Status, Team, TopUpReminder, User, type LeadDoc } from '../../models';
import { leadScope, visibleTeamIds } from '../../services/scope.service';
import type { AuthUser } from '../../common/types';

export const reportsRouter = Router();
const oid = (s: string) => new Types.ObjectId(s);

const rangeQuery = z.object({
  from: z.string().optional(), to: z.string().optional(),
  teamId: z.string().optional(), userId: z.string().optional(),
});
type RangeQuery = z.infer<typeof rangeQuery>;

/** Scope + optional team/user narrowing. Agents are limited to themselves. */
function reportFilter(user: AuthUser, q: RangeQuery): FilterQuery<LeadDoc> {
  const f: Record<string, unknown> = { ...leadScope(user) };
  if (q.teamId && Types.ObjectId.isValid(q.teamId)) {
    const visible = visibleTeamIds(user);
    if (visible && !visible.includes(q.teamId)) throw forbidden('Team is outside your scope');
    f.teamId = oid(q.teamId);
  }
  if (q.userId && Types.ObjectId.isValid(q.userId)) f.ownerId = oid(q.userId);
  return f as FilterQuery<LeadDoc>;
}

const canView = (req: import('express').Request) => hasPermission(req.user!, 'report.view_org') || hasPermission(req.user!, 'report.view_team') || hasPermission(req.user!, 'report.view_own');

/** Dashboard summary: KPIs, funnel, follow-ups, by-source, by-status. */
reportsRouter.get('/dashboard', validate({ query: rangeQuery }), asyncHandler(async (req, res) => {
  if (!canView(req)) throw forbidden();
  const q = req.query as unknown as RangeQuery;
  const base = reportFilter(req.user!, q);
  const tz = req.user!.timezone;
  const today = todayRange(tz);
  const range = dayRange(tz, q.from, q.to);
  const inRange = { ...base, createdAt: { $gte: range.start, $lte: range.end } };
  const [stages, statuses, sources] = await Promise.all([
    Stage.find({ orgId: req.user!.orgId, isActive: true }).sort({ order: 1 }).lean(),
    Status.find({ orgId: req.user!.orgId }).lean(),
    Source.find({ orgId: req.user!.orgId }).lean(),
  ]);
  const wonIds = stages.filter((s) => s.isWon).map((s) => s._id);
  const lostIds = stages.filter((s) => s.isLost).map((s) => s._id);
  const [total, createdToday, contactedToday, assignedToday, followUpsToday, overdue, unassigned, won, lost, withFollowUp, byStage, byStatus, bySource, createdInRange, wonInRange, topUpsDue, onlineAgents, myFollowUps] = await Promise.all([
    Lead.countDocuments(base),
    Lead.countDocuments({ ...base, createdAt: { $gte: today.start, $lt: today.end } }),
    Lead.countDocuments({ ...base, lastContactedAt: { $gte: today.start, $lt: today.end } }),
    Lead.countDocuments({ ...base, assignedAt: { $gte: today.start, $lt: today.end } }),
    Lead.countDocuments({ ...base, nextFollowUpAt: { $gte: today.start, $lt: today.end } }),
    Lead.countDocuments({ ...base, nextFollowUpAt: { $lt: today.start } }),
    Lead.countDocuments({ ...base, ownerId: null }),
    Lead.countDocuments({ ...base, stageId: { $in: wonIds } }),
    Lead.countDocuments({ ...base, stageId: { $in: lostIds } }),
    Lead.countDocuments({ ...base, nextFollowUpAt: { $ne: null }, stageId: { $nin: [...wonIds, ...lostIds] } }),
    Lead.aggregate<{ _id: unknown; n: number }>([{ $match: base }, { $group: { _id: '$stageId', n: { $sum: 1 } } }]),
    Lead.aggregate<{ _id: unknown; n: number }>([{ $match: base }, { $group: { _id: '$statusId', n: { $sum: 1 } } }]),
    Lead.aggregate<{ _id: unknown; n: number }>([{ $match: inRange }, { $group: { _id: '$sourceId', n: { $sum: 1 } } }]),
    Lead.countDocuments(inRange),
    Lead.countDocuments({ ...inRange, stageId: { $in: wonIds } }),
    TopUpReminder.countDocuments({ orgId: req.user!.orgId, status: { $in: ['due', 'snoozed'] }, ...(hasPermission(req.user!, 'report.view_team') || hasPermission(req.user!, 'report.view_org') ? (visibleTeamIds(req.user!) ? { ownerId: { $in: await User.find({ orgId: req.user!.orgId, teamId: { $in: visibleTeamIds(req.user!) } }).distinct('_id') } } : {}) : { ownerId: req.user!.id }) }),
    (hasPermission(req.user!, 'report.view_team') || hasPermission(req.user!, 'report.view_org')) ? Session.find({ orgId: req.user!.orgId, endedAt: null, revokedAt: null, expiresAt: { $gt: new Date() }, lastSeenAt: { $gt: new Date(Date.now() - 30 * 60_000) }, ...(visibleTeamIds(req.user!) ? { teamId: { $in: visibleTeamIds(req.user!)!.map(oid) } } : {}) }).select('userId').lean().then((rows) => new Set(rows.map((r) => String(r.userId))).size) : Promise.resolve(0),
    Lead.find({ ...base, nextFollowUpAt: { $gte: today.start, $lt: today.end }, ...(req.user!.role === 'agent' ? {} : { ownerId: req.user!.id }) }).select('name phone nextFollowUpAt statusId stageId').sort({ nextFollowUpAt: 1 }).limit(8).lean(),
  ]);
  const map = (rows: { _id: unknown; n: number }[]) => new Map(rows.map((r) => [String(r._id), r.n]));
  const bs = map(byStage), bst = map(byStatus), bso = map(bySource);
  const openLeads = total - won - lost;
  ok(res, {
    kpis: {
      total, createdToday, contactedToday, assignedToday, followUpsToday, overdue, unassigned, won, lost, openLeads,
      conversionRate: total ? Math.round((won / total) * 1000) / 10 : 0,
      rangeConversionRate: createdInRange ? Math.round((wonInRange / createdInRange) * 1000) / 10 : 0,
      followUpCompliance: openLeads ? Math.round((withFollowUp / openLeads) * 1000) / 10 : 0,
      createdInRange, topUpsDue, onlineAgents,
    },
    myFollowUps: myFollowUps.map((l) => ({ id: String(l._id), name: l.name, phone: l.phone, nextFollowUpAt: l.nextFollowUpAt, status: statuses.find((x) => String(x._id) === String(l.statusId))?.name ?? '', stage: stages.find((x) => String(x._id) === String(l.stageId))?.name ?? '' })),
    funnel: stages.map((s) => ({ ...normalise(s), count: bs.get(String(s._id)) ?? 0 })),
    byStatus: [...statuses.map((s) => ({ ...normalise(s), count: bst.get(String(s._id)) ?? 0 })), { id: 'none', name: 'Not set', color: '#9CA3AF', count: bst.get('null') ?? 0 }].filter((x) => x.count > 0),
    bySource: [...sources.map((s) => ({ ...normalise(s), count: bso.get(String(s._id)) ?? 0 })), { id: 'none', name: 'Unknown', count: bso.get('null') ?? 0 }].filter((x) => x.count > 0),
    range: { from: range.start, to: range.end },
  });
}));

/** Leads created / contacted per day within the range. */
reportsRouter.get('/trend', validate({ query: rangeQuery }), asyncHandler(async (req, res) => {
  if (!canView(req)) throw forbidden();
  const q = req.query as unknown as RangeQuery;
  const base = reportFilter(req.user!, q);
  const tz = req.user!.timezone;
  const range = dayRange(tz, q.from, q.to);
  const group = (field: string) => Lead.aggregate<{ _id: string; n: number }>([
    { $match: { ...base, [field]: { $gte: range.start, $lte: range.end } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: `$${field}`, timezone: tz } }, n: { $sum: 1 } } },
  ]);
  const [createdRows, contactedRows, callRows] = await Promise.all([
    group('createdAt'), group('lastContactedAt'),
    CallLog.aggregate<{ _id: string; n: number }>([
      { $match: { orgId: oid(req.user!.orgId), createdAt: { $gte: range.start, $lte: range.end }, ...(q.userId ? { createdById: oid(q.userId) } : {}) } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } }, n: { $sum: 1 } } },
    ]),
  ]);
  const m = (rows: { _id: string; n: number }[]) => new Map(rows.map((r) => [r._id, r.n]));
  const cm = m(createdRows), tm = m(contactedRows), km = m(callRows);
  const days: { date: string; created: number; contacted: number; calls: number }[] = [];
  for (let d = dayjs(range.start).tz(tz); d.isBefore(dayjs(range.end)); d = d.add(1, 'day')) {
    const key = d.format('YYYY-MM-DD');
    days.push({ date: key, created: cm.get(key) ?? 0, contacted: tm.get(key) ?? 0, calls: km.get(key) ?? 0 });
  }
  ok(res, days);
}));

/** Per-owner performance table (team leads see their team, managers their teams, admins everyone). */
reportsRouter.get('/performance', requirePermission('report.view_team', 'report.view_org'), validate({ query: rangeQuery }), asyncHandler(async (req, res) => {
  const q = req.query as unknown as RangeQuery;
  const base = reportFilter(req.user!, q);
  const tz = req.user!.timezone;
  const range = dayRange(tz, q.from, q.to);
  const today = todayRange(tz);
  const stages = await Stage.find({ orgId: req.user!.orgId }).lean();
  const wonIds = stages.filter((s) => s.isWon).map((s) => s._id);
  const rows = await Lead.aggregate<{ _id: unknown; total: number; open: number; won: number; contactedToday: number; withFollowUp: number; overdue: number; createdInRange: number; contactedInRange: number }>([
    { $match: { ...base, ownerId: { $ne: null } } },
    { $group: {
      _id: '$ownerId', total: { $sum: 1 },
      won: { $sum: { $cond: [{ $in: ['$stageId', wonIds] }, 1, 0] } },
      open: { $sum: { $cond: [{ $in: ['$stageId', stages.filter((s) => s.isWon || s.isLost).map((s) => s._id)] }, 0, 1] } },
      contactedToday: { $sum: { $cond: [{ $and: [{ $gte: ['$lastContactedAt', today.start] }, { $lt: ['$lastContactedAt', today.end] }] }, 1, 0] } },
      withFollowUp: { $sum: { $cond: [{ $ne: ['$nextFollowUpAt', null] }, 1, 0] } },
      overdue: { $sum: { $cond: [{ $and: [{ $ne: ['$nextFollowUpAt', null] }, { $lt: ['$nextFollowUpAt', today.start] }] }, 1, 0] } },
      createdInRange: { $sum: { $cond: [{ $and: [{ $gte: ['$createdAt', range.start] }, { $lte: ['$createdAt', range.end] }] }, 1, 0] } },
      contactedInRange: { $sum: { $cond: [{ $and: [{ $gte: ['$lastContactedAt', range.start] }, { $lte: ['$lastContactedAt', range.end] }] }, 1, 0] } },
    } },
    { $sort: { total: -1 } },
  ]);
  const calls = await CallLog.aggregate<{ _id: unknown; n: number; dur: number }>([
    { $match: { orgId: oid(req.user!.orgId), createdAt: { $gte: range.start, $lte: range.end } } },
    { $group: { _id: '$createdById', n: { $sum: 1 }, dur: { $sum: '$durationSec' } } },
  ]);
  const callMap = new Map(calls.map((c) => [String(c._id), c]));
  const users = await User.find({ _id: { $in: rows.map((r) => r._id) } }).select('name role teamId avatarColor isActive').lean();
  const teams = await Team.find({ orgId: req.user!.orgId }).select('name').lean();
  const tm = new Map(teams.map((t) => [String(t._id), t.name]));
  const um = new Map(users.map((u) => [String(u._id), u]));
  ok(res, rows.map((r) => {
    const u = um.get(String(r._id)); const c = callMap.get(String(r._id));
    return { userId: String(r._id), name: u?.name ?? 'Unknown', role: u?.role, teamName: u?.teamId ? tm.get(String(u.teamId)) ?? '' : '', avatarColor: u?.avatarColor, isActive: u?.isActive ?? false,
      ...r, callsInRange: c?.n ?? 0, talkTimeSec: c?.dur ?? 0,
      conversionRate: r.total ? Math.round((r.won / r.total) * 1000) / 10 : 0,
      followUpCompliance: r.open ? Math.round((r.withFollowUp / r.open) * 1000) / 10 : 0 };
  }));
}));

/** Team comparison for managers / admins. */
reportsRouter.get('/teams', requirePermission('report.view_team', 'report.view_org'), validate({ query: rangeQuery }), asyncHandler(async (req, res) => {
  const q = req.query as unknown as RangeQuery;
  const base = reportFilter(req.user!, q);
  const stages = await Stage.find({ orgId: req.user!.orgId }).lean();
  const wonIds = stages.filter((s) => s.isWon).map((s) => s._id);
  const today = todayRange(req.user!.timezone);
  const rows = await Lead.aggregate<{ _id: unknown; total: number; won: number; contactedToday: number; unassigned: number }>([
    { $match: base },
    { $group: { _id: '$teamId', total: { $sum: 1 }, won: { $sum: { $cond: [{ $in: ['$stageId', wonIds] }, 1, 0] } }, contactedToday: { $sum: { $cond: [{ $and: [{ $gte: ['$lastContactedAt', today.start] }, { $lt: ['$lastContactedAt', today.end] }] }, 1, 0] } }, unassigned: { $sum: { $cond: [{ $eq: ['$ownerId', null] }, 1, 0] } } } },
    { $sort: { total: -1 } },
  ]);
  const teams = await Team.find({ orgId: req.user!.orgId }).select('name managerId').lean();
  const managers = await User.find({ _id: { $in: teams.map((t) => t.managerId).filter(Boolean) } }).select('name').lean();
  const mm = new Map(managers.map((m) => [String(m._id), m.name]));
  const tm = new Map(teams.map((t) => [String(t._id), t]));
  ok(res, rows.map((r) => { const t = tm.get(String(r._id)); return { teamId: r._id ? String(r._id) : null, name: t?.name ?? 'No team', manager: t?.managerId ? mm.get(String(t.managerId)) ?? '' : '', ...r, conversionRate: r.total ? Math.round((r.won / r.total) * 1000) / 10 : 0 }; }));
}));

/** Activity feed across the caller's scope (recent actions by the team). */
reportsRouter.get('/activity-feed', requirePermission('report.view_team', 'report.view_org'), asyncHandler(async (req, res) => {
  const leadIds = await Lead.find(leadScope(req.user!)).select('_id').limit(5000).lean();
  const items = await Activity.find({ leadId: { $in: leadIds.map((l) => l._id) }, hidden: false }).sort({ createdAt: -1 }).limit(50).lean();
  const [users, leads] = await Promise.all([
    User.find({ _id: { $in: items.map((i) => i.userId).filter(Boolean) } }).select('name avatarColor').lean(),
    Lead.find({ _id: { $in: items.map((i) => i.leadId) } }).select('name phone').lean(),
  ]);
  const um = new Map(users.map((u) => [String(u._id), normalise(u)])); const lm = new Map(leads.map((l) => [String(l._id), normalise(l)]));
  ok(res, items.map((i) => ({ ...normalise(i), user: i.userId ? um.get(String(i.userId)) ?? null : null, lead: lm.get(String(i.leadId)) ?? null })));
}));

reportsRouter.get('/imports', requirePermission('admin.imports', 'lead.import'), asyncHandler(async (req, res) => {
  const rows = await ImportJob.aggregate<{ _id: string; jobs: number; created: number; updated: number; errored: number }>([
    { $match: { orgId: oid(req.user!.orgId) } },
    { $group: { _id: '$status', jobs: { $sum: 1 }, created: { $sum: '$totals.created' }, updated: { $sum: '$totals.updated' }, errored: { $sum: '$totals.errored' } } },
  ]);
  ok(res, rows.map((r) => ({ status: r._id, ...r })));
}));

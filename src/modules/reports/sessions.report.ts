import { Router } from 'express';
import { z } from 'zod';
import { Types, type FilterQuery } from 'mongoose';
import { asyncHandler, ok } from '../../common/http';
import { forbidden } from '../../common/errors';
import { validate } from '../../middleware/validate';
import { hasPermission } from '../../middleware/auth';
import { dayRange, dayjs } from '../../common/dates';
import { Organisation, Session, Team, User, type SessionDoc } from '../../models';
import { visibleTeamIds } from '../../services/scope.service';
import { isOnline } from '../../services/session.service';
import type { AuthUser } from '../../common/types';

/**
 * Reports → Login & Logout. Built on the real Session rows (one per sign-in), never on synthetic data.
 * Managers see their teams; agents only themselves; admins everything.
 */
export const sessionsReportRouter = Router();

const query = z.object({
  from: z.string().optional(), to: z.string().optional(), teamId: z.string().optional(), userId: z.string().optional(),
  status: z.enum(['all', 'online', 'offline']).default('all'),
  sortBy: z.enum(['loginAt', 'endedAt', 'durationSec', 'agent']).default('loginAt'), sortDir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50),
});
type Q = z.infer<typeof query>;

function scopeFilter(user: AuthUser, q: Q, tz: string): FilterQuery<SessionDoc> {
  const f: Record<string, unknown> = { orgId: new Types.ObjectId(user.orgId) };
  const canTeam = hasPermission(user, 'report.view_team') || hasPermission(user, 'report.view_org');
  if (!canTeam) f.userId = new Types.ObjectId(user.id);
  else {
    const visible = visibleTeamIds(user);
    if (visible) { if (q.teamId && !visible.includes(q.teamId)) throw forbidden('Team is outside your scope'); f.teamId = { $in: (q.teamId ? [q.teamId] : visible).map((t) => new Types.ObjectId(t)) }; }
    else if (q.teamId && Types.ObjectId.isValid(q.teamId)) f.teamId = new Types.ObjectId(q.teamId);
    if (q.userId && Types.ObjectId.isValid(q.userId)) f.userId = new Types.ObjectId(q.userId);
  }
  const { start, end } = dayRange(tz, q.from, q.to);
  f.loginAt = { $gte: start, $lte: end };
  return f as FilterQuery<SessionDoc>;
}

export interface SessionRow { id: string; agentId: string; agentName: string; teamId: string | null; teamName: string; role: string; date: string; loginAt: string; logoutAt: string | null; lastSeenAt: string; durationSec: number; status: 'online' | 'offline'; endReason: string; ip: string; userAgent: string }

/** Shapes a session for the report. Open sessions show the live duration; expired ones end at the last activity. */
export function toRow(s: SessionDoc & { _id: unknown }, users: Map<string, { name: string; teamId?: unknown }>, teams: Map<string, string>, tz: string, now = Date.now()): SessionRow {
  const online = isOnline(s, now);
  const end = s.endedAt ? new Date(s.endedAt).getTime() : online ? now : new Date(s.lastSeenAt ?? s.loginAt).getTime();
  const u = users.get(String(s.userId));
  const teamId = s.teamId ? String(s.teamId) : u?.teamId ? String(u.teamId) : null;
  return {
    id: String(s._id), agentId: String(s.userId), agentName: u?.name ?? 'Unknown user', teamId, teamName: teamId ? teams.get(teamId) ?? '' : '', role: s.role,
    date: dayjs(s.loginAt).tz(tz).format('YYYY-MM-DD'), loginAt: new Date(s.loginAt).toISOString(), logoutAt: s.endedAt ? new Date(s.endedAt).toISOString() : null,
    lastSeenAt: new Date(s.lastSeenAt ?? s.loginAt).toISOString(), durationSec: Math.max(0, Math.round((end - new Date(s.loginAt).getTime()) / 1000)),
    status: online ? 'online' : 'offline', endReason: s.endedAt ? s.endReason || 'logout' : online ? '' : 'inactive', ip: s.ip, userAgent: s.userAgent,
  };
}

export function summarize(rows: SessionRow[], tz: string) {
  const agents = new Set(rows.map((r) => r.agentId));
  const online = new Set(rows.filter((r) => r.status === 'online').map((r) => r.agentId));
  // Average login time = mean clock time of each agent's FIRST login per day.
  const first = new Map<string, number>();
  rows.forEach((r) => { const k = `${r.agentId}:${r.date}`; const mins = dayjs(r.loginAt).tz(tz).hour() * 60 + dayjs(r.loginAt).tz(tz).minute(); first.set(k, Math.min(first.get(k) ?? 1e9, mins)); });
  const avgLoginMin = first.size ? Math.round(Array.from(first.values()).reduce((a, b) => a + b, 0) / first.size) : null;
  const avgSession = rows.length ? Math.round(rows.reduce((a, r) => a + r.durationSec, 0) / rows.length) : 0;
  return { totalAgents: agents.size, currentlyOnline: online.size, totalSessions: rows.length, avgLoginMinutes: avgLoginMin, avgSessionSec: avgSession };
}

async function load(req: import('express').Request) {
  const q = req.query as unknown as Q;
  const org = await Organisation.findById(req.user!.orgId).select('timezone').lean();
  const tz = org?.timezone ?? 'Asia/Kolkata';
  const filter = scopeFilter(req.user!, q, tz);
  const [sessions, users, teams] = await Promise.all([
    Session.find(filter).sort({ loginAt: -1 }).limit(20_000).lean(),
    User.find({ orgId: req.user!.orgId }).select('name teamId').lean(),
    Team.find({ orgId: req.user!.orgId }).select('name').lean(),
  ]);
  const um = new Map(users.map((u) => [String(u._id), { name: u.name, teamId: u.teamId }]));
  const tm = new Map(teams.map((t) => [String(t._id), t.name]));
  let rows = sessions.map((s) => toRow(s as never, um, tm, tz));
  if (q.status === 'online') rows = rows.filter((r) => r.status === 'online');
  if (q.status === 'offline') rows = rows.filter((r) => r.status === 'offline');
  const dir = q.sortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    if (q.sortBy === 'agent') return a.agentName.localeCompare(b.agentName) * dir;
    if (q.sortBy === 'durationSec') return (a.durationSec - b.durationSec) * dir;
    if (q.sortBy === 'endedAt') return ((a.logoutAt ? Date.parse(a.logoutAt) : Infinity) - (b.logoutAt ? Date.parse(b.logoutAt) : Infinity)) * dir;
    return (Date.parse(a.loginAt) - Date.parse(b.loginAt)) * dir;
  });
  return { q, tz, rows };
}

const canView = (req: import('express').Request) => hasPermission(req.user!, 'report.view_org') || hasPermission(req.user!, 'report.view_team') || hasPermission(req.user!, 'report.view_own');

sessionsReportRouter.get('/', validate({ query }), asyncHandler(async (req, res) => {
  if (!canView(req)) throw forbidden();
  const { q, tz, rows } = await load(req);
  const start = (q.page - 1) * q.limit;
  res.json({ success: true, data: { items: rows.slice(start, start + q.limit), summary: summarize(rows, tz), timezone: tz }, meta: { page: q.page, limit: q.limit, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / q.limit)) } });
}));

export const fmtDuration = (sec: number) => { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`; };

sessionsReportRouter.get('/export', validate({ query }), asyncHandler(async (req, res) => {
  if (!canView(req)) throw forbidden();
  const { tz, rows } = await load(req);
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = ['Agent,Team,Date,Login Time,Logout Time,Total Session,Status,End reason,IP'];
  rows.forEach((r) => lines.push([r.agentName, r.teamName, dayjs(r.date).format('DD/MM/YYYY'), dayjs(r.loginAt).tz(tz).format('hh:mm A'), r.logoutAt ? dayjs(r.logoutAt).tz(tz).format('hh:mm A') : '—', fmtDuration(r.durationSec), r.status === 'online' ? 'Online' : 'Offline', r.endReason, r.ip].map((x) => esc(String(x ?? ''))).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="login-logout-${dayjs().format('YYYY-MM-DD')}.csv"`);
  res.send(`\uFEFF${lines.join('\n')}`);
}));

/** Lightweight "who is online" for dashboards (team-scoped). */
sessionsReportRouter.get('/online', asyncHandler(async (req, res) => {
  if (!hasPermission(req.user!, 'report.view_team') && !hasPermission(req.user!, 'report.view_org')) throw forbidden();
  const visible = visibleTeamIds(req.user!);
  const f: Record<string, unknown> = { orgId: new Types.ObjectId(req.user!.orgId), endedAt: null, revokedAt: null, expiresAt: { $gt: new Date() }, lastSeenAt: { $gt: new Date(Date.now() - 30 * 60_000) } };
  if (visible) f.teamId = { $in: visible.map((t) => new Types.ObjectId(t)) };
  const sessions = await Session.find(f).select('userId').lean();
  ok(res, { online: new Set(sessions.map((s) => String(s.userId))).size });
}));

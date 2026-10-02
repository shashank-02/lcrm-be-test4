import { Router } from 'express';
import { asyncHandler, ok } from '../common/http';
import { normalise } from '../common/crud';
import { PERMISSION_CATALOGUE } from '../common/permissions';
import { ROLE_LABELS } from '../common/types';
import { FieldDefinition, ListView, MessageTemplate, Organisation, Source, Stage, StageDirective, Status, Team, ViewGroup, User } from '../models';
import { avatarUrl } from './auth/auth.routes';
import { assignableUsers, visibleTeamIds } from '../services/scope.service';
import { DASHBOARD_WIDGETS, LEAD_TABS, QUICK_ACTIONS, ROLES, defaultDashboard, defaultLeadTabs, defaultQuickActions, normalizeLayout, type LayoutItem, type Role } from '../common/uiconfig';
import { mailConfigured } from '../services/mail.service';

export const bootstrapRouter = Router();

/** Everything the SPA needs after login, in one round-trip. */
bootstrapRouter.get('/', asyncHandler(async (req, res) => {
  const orgId = req.user!.orgId;
  const teamFilter: Record<string, unknown> = { orgId, isActive: true };
  const visible = visibleTeamIds(req.user!);
  if (visible) teamFilter._id = { $in: visible };
  const [org, stages, statuses, sources, fields, templates, directives, views, users, teams, viewGroups] = await Promise.all([
    Organisation.findById(orgId).lean(),
    Stage.find({ orgId, isActive: true }).sort({ order: 1 }).lean(),
    Status.find({ orgId, isActive: true }).sort({ order: 1 }).lean(),
    Source.find({ orgId, isActive: true }).sort({ name: 1 }).lean(),
    FieldDefinition.find({ orgId, isActive: true }).sort({ tab: 1, section: 1, order: 1 }).lean(),
    MessageTemplate.find({ orgId, isActive: true }).sort({ channel: 1, name: 1 }).lean(),
    StageDirective.find({ orgId, isActive: true }).lean(),
    ListView.find({ orgId, isActive: true, $or: [{ userId: null }, { userId: req.user!.id }] }).sort({ order: 1 }).lean(),
    assignableUsers(req.user!),
    Team.find(teamFilter).sort({ name: 1 }).lean(),
    ViewGroup.find({ orgId }).sort({ order: 1 }).lean(),
  ]);
  // Only tabs this user's role/team may see
  const myTeams = new Set([req.user!.teamId, ...req.user!.managedTeamIds].filter(Boolean));
  const visibleViews = views.filter((v) => (!v.roles.length || v.roles.includes(req.user!.role) || req.user!.role === 'admin') && (!v.teamIds.length || v.teamIds.some((t) => myTeams.has(String(t))) || req.user!.role === 'admin'));
  const avatarKeys = await User.find({ _id: { $in: users.map((u) => u._id) } }).select('avatarKey').lean();
  const ak = new Map(avatarKeys.map((u) => [String(u._id), u.avatarKey]));
  // Admin-configurable layouts are always returned fully normalised (defaults merged, unknown keys dropped).
  const customTabKeys = Array.from(new Set(fields.map((f) => f.tab).filter((t) => t && t !== 'Basic Info'))).map((t) => ({ key: `tab:${t}` }));
  const o = org ? (normalise(org) as Record<string, unknown> & { settings: Record<string, unknown> }) : null;
  if (o) {
    const st = o.settings;
    const sys = defaultLeadTabs();
    const tabFallback = [sys[0], ...customTabKeys.map((c) => ({ key: c.key, label: '', visible: true, order: 0 })), ...sys.slice(1)].map((t, i) => ({ ...t, order: i }));
    st.leadTabs = normalizeLayout(st.leadTabs as LayoutItem[] | undefined, [...LEAD_TABS, ...customTabKeys], tabFallback);
    const dash = (st.dashboards as Partial<Record<Role, LayoutItem[]>> | undefined) ?? {};
    st.dashboards = Object.fromEntries(ROLES.map((r) => [r, normalizeLayout(dash[r], DASHBOARD_WIDGETS, defaultDashboard(r))]));
    const qa = (st.quickActions as (LayoutItem & { roles?: Role[] })[] | undefined) ?? [];
    st.quickActions = normalizeLayout(qa, QUICK_ACTIONS, defaultQuickActions()).map((i) => ({ ...i, roles: qa.find((q) => q.key === i.key)?.roles ?? [] }));
    o.mailConfigured = mailConfigured();
  }
  ok(res, {
    org: o,
    stages: stages.map(normalise), statuses: statuses.map(normalise), sources: sources.map(normalise),
    fields: fields.map(normalise), templates: templates.map(normalise), directives: directives.map(normalise),
    views: visibleViews.map(normalise), viewGroups: viewGroups.map(normalise), users: users.map((u) => ({ ...normalise(u), avatarUrl: avatarUrl(ak.get(String(u._id))) })), teams: teams.map(normalise),
    permissionCatalogue: PERMISSION_CATALOGUE, roles: ROLE_LABELS,
  });
}));

/**
 * Admin-configurable UI layouts stored on Organisation.settings: lead-page tabs, per-role dashboards and the
 * lead-page quick-action floaters. Shared by the API validators, the seed and the bootstrap payload; the
 * frontend mirrors the catalogue keys.
 */
export type Role = 'admin' | 'branch_manager' | 'team_lead' | 'agent';
export const ROLES: Role[] = ['admin', 'branch_manager', 'team_lead', 'agent'];

export interface LayoutItem { key: string; label?: string; visible: boolean; order: number }
export interface QuickActionItem extends LayoutItem { roles: Role[] }

/** System lead-page tabs; custom field tabs are added by key `tab:<name>` at runtime. */
export const LEAD_TABS: { key: string; label: string }[] = [
  { key: 'basic', label: 'Basic Info' }, { key: 'activities', label: 'Activities' }, { key: 'interactions', label: 'Interactions' },
  { key: 'files', label: 'Files' }, { key: 'notes', label: 'Notes' }, { key: 'tasks', label: 'Tasks' },
];

export const DASHBOARD_WIDGETS: { key: string; label: string; kind: 'kpi' | 'chart'; perm?: string }[] = [
  { key: 'kpi.followUpsToday', label: 'Follow-ups today', kind: 'kpi' }, { key: 'kpi.overdue', label: 'Overdue follow-ups', kind: 'kpi' },
  { key: 'kpi.contactedToday', label: 'Contacted today', kind: 'kpi' }, { key: 'kpi.createdToday', label: 'Created today', kind: 'kpi' },
  { key: 'kpi.assignedToday', label: 'Assigned today', kind: 'kpi' }, { key: 'kpi.unassigned', label: 'Unassigned', kind: 'kpi' },
  { key: 'kpi.openLeads', label: 'Open leads', kind: 'kpi' }, { key: 'kpi.won', label: 'Won · conversion', kind: 'kpi' },
  { key: 'kpi.topUpsDue', label: 'Top-up follow-ups due', kind: 'kpi' }, { key: 'kpi.onlineAgents', label: 'Agents online now', kind: 'kpi', perm: 'report.view_team' },
  { key: 'chart.funnel', label: 'Pipeline funnel', kind: 'chart' }, { key: 'chart.bySource', label: 'Leads by source', kind: 'chart' },
  { key: 'chart.trend', label: 'Created vs contacted (14 days)', kind: 'chart' }, { key: 'chart.byStatus', label: 'Leads by status', kind: 'chart' },
  { key: 'chart.teamActivity', label: 'Team activity feed', kind: 'chart', perm: 'report.view_team' }, { key: 'chart.myFollowUps', label: 'My follow-ups today', kind: 'chart' },
  { key: 'chart.agentLeaderboard', label: 'Agent leaderboard (30 days)', kind: 'chart', perm: 'report.view_team' },
];

export const QUICK_ACTIONS: { key: string; label: string; perm?: string; defaultOn: boolean }[] = [
  { key: 'call_log', label: 'Add Call Log', perm: 'call.create', defaultOn: true }, { key: 'note', label: 'Add Note', perm: 'note.create', defaultOn: true },
  { key: 'topup', label: 'Top-up follow-up', perm: 'topup.action', defaultOn: true }, { key: 'call', label: 'Call', perm: 'lead.communicate', defaultOn: true },
  { key: 'whatsapp', label: 'WhatsApp', perm: 'lead.communicate', defaultOn: true }, { key: 'email', label: 'Email', perm: 'lead.communicate', defaultOn: true },
  { key: 'followup', label: 'Set follow-up', perm: 'lead.set_followup', defaultOn: false }, { key: 'stage', label: 'Update stage', perm: 'lead.update_stage', defaultOn: false },
  { key: 'status', label: 'Update status', perm: 'lead.update_status', defaultOn: false }, { key: 'assign', label: 'Assign owner', perm: 'lead.assign', defaultOn: false },
  { key: 'files', label: 'Lead files', perm: 'file.view', defaultOn: false },
];

export const defaultLeadTabs = (): LayoutItem[] => LEAD_TABS.map((t, i) => ({ key: t.key, label: '', visible: true, order: i }));
/** Agents get the personal widgets, managers the team widgets; admins everything. */
export const defaultDashboard = (role: Role): LayoutItem[] => {
  const team = role !== 'agent';
  const hidden = new Set<string>(role === 'agent' ? ['kpi.unassigned', 'kpi.assignedToday', 'kpi.onlineAgents', 'chart.teamActivity', 'chart.agentLeaderboard'] : ['chart.myFollowUps']);
  if (!team) hidden.add('chart.agentLeaderboard');
  if (role !== 'admin') hidden.add('kpi.onlineAgents');
  return DASHBOARD_WIDGETS.map((w, i) => ({ key: w.key, label: '', visible: !hidden.has(w.key), order: i }));
};
export const defaultDashboards = () => Object.fromEntries(ROLES.map((r) => [r, defaultDashboard(r)])) as Record<Role, LayoutItem[]>;
export const defaultQuickActions = (): QuickActionItem[] => QUICK_ACTIONS.map((a, i) => ({ key: a.key, label: '', visible: a.defaultOn, order: i, roles: [] }));

/** Merges a stored layout with the catalogue so new keys appear and unknown keys are dropped. */
export function normalizeLayout(stored: LayoutItem[] | undefined, catalogue: { key: string }[], fallback: LayoutItem[]): LayoutItem[] {
  const base = stored?.length ? stored : fallback;
  const known = new Set(catalogue.map((c) => c.key));
  const seen = new Set<string>();
  const out: LayoutItem[] = [];
  [...base].sort((a, b) => a.order - b.order).forEach((i) => { if (known.has(i.key) && !seen.has(i.key)) { seen.add(i.key); out.push({ key: i.key, label: i.label ?? '', visible: i.visible !== false, order: out.length }); } });
  catalogue.forEach((c) => { if (!seen.has(c.key)) { const f = fallback.find((x) => x.key === c.key); out.push({ key: c.key, label: '', visible: f ? f.visible : true, order: out.length }); } });
  return out;
}

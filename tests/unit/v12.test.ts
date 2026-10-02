import { isOnline } from '../../src/services/session.service';
import { summarize, toRow, fmtDuration, type SessionRow } from '../../src/modules/reports/sessions.report';
import { DASHBOARD_WIDGETS, LEAD_TABS, QUICK_ACTIONS, defaultDashboard, defaultLeadTabs, defaultQuickActions, normalizeLayout } from '../../src/common/uiconfig';

const MIN = 60_000;
const session = (over: Record<string, unknown> = {}) => ({ _id: 's1', userId: 'u1', orgId: 'o', teamId: 't1', role: 'agent', tokenHash: 'h', userAgent: '', ip: '1.1.1.1', expiresAt: new Date(Date.now() + 7 * 86_400_000), revokedAt: null, loginAt: new Date(Date.now() - 3 * 3600_000), lastSeenAt: new Date(Date.now() - 5 * MIN), endedAt: null, endReason: '', durationSec: null, ...over }) as unknown as Parameters<typeof toRow>[0];
const users = new Map([['u1', { name: 'Karan Mehta', teamId: 't1' }]]);
const teams = new Map([['t1', 'Bengaluru – Personal Loans']]);

describe('session online rules', () => {
  it('is online while open, unexpired and recently used', () => {
    expect(isOnline(session())).toBe(true);
    expect(isOnline(session({ endedAt: new Date() }))).toBe(false);
    expect(isOnline(session({ revokedAt: new Date() }))).toBe(false);
    expect(isOnline(session({ expiresAt: new Date(Date.now() - 1) }))).toBe(false);
    expect(isOnline(session({ lastSeenAt: new Date(Date.now() - 31 * MIN) }))).toBe(false);
  });
  it('rows show live duration for online sessions and the last activity for abandoned ones', () => {
    const live = toRow(session(), users, teams, 'Asia/Kolkata');
    expect(live.status).toBe('online'); expect(live.logoutAt).toBeNull(); expect(live.durationSec).toBeGreaterThanOrEqual(3 * 3600 - 5); expect(live.teamName).toContain('Personal Loans');
    const idle = toRow(session({ lastSeenAt: new Date(Date.now() - 2 * 3600_000) }), users, teams, 'Asia/Kolkata');
    expect(idle.status).toBe('offline'); expect(idle.logoutAt).toBeNull(); expect(idle.endReason).toBe('inactive'); expect(idle.durationSec).toBe(3600);
    const out = toRow(session({ endedAt: new Date(Date.now() - 60 * MIN), endReason: 'logout', durationSec: 7200 }), users, teams, 'Asia/Kolkata');
    expect(out.status).toBe('offline'); expect(out.logoutAt).not.toBeNull(); expect(out.durationSec).toBe(7200);
  });
  it('summary counts distinct agents, online agents, and averages first-login time and duration', () => {
    const rows: SessionRow[] = [
      { ...toRow(session(), users, teams, 'Asia/Kolkata'), loginAt: new Date('2026-10-01T04:00:00Z').toISOString(), date: '2026-10-01', durationSec: 3600 }, // 09:30 IST
      { ...toRow(session({ userId: 'u2' }), users, teams, 'Asia/Kolkata'), agentId: 'u2', status: 'offline', loginAt: new Date('2026-10-01T05:00:00Z').toISOString(), date: '2026-10-01', durationSec: 1800 }, // 10:30 IST
      { ...toRow(session(), users, teams, 'Asia/Kolkata'), loginAt: new Date('2026-10-01T10:00:00Z').toISOString(), date: '2026-10-01', durationSec: 600 }, // second login same day — ignored for avg login time
    ];
    const s = summarize(rows, 'Asia/Kolkata');
    expect(s.totalAgents).toBe(2); expect(s.currentlyOnline).toBe(1); expect(s.totalSessions).toBe(3);
    expect(s.avgLoginMinutes).toBe(600); // mean of 09:30 and 10:30 → 10:00
    expect(s.avgSessionSec).toBe(2000);
    expect(fmtDuration(33180)).toBe('9h 13m'); expect(fmtDuration(540)).toBe('9m');
  });
});

describe('ui layout normalisation', () => {
  it('fills missing catalogue keys, drops unknown ones and renumbers order', () => {
    const stored = [{ key: 'notes', label: 'Comments', visible: true, order: 5 }, { key: 'ghost', label: '', visible: true, order: 0 }, { key: 'basic', label: '', visible: true, order: 1 }];
    const out = normalizeLayout(stored, LEAD_TABS, defaultLeadTabs());
    expect(out.map((i) => i.key)).toEqual(['basic', 'notes', 'activities', 'interactions', 'files', 'tasks']);
    expect(out.find((i) => i.key === 'notes')!.label).toBe('Comments');
    expect(out.map((i) => i.order)).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it('role defaults hide team widgets for agents and expose everything to admins', () => {
    const agent = defaultDashboard('agent'); const admin = defaultDashboard('admin');
    expect(agent.find((w) => w.key === 'chart.teamActivity')!.visible).toBe(false);
    expect(agent.find((w) => w.key === 'chart.myFollowUps')!.visible).toBe(true);
    expect(admin.find((w) => w.key === 'kpi.onlineAgents')!.visible).toBe(true);
    expect(admin).toHaveLength(DASHBOARD_WIDGETS.length);
    expect(defaultQuickActions().filter((q) => q.visible).map((q) => q.key)).toEqual(['call_log', 'note', 'topup', 'call', 'whatsapp', 'email']);
    expect(normalizeLayout(undefined, QUICK_ACTIONS, defaultQuickActions())).toHaveLength(QUICK_ACTIONS.length);
  });
});

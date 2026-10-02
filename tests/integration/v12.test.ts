import request from 'supertest';
import { app, auth, login, resetDb, seedBasic, startDb, stopDb } from '../helpers/db';
import { Session, Organisation } from '../../src/models';
import { sweepStaleSessions } from '../../src/services/session.service';
import { mailOutbox } from '../../src/services/mail.service';

beforeAll(startDb); afterAll(stopDb); beforeEach(resetDb);

describe('login / logout sessions report', () => {
  it('records a session per sign-in, closes it honestly on logout and reports it', async () => {
    const s = await seedBasic();
    const a1 = await login('agent1');
    const open = await Session.findOne({ userId: s.agent1._id }).lean();
    expect(open).toBeTruthy(); expect(open!.endedAt).toBeNull(); expect(String(open!.teamId)).toBe(String(s.team._id)); expect(open!.role).toBe('agent');
    // the agent sees only their own row and it is online
    const mine = await request(app).get('/api/v1/reports/login-sessions').set(auth(a1.accessToken));
    expect(mine.status).toBe(200); expect(mine.body.data.items).toHaveLength(1); expect(mine.body.data.items[0].status).toBe('online'); expect(mine.body.data.items[0].logoutAt).toBeNull(); expect(mine.body.data.summary.currentlyOnline).toBe(1);
    // logout → endedAt + duration, status offline, logout time present
    await request(app).post('/api/v1/auth/logout').set(auth(a1.accessToken)).send({ refreshToken: a1.refreshToken }).expect(200);
    const closed = await Session.findById(open!._id).lean();
    expect(closed!.endedAt).toBeTruthy(); expect(closed!.endReason).toBe('logout'); expect(closed!.durationSec).toBeGreaterThanOrEqual(0);
    const admin = await login('admin');
    const all = await request(app).get('/api/v1/reports/login-sessions?status=offline').set(auth(admin.accessToken));
    const row = all.body.data.items.find((r: { agentName: string }) => r.agentName === 'agent1');
    expect(row.status).toBe('offline'); expect(row.logoutAt).toBeTruthy(); expect(row.teamName).toBe('Team A');
    // team filter outside scope is forbidden for a manager of Team A
    const mgr = await login('manager');
    expect((await request(app).get(`/api/v1/reports/login-sessions?teamId=${s.otherTeam._id}`).set(auth(mgr.accessToken))).status).toBe(403);
    // CSV export respects filters
    const csv = await request(app).get('/api/v1/reports/login-sessions/export?status=offline').set(auth(admin.accessToken));
    expect(csv.status).toBe(200); expect(csv.headers['content-type']).toContain('text/csv'); expect(csv.text).toContain('agent1'); expect(csv.text.split('\n')[0]).toContain('Login Time');
  });
  it('closes abandoned sessions at their last activity instead of inventing a logout time', async () => {
    const s = await seedBasic();
    const a1 = await login('agent1');
    const sess = await Session.findOne({ userId: s.agent1._id });
    const lastSeen = new Date(Date.now() - 2 * 3600_000);
    sess!.lastSeenAt = lastSeen; await sess!.save();
    const closed = await sweepStaleSessions();
    expect(closed).toBe(1);
    const after = await Session.findById(sess!._id).lean();
    expect(after!.endReason).toBe('expired'); expect(Math.abs(new Date(after!.endedAt!).getTime() - lastSeen.getTime())).toBeLessThan(1000);
    // the expired session no longer authenticates
    expect((await request(app).get('/api/v1/auth/me').set(auth(a1.accessToken))).status).toBe(401);
    const admin = await login('admin');
    const rows = await request(app).get('/api/v1/reports/login-sessions').set(auth(admin.accessToken));
    const row = rows.body.data.items.find((r: { agentName: string }) => r.agentName === 'agent1');
    expect(row.endReason).toBe('expired'); expect(row.durationSec).toBeLessThan(7200); // ended at last activity, not "now"
  });
});

describe('admin-configurable layouts', () => {
  it('normalises lead tabs, dashboards and quick actions and serves them via bootstrap', async () => {
    await seedBasic();
    const admin = await login('admin');
    const boot0 = await request(app).get('/api/v1/bootstrap').set(auth(admin.accessToken));
    expect(boot0.body.data.org.settings.leadTabs.map((t: { key: string }) => t.key)).toEqual(['basic', 'activities', 'interactions', 'files', 'notes', 'tasks']);
    expect(boot0.body.data.org.settings.dashboards.agent.find((w: { key: string }) => w.key === 'chart.teamActivity').visible).toBe(false);
    const res = await request(app).patch('/api/v1/organisation').set(auth(admin.accessToken)).send({ settings: {
      leadTabs: [{ key: 'notes', label: 'Comments', visible: true, order: 0 }, { key: 'basic', label: '', visible: false, order: 1 }, { key: 'bogus', label: '', visible: true, order: 2 }],
      dashboards: { agent: [{ key: 'kpi.overdue', label: 'Late', visible: true, order: 0 }] },
      quickActions: [{ key: 'whatsapp', label: '', visible: false, order: 0, roles: ['agent'] }],
    } });
    expect(res.status).toBe(200);
    const boot = await request(app).get('/api/v1/bootstrap').set(auth(admin.accessToken));
    const st = boot.body.data.org.settings;
    expect(st.leadTabs[0]).toMatchObject({ key: 'notes', label: 'Comments' });
    expect(st.leadTabs.some((t: { key: string }) => t.key === 'bogus')).toBe(false);
    expect(st.leadTabs).toHaveLength(6);
    expect(st.dashboards.agent[0]).toMatchObject({ key: 'kpi.overdue', label: 'Late' });
    expect(st.dashboards.agent).toHaveLength(boot0.body.data.org.settings.dashboards.agent.length);
    expect(st.dashboards.admin).toHaveLength(boot0.body.data.org.settings.dashboards.admin.length); // other roles untouched
    expect(st.quickActions.find((q: { key: string }) => q.key === 'whatsapp')).toMatchObject({ visible: false, roles: ['agent'] });
    expect(st.quickActions.find((q: { key: string }) => q.key === 'call').visible).toBe(true);
    // non-admins cannot change layouts
    const agent = await login('agent1');
    expect((await request(app).patch('/api/v1/organisation').set(auth(agent.accessToken)).send({ settings: { quickActions: [] } })).status).toBe(403);
    expect((await request(app).patch('/api/v1/organisation').set(auth(admin.accessToken)).send({ settings: { dashboards: { ceo: [] } } })).status).toBe(422);
  });
});

describe('email delivery diagnostics', () => {
  it('reports the log driver as not configured and refuses a test send; sign-in codes are still issued in development', async () => {
    const s = await seedBasic();
    const admin = await login('admin');
    const status = await request(app).get('/api/v1/organisation/mail-status').set(auth(admin.accessToken));
    expect(status.status).toBe(200); expect(status.body.data.driver).toBe('log'); expect(status.body.data.configured).toBe(false);
    const test = await request(app).post('/api/v1/organisation/mail-test').set(auth(admin.accessToken)).send({});
    expect(test.status).toBe(503); expect(test.body.error.code).toBe('MAIL_NOT_CONFIGURED');
    const agent = await login('agent1');
    expect((await request(app).get('/api/v1/organisation/mail-status').set(auth(agent.accessToken))).status).toBe(403);
    // 2FA login in a non-production log-driver environment is explicit about non-delivery
    await Organisation.updateOne({ _id: s.org._id }, {});
    s.agent2.twoFactorEnabled = true; await s.agent2.save();
    mailOutbox.length = 0;
    const r = await request(app).post('/api/v1/auth/login').send({ identifier: 'agent2', password: 'Passw0rd!' });
    expect(r.status).toBe(200); expect(r.body.data.requires2FA).toBe(true); expect(r.body.data.delivered).toBe(false); expect(r.body.data.devCode).toMatch(/^\d{6}$/);
    expect(mailOutbox).toHaveLength(1); expect(mailOutbox[0].text).toContain(r.body.data.devCode);
  });
});

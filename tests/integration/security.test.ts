import request from 'supertest';
import { app, startDb, stopDb, resetDb, seedBasic, login, auth } from '../helpers/db';
import { mailOutbox } from '../../src/services/mail.service';
import { DocFolder, Document, Lead, Notification, Stage, TopUpReminder, User, PermissionTemplate } from '../../src/models';
import { tick } from '../../src/services/scheduler.service';
import { storage } from '../../src/services/storage.service';

beforeAll(startDb); afterAll(stopDb); beforeEach(() => { mailOutbox.length = 0; return resetDb(); });

describe('2FA email OTP', () => {
  it('asks for a code, emails it, rejects wrong codes, accepts the right one', async () => {
    const s = await seedBasic();
    await User.updateOne({ _id: s.agent1._id }, { $set: { twoFactorEnabled: true } });
    const step1 = await request(app).post('/api/v1/auth/login').send({ identifier: 'agent1', password: 'Passw0rd!' });
    expect(step1.status).toBe(200); expect(step1.body.data.requires2FA).toBe(true); expect(step1.body.data.accessToken).toBeUndefined();
    expect(mailOutbox).toHaveLength(1);
    const code = mailOutbox[0].text.match(/code is (\d{6})/)![1];
    const bad = await request(app).post('/api/v1/auth/verify-otp').send({ challengeId: step1.body.data.challengeId, code: code === '000000' ? '111111' : '000000' });
    expect(bad.status).toBe(401); expect(bad.body.error.code).toBe('OTP_INVALID');
    const good = await request(app).post('/api/v1/auth/verify-otp').send({ challengeId: step1.body.data.challengeId, code });
    expect(good.status).toBe(200); expect(good.body.data.accessToken).toBeTruthy(); expect(good.body.data.user.twoFactorEnabled).toBe(true);
    const replay = await request(app).post('/api/v1/auth/verify-otp').send({ challengeId: step1.body.data.challengeId, code });
    expect(replay.status).toBe(401);
  });
  it('never exposes password hashes and locks accounts after repeated failures', async () => {
    const s = await seedBasic();
    const admin = await login('admin');
    const list = await request(app).get('/api/v1/users').set(auth(admin.accessToken));
    expect(JSON.stringify(list.body)).not.toContain('passwordHash');
    for (let i = 0; i < 5; i++) await request(app).post('/api/v1/auth/login').send({ identifier: 'agent2', password: 'wrong' });
    const locked = await request(app).post('/api/v1/auth/login').send({ identifier: 'agent2', password: 'Passw0rd!' });
    expect(locked.status).toBe(423);
    void s;
  });
  it('logout invalidates the access token immediately (server-side session)', async () => {
    await seedBasic();
    const { accessToken, refreshToken } = await login('agent1');
    await request(app).get('/api/v1/auth/me').set(auth(accessToken)).expect(200);
    await request(app).post('/api/v1/auth/logout').set(auth(accessToken)).send({ refreshToken }).expect(200);
    expect((await request(app).get('/api/v1/auth/me').set(auth(accessToken))).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken })).status).toBe(401);
  });
});

describe('notes permissions are enforced by the API', () => {
  it('agent can add but not edit/delete by default; admin can edit anyone\'s note', async () => {
    const s = await seedBasic();
    const agent = await login('agent1'); const admin = await login('admin');
    expect(agent.user.permissions).not.toContain('note.edit');
    const lead = (await request(app).post('/api/v1/leads').set(auth(agent.accessToken)).send({ phone: '9000000001', name: 'N' })).body.data;
    const note = (await request(app).post(`/api/v1/leads/${lead.id}/notes`).set(auth(agent.accessToken)).send({ body: 'first' })).body.data;
    expect((await request(app).patch(`/api/v1/leads/${lead.id}/notes/${note.id}`).set(auth(agent.accessToken)).send({ body: 'edited' })).status).toBe(403);
    expect((await request(app).delete(`/api/v1/leads/${lead.id}/notes/${note.id}`).set(auth(agent.accessToken))).status).toBe(403);
    expect((await request(app).patch(`/api/v1/leads/${lead.id}/notes/${note.id}`).set(auth(admin.accessToken)).send({ body: 'admin edit' })).status).toBe(200);
    // grant edit only → agent can edit but still not delete
    await PermissionTemplate.updateOne({ orgId: s.org._id, role: 'agent', isSystem: true }, { $addToSet: { permissions: 'note.edit' } });
    expect((await request(app).patch(`/api/v1/leads/${lead.id}/notes/${note.id}`).set(auth(agent.accessToken)).send({ body: 'agent edit' })).status).toBe(200);
    expect((await request(app).delete(`/api/v1/leads/${lead.id}/notes/${note.id}`).set(auth(agent.accessToken))).status).toBe(403);
  });
});

describe('team hierarchy and stage bar setting', () => {
  it('team lead without lead.view_team sees only own leads; subordinate edits need lead.edit_subordinates', async () => {
    const s = await seedBasic();
    await Lead.create({ orgId: s.org._id, phone: '9000000010', name: 'A1', stageId: s.stages[0]._id, ownerId: s.agent1._id, teamId: s.team._id });
    const tl = await login('tl');
    const one = await request(app).get('/api/v1/leads').set(auth(tl.accessToken)); expect(one.body.meta.total).toBe(1);
    const leadId = one.body.data[0].id;
    expect((await request(app).patch(`/api/v1/leads/${leadId}`).set(auth(tl.accessToken)).send({ city: 'Mysuru' })).status).toBe(200);
    const tpl = await PermissionTemplate.findOne({ orgId: s.org._id, role: 'team_lead', isSystem: true }).lean();
    await PermissionTemplate.updateOne({ _id: tpl!._id }, { $set: { permissions: tpl!.permissions.filter((p) => !['lead.view_team', 'lead.edit_subordinates'].includes(p)) } });
    expect((await request(app).get('/api/v1/leads').set(auth(tl.accessToken))).body.meta.total).toBe(0);
    await PermissionTemplate.updateOne({ orgId: s.org._id, role: 'team_lead', isSystem: true }, { $addToSet: { permissions: 'lead.view_team' } });
    expect((await request(app).get('/api/v1/leads').set(auth(tl.accessToken))).body.meta.total).toBe(1);
    expect((await request(app).patch(`/api/v1/leads/${leadId}`).set(auth(tl.accessToken)).send({ city: 'Hubballi' })).status).toBe(403);
  });
  it('only admins can toggle the stage bar and it is served to everyone via bootstrap', async () => {
    await seedBasic();
    const admin = await login('admin'); const agent = await login('agent1');
    expect((await request(app).patch('/api/v1/organisation').set(auth(agent.accessToken)).send({ settings: { showLeadStageBar: false } })).status).toBe(403);
    await request(app).patch('/api/v1/organisation').set(auth(admin.accessToken)).send({ settings: { showLeadStageBar: false } }).expect(200);
    const boot = await request(app).get('/api/v1/bootstrap').set(auth(agent.accessToken));
    expect(boot.body.data.org.settings.showLeadStageBar).toBe(false);
    expect(boot.body.data.org.settings.duplicatePhoneCheck).toBe(true); // sibling settings preserved
  });
});

describe('files corner', () => {
  it('only admins upload; visibility is role+team aware; non-admin download is blocked at the API', async () => {
    const s = await seedBasic();
    const admin = await login('admin'); const agent = await login('agent1'); const outsider = await login('outsider');
    expect((await request(app).post('/api/v1/documents').set(auth(agent.accessToken)).field('name', 'x').attach('file', Buffer.from('%PDF-1.4'), 'x.pdf')).status).toBe(403);
    const folder = (await request(app).post('/api/v1/documents/folders').set(auth(admin.accessToken)).send({ name: 'Personal Loan' })).body.data;
    const up = await request(app).post('/api/v1/documents').set(auth(admin.accessToken)).field('name', 'PL Rules').field('folderId', folder.id).field('audience', JSON.stringify({ roles: ['agents'], teamIds: [String(s.team._id)] })).attach('file', Buffer.from('%PDF-1.4 test'), 'rules.pdf');
    expect(up.status).toBe(201);
    const docId = up.body.data.id;
    expect((await request(app).get('/api/v1/documents').set(auth(agent.accessToken))).body.data.map((d: { id: string }) => d.id)).toContain(docId);
    expect((await request(app).get('/api/v1/documents').set(auth(outsider.accessToken))).body.data).toHaveLength(0);
    const tokenRes = await request(app).get(`/api/v1/documents/${docId}/view-token`).set(auth(agent.accessToken)); expect(tokenRes.status).toBe(200); expect(tokenRes.body.data.canDownload).toBe(false);
    expect((await request(app).get(`/api/v1/documents/${docId}/view-token`).set(auth(outsider.accessToken))).status).toBe(403);
    const view = await request(app).get(`/api/v1/documents/${docId}/view?token=${tokenRes.body.data.token}`); expect(view.status).toBe(200); expect(view.headers['content-disposition']).toBe('inline');
    expect((await request(app).get(`/api/v1/documents/${docId}/view?token=bogus`)).status).toBe(401);
    expect((await request(app).get(`/api/v1/documents/${docId}/download`).set(auth(agent.accessToken))).status).toBe(403);
    expect((await request(app).get(`/api/v1/documents/${docId}/download`).set(auth(admin.accessToken))).status).toBe(200);
    await request(app).patch(`/api/v1/documents/${docId}`).set(auth(admin.accessToken)).send({ audience: { all: true } }).expect(200);
    expect((await request(app).get('/api/v1/documents').set(auth(outsider.accessToken))).body.data).toHaveLength(1);
    const doc = await Document.findById(docId).lean(); await storage().deleteObject(doc!.storageKey);
    expect(await DocFolder.countDocuments()).toBe(1);
  });
});

describe('top-up reminders and notifications', () => {
  it('starts a 3-month timer when a lead is approved, notifies the owner when due, and records the outcome', async () => {
    const s = await seedBasic();
    const admin = await login('admin');
    const lead = (await request(app).post('/api/v1/leads').set(auth(admin.accessToken)).send({ phone: '9000000020', name: 'Pooja Menon', ownerId: String(s.agent1._id) })).body.data;
    const approved = s.stages.find((x) => x.name === 'Approved')!;
    await request(app).post(`/api/v1/leads/${lead.id}/stage`).set(auth(admin.accessToken)).send({ stageId: String(approved._id), remarks: 'Disbursed' }).expect(200);
    const r = await TopUpReminder.findOne({ leadId: lead.id }); expect(r).toBeTruthy(); expect(r!.status).toBe('scheduled');
    expect(Math.round((r!.dueAt.getTime() - r!.disbursedAt.getTime()) / 86_400_000)).toBeGreaterThanOrEqual(89);
    // second approval on the same day must not duplicate
    await Stage.updateOne({ _id: s.stages[0]._id }, {});
    await request(app).post(`/api/v1/leads/${lead.id}/stage`).set(auth(admin.accessToken)).send({ stageId: String(s.stages[0]._id) }).expect(200);
    await request(app).post(`/api/v1/leads/${lead.id}/stage`).set(auth(admin.accessToken)).send({ stageId: String(approved._id) }).expect(200);
    expect(await TopUpReminder.countDocuments({ leadId: lead.id })).toBe(1);
    // fast-forward: make it due and run the scheduler
    await TopUpReminder.updateOne({ _id: r!._id }, { $set: { dueAt: new Date(Date.now() - 1000) } });
    await tick(); await tick();
    const agent = await login('agent1');
    const notifs = await request(app).get('/api/v1/notifications?filter=reminders').set(auth(agent.accessToken));
    expect(notifs.body.data.items.map((n: { type: string }) => n.type)).toContain('topup_due');
    expect(await Notification.countDocuments({ type: 'topup_due', leadId: lead.id })).toBe(1);
    const stageNotif = notifs.body.data.items.find((n: { type: string }) => n.type === 'admin_stage');
    expect(stageNotif).toBeUndefined(); // filter=reminders excludes admin actions
    const all = await request(app).get('/api/v1/notifications').set(auth(agent.accessToken));
    expect(all.body.data.items.some((n: { type: string }) => n.type === 'lead_assigned')).toBe(true);
    const done = await request(app).post(`/api/v1/topup-reminders/${r!._id}/complete`).set(auth(agent.accessToken)).send({ outcome: 'interested', notes: 'Wants 2L top-up' });
    expect(done.status).toBe(200); expect(done.body.data.outcome).toBe('interested');
    expect(await Notification.countDocuments({ type: 'topup_due', status: 'completed' })).toBe(1);
    const detail = await request(app).get(`/api/v1/leads/${lead.id}`).set(auth(agent.accessToken));
    expect(detail.body.data.topUp.status).toBe('completed');
  });
  it('follow-up due notifications are generated once and survive re-runs', async () => {
    const s = await seedBasic();
    const due = new Date(Date.now() - 60_000);
    await Lead.create({ orgId: s.org._id, phone: '9000000030', name: 'F', stageId: s.stages[0]._id, ownerId: s.agent1._id, teamId: s.team._id, nextFollowUpAt: due });
    await tick(); await tick();
    expect(await Notification.countDocuments({ type: 'followup_due' })).toBe(1);
    const agent = await login('agent1');
    const count = await request(app).get('/api/v1/notifications/unread-count').set(auth(agent.accessToken));
    expect(count.body.data.unread).toBe(1); expect(count.body.data.popups).toHaveLength(1);
    const id = count.body.data.popups[0].id;
    await request(app).post(`/api/v1/notifications/${id}/snooze`).set(auth(agent.accessToken)).send({ minutes: 60 }).expect(200);
    expect((await request(app).get('/api/v1/notifications/unread-count').set(auth(agent.accessToken))).body.data.unread).toBe(0);
    const other = await login('agent2');
    expect((await request(app).post(`/api/v1/notifications/${id}/dismiss`).set(auth(other.accessToken))).status).toBe(404);
  });
});

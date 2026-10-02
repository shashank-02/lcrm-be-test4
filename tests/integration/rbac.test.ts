import request from 'supertest';
import { app, startDb, stopDb, resetDb, seedBasic, login, auth } from '../helpers/db';
import { Lead } from '../../src/models';

beforeAll(startDb); afterAll(stopDb); beforeEach(resetDb);

async function makeLeads(s: Awaited<ReturnType<typeof seedBasic>>) {
  const mk = (phone: string, owner: { _id: unknown; teamId?: unknown } | null) =>
    Lead.create({ orgId: s.org._id, name: phone, phone, stageId: s.stages[0]._id, ownerId: owner?._id ?? null, teamId: owner?.teamId ?? null, managerId: owner?.teamId && String(owner.teamId) === String(s.team._id) ? s.manager._id : null });
  await mk('9000000001', s.agent1); await mk('9000000002', s.agent1); await mk('9000000003', s.agent2);
  await mk('9000000004', s.outsider); await mk('9000000005', null);
}

describe('data visibility by role', () => {
  it('agent sees only own leads; team lead sees team; manager sees managed teams; admin sees all', async () => {
    const s = await seedBasic(); await makeLeads(s);
    const count = async (u: string) => (await request(app).get('/api/v1/leads').set(auth((await login(u)).accessToken))).body.meta.total;
    expect(await count('agent1')).toBe(2);
    expect(await count('agent2')).toBe(1);
    expect(await count('tl')).toBe(3);
    expect(await count('manager')).toBe(3);
    expect(await count('admin')).toBe(5);
  });
  it('returns 404 for a lead outside scope and blocks forbidden actions', async () => {
    const s = await seedBasic(); await makeLeads(s);
    const outsiderLead = await Lead.findOne({ phone: '9000000004' });
    const agent = await login('agent1');
    expect((await request(app).get(`/api/v1/leads/${outsiderLead!._id}`).set(auth(agent.accessToken))).status).toBe(404);
    const own = await Lead.findOne({ phone: '9000000001' });
    expect((await request(app).delete(`/api/v1/leads/${own!._id}`).set(auth(agent.accessToken))).status).toBe(403);
    expect((await request(app).post(`/api/v1/leads/${own!._id}/assign`).set(auth(agent.accessToken)).send({ ownerId: String(s.agent2._id) })).status).toBe(403);
    expect((await request(app).get('/api/v1/users').set(auth(agent.accessToken))).status).toBe(403);
  });
  it('team lead can assign within team but not to other teams', async () => {
    const s = await seedBasic(); await makeLeads(s);
    const tl = await login('tl');
    const lead = await Lead.findOne({ phone: '9000000001' });
    const okRes = await request(app).post(`/api/v1/leads/${lead!._id}/assign`).set(auth(tl.accessToken)).send({ ownerId: String(s.agent2._id), comment: 'balancing' });
    expect(okRes.status).toBe(200);
    expect(okRes.body.data.owner.id).toBe(String(s.agent2._id));
    const bad = await request(app).post(`/api/v1/leads/${lead!._id}/assign`).set(auth(tl.accessToken)).send({ ownerId: String(s.outsider._id) });
    expect(bad.status).toBe(403);
  });
  it('custom permission template restricts a role', async () => {
    const s = await seedBasic();
    const admin = await login('admin');
    const tpl = await request(app).post('/api/v1/permission-templates').set(auth(admin.accessToken)).send({ name: 'Read only agent', role: 'agent', permissions: ['lead.view'] });
    expect(tpl.status).toBe(201);
    await request(app).patch(`/api/v1/users/${s.agent1._id}`).set(auth(admin.accessToken)).send({ permissionTemplateId: tpl.body.data.id }).expect(200);
    const agent = await login('agent1');
    expect(agent.user.permissions).toEqual(['lead.view']);
    const res = await request(app).post('/api/v1/leads').set(auth(agent.accessToken)).send({ phone: '9111111111', name: 'X' });
    expect(res.status).toBe(403);
  });
  it('deactivating a user requires reassignment when they own leads', async () => {
    const s = await seedBasic(); await makeLeads(s);
    const admin = await login('admin');
    const first = await request(app).post(`/api/v1/users/${s.agent1._id}/deactivate`).set(auth(admin.accessToken)).send({});
    expect(first.status).toBe(409);
    expect(first.body.error.details.leadCount).toBe(2);
    const second = await request(app).post(`/api/v1/users/${s.agent1._id}/deactivate`).set(auth(admin.accessToken)).send({ reassignTo: String(s.agent2._id) });
    expect(second.status).toBe(200);
    expect(second.body.data.reassigned).toBe(2);
    expect(await Lead.countDocuments({ ownerId: s.agent2._id })).toBe(3);
  });
});

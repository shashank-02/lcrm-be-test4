import request from 'supertest';
import { app, startDb, stopDb, resetDb, seedBasic, login, auth } from '../helpers/db';
import { Activity, FieldDefinition, Lead, StageDirective, AssignmentRule } from '../../src/models';

beforeAll(startDb); afterAll(stopDb); beforeEach(resetDb);

describe('leads', () => {
  it('creates a lead, agents auto-own it, duplicates by phone are rejected', async () => {
    const s = await seedBasic();
    const agent = await login('agent1');
    const res = await request(app).post('/api/v1/leads').set(auth(agent.accessToken)).send({ name: 'Arjun', phone: '98765 43210', email: 'a@b.com', sourceId: String(s.source._id) });
    expect(res.status).toBe(201);
    expect(res.body.data.phone).toBe('9876543210');
    expect(res.body.data.owner.id).toBe(agent.user.id);
    expect(res.body.data.stage.name).toBe('Lead');
    const dup = await request(app).post('/api/v1/leads').set(auth(agent.accessToken)).send({ name: 'Dup', phone: '9876543210' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.leadId).toBe(res.body.data.id);
    const check = await request(app).get('/api/v1/leads/check-phone?phone=9876543210').set(auth(agent.accessToken));
    expect(check.body.data.exists).toBe(true);
  });

  it('validates custom fields against admin definitions', async () => {
    const s = await seedBasic();
    await FieldDefinition.create({ orgId: s.org._id, key: 'productType', label: 'Product', type: 'select', options: ['PL', 'HL'], required: true });
    await FieldDefinition.create({ orgId: s.org._id, key: 'amount', label: 'Amount', type: 'currency' });
    const admin = await login('admin');
    const bad = await request(app).post('/api/v1/leads').set(auth(admin.accessToken)).send({ phone: '9000000001', customFields: { productType: 'XX', amount: 'abc' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['customFields.amount', 'customFields.productType']);
    const good = await request(app).post('/api/v1/leads').set(auth(admin.accessToken)).send({ phone: '9000000001', customFields: { productType: 'PL', amount: '250000' } });
    expect(good.status).toBe(201);
    expect(good.body.data.customFields.amount).toBe(250000);
  });

  it('enforces stage directives and logs activities', async () => {
    const s = await seedBasic();
    const logged = s.stages.find((x) => x.name === 'Logged')!;
    await StageDirective.create({ orgId: s.org._id, name: 'Need remark + amount', toStageId: logged._id, requireRemark: true, requiredFields: ['custom.loanAmount'] });
    await FieldDefinition.create({ orgId: s.org._id, key: 'loanAmount', label: 'Loan Amount', type: 'currency' });
    const agent = await login('agent1');
    const lead = (await request(app).post('/api/v1/leads').set(auth(agent.accessToken)).send({ phone: '9000000002', name: 'L' })).body.data;
    const blocked = await request(app).post(`/api/v1/leads/${lead.id}/stage`).set(auth(agent.accessToken)).send({ stageId: String(logged._id) });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('STAGE_DIRECTIVE');
    const moved = await request(app).post(`/api/v1/leads/${lead.id}/stage`).set(auth(agent.accessToken)).send({ stageId: String(logged._id), remarks: 'Docs received', customFields: { loanAmount: 500000 } });
    expect(moved.status).toBe(200);
    expect(moved.body.data.stage.name).toBe('Logged');
    expect(moved.body.data.contactCount).toBe(1);
    const acts = await request(app).get(`/api/v1/leads/${lead.id}/activities`).set(auth(agent.accessToken));
    expect(acts.body.data.map((a: { type: string }) => a.type)).toEqual(['stage_changed', 'assigned', 'created']);
  });

  it('list tabs, status change and follow-up reset permission', async () => {
    const s = await seedBasic();
    const tl = await login('tl');
    const lead = (await request(app).post('/api/v1/leads').set(auth(tl.accessToken)).send({ phone: '9000000003', name: 'T', ownerId: String(s.agent1._id) })).body.data;
    expect(lead.owner.id).toBe(String(s.agent1._id));
    const st = await request(app).post(`/api/v1/leads/${lead.id}/status`).set(auth(tl.accessToken)).send({ statusId: String(s.statuses[0]._id), remarks: 'call later', nextFollowUpAt: new Date().toISOString() });
    expect(st.status).toBe(200);
    const counts = await request(app).get('/api/v1/leads/counts').set(auth(tl.accessToken));
    expect(counts.body.data.contacted_today).toBe(1);
    expect(counts.body.data.assigned_today).toBe(1);
    expect(counts.body.data.followup_today).toBe(1);
    const agent = await login('agent1');
    const reset = await request(app).post(`/api/v1/leads/${lead.id}/followup`).set(auth(agent.accessToken)).send({ nextFollowUpAt: null });
    expect(reset.status).toBe(403);
    expect((await request(app).post(`/api/v1/leads/${lead.id}/followup`).set(auth(tl.accessToken)).send({ nextFollowUpAt: null })).status).toBe(200);
  });

  it('bulk assign with erase history hides prior activity from the new owner', async () => {
    const s = await seedBasic();
    const admin = await login('admin');
    const a = (await request(app).post('/api/v1/leads').set(auth(admin.accessToken)).send({ phone: '9000000004', ownerId: String(s.agent1._id) })).body.data;
    const b = (await request(app).post('/api/v1/leads').set(auth(admin.accessToken)).send({ phone: '9000000005', ownerId: String(s.agent1._id) })).body.data;
    await request(app).post(`/api/v1/leads/${a.id}/notes`).set(auth(admin.accessToken)).send({ body: 'secret history' }).expect(201);
    const bulk = await request(app).post('/api/v1/leads/bulk').set(auth(admin.accessToken)).send({ ids: [a.id, b.id], action: 'assign', payload: { ownerId: String(s.agent2._id), eraseHistory: true } });
    expect(bulk.status).toBe(200);
    expect(bulk.body.data.affected).toBe(2);
    const agent2 = await login('agent2');
    const notes = await request(app).get(`/api/v1/leads/${a.id}/notes`).set(auth(agent2.accessToken));
    expect(notes.body.data).toHaveLength(0);
    const acts = await request(app).get(`/api/v1/leads/${a.id}/activities`).set(auth(agent2.accessToken));
    expect(acts.body.data.every((x: { type: string }) => ['history_erased', 'assigned'].includes(x.type))).toBe(true);
    expect(await Activity.countDocuments({ leadId: a.id, hidden: true })).toBeGreaterThan(0);
  });

  it('soft delete + restore + export', async () => {
    const s = await seedBasic();
    const admin = await login('admin');
    const lead = (await request(app).post('/api/v1/leads').set(auth(admin.accessToken)).send({ phone: '9000000006', name: 'Del', ownerId: String(s.agent1._id) })).body.data;
    await request(app).delete(`/api/v1/leads/${lead.id}`).set(auth(admin.accessToken)).expect(200);
    expect((await request(app).get('/api/v1/leads').set(auth(admin.accessToken))).body.meta.total).toBe(0);
    await request(app).post(`/api/v1/leads/${lead.id}/restore`).set(auth(admin.accessToken)).expect(200);
    const csv = await request(app).get('/api/v1/leads/export').set(auth(admin.accessToken));
    expect(csv.status).toBe(200);
    expect(csv.text.split('\n')).toHaveLength(2);
    expect(csv.text).toContain('9000000006');
  });

  it('applies round-robin assignment rules to unassigned leads', async () => {
    const s = await seedBasic();
    await AssignmentRule.create({ orgId: s.org._id, name: 'RR', strategy: 'round_robin', targetUserIds: [s.agent1._id, s.agent2._id] });
    const admin = await login('admin');
    const owners: string[] = [];
    for (const p of ['9000000010', '9000000011', '9000000012', '9000000013']) {
      const r = await request(app).post('/api/v1/leads').set(auth(admin.accessToken)).send({ phone: p });
      owners.push(r.body.data.owner.id);
    }
    expect(owners.filter((o) => o === String(s.agent1._id))).toHaveLength(2);
    expect(owners.filter((o) => o === String(s.agent2._id))).toHaveLength(2);
    expect(await Lead.countDocuments({ ownerId: null })).toBe(0);
  });

  it('communicate returns deep links and marks the lead contacted', async () => {
    const s = await seedBasic();
    const agent = await login('agent1');
    const lead = (await request(app).post('/api/v1/leads').set(auth(agent.accessToken)).send({ phone: '9876500000', name: 'Wa', email: 'wa@x.io', sourceId: String(s.source._id) })).body.data;
    const wa = await request(app).post(`/api/v1/leads/${lead.id}/communicate`).set(auth(agent.accessToken)).send({ channel: 'whatsapp', message: 'Hello {{name}}' });
    expect(wa.status).toBe(200);
    expect(wa.body.data.link).toBe('https://wa.me/919876500000?text=Hello%20%7B%7Bname%7D%7D');
    const em = await request(app).post(`/api/v1/leads/${lead.id}/communicate`).set(auth(agent.accessToken)).send({ channel: 'email', subject: 'Hi', message: 'Body' });
    expect(em.body.data.link.startsWith('mailto:wa@x.io?subject=Hi&body=Body')).toBe(true);
    const fresh = await request(app).get(`/api/v1/leads/${lead.id}`).set(auth(agent.accessToken));
    expect(fresh.body.data.contactCount).toBe(2);
  });
});

import request from 'supertest';
import mongoose from 'mongoose';
import { app, auth, login, resetDb, seedBasic, startDb, stopDb, FERRET } from '../helpers/db';
import { Lead, Note, Activity } from '../../src/models';
import { migrateIndexes } from '../../src/config/indexes';
import { mailOutbox } from '../../src/services/mail.service';

beforeAll(startDb); afterAll(stopDb); beforeEach(resetDb);

describe('quick note save flow', () => {
  it('saves the note once, updates remarks/activity, and never reports a failure for a saved note — even with a legacy text index and a non-English lead language', async () => {
    const s = await seedBasic();
    const lead = await Lead.create({ orgId: s.org._id, phone: '9000000040', name: 'Ravi', language: 'Kannada', stageId: s.stages[0]._id, ownerId: s.agent1._id, teamId: s.team._id });
    // Recreate the legacy index that caused "language override unsupported" on real MongoDB, then run the migration.
    if (!FERRET) {
      await mongoose.connection.db!.collection('leads').createIndex({ name: 'text', remarks: 'text' }, { name: 'legacy_text' });
      const applied = await migrateIndexes();
      expect(applied).toContain('leads.dropIndex(legacy_text)');
      expect((await mongoose.connection.db!.collection('leads').indexes()).some((i) => i.name === 'legacy_text')).toBe(false);
    }
    const agent = await login('agent1');
    const r = await request(app).post(`/api/v1/leads/${lead._id}/notes`).set(auth(agent.accessToken)).send({ body: 'Customer prefers Kannada' });
    expect(r.status).toBe(201); expect(r.body.data.body).toBe('Customer prefers Kannada');
    expect(await Note.countDocuments({ leadId: lead._id })).toBe(1);
    const fresh = await Lead.findById(lead._id).lean();
    expect(fresh!.remarks).toBe('Customer prefers Kannada'); expect(fresh!.language).toBe('Kannada');
    expect(await Activity.countDocuments({ leadId: lead._id, type: 'note_added' })).toBe(1);
    // the notes list reflects it immediately
    const list = await request(app).get(`/api/v1/leads/${lead._id}/notes`).set(auth(agent.accessToken));
    expect(list.body.data).toHaveLength(1);
  });
  it('a failing secondary update does not turn the saved note into an error', async () => {
    const s = await seedBasic();
    const lead = await Lead.create({ orgId: s.org._id, phone: '9000000041', name: 'Meena', stageId: s.stages[0]._id, ownerId: s.agent1._id, teamId: s.team._id });
    const spy = jest.spyOn(Lead, 'updateOne').mockImplementationOnce(() => { throw new Error('simulated secondary failure'); });
    const agent = await login('agent1');
    const r = await request(app).post(`/api/v1/leads/${lead._id}/notes`).set(auth(agent.accessToken)).send({ body: 'Still saved' });
    spy.mockRestore();
    expect(r.status).toBe(201);
    expect(await Note.countDocuments({ leadId: lead._id })).toBe(1);
  });
});

describe('email configuration & account emails', () => {
  it('mail-status is masked, admin-only, and reports Connected/Not configured', async () => {
    await seedBasic();
    const admin = await login('admin');
    const st = await request(app).get('/api/v1/organisation/mail-status?verify=true').set(auth(admin.accessToken));
    expect(st.status).toBe(200);
    expect(st.body.data).toMatchObject({ provider: 'Not configured', connected: false, status: 'Not configured' });
    expect(JSON.stringify(st.body)).not.toMatch(/SMTP_PASS|"pass"/i);
    expect(st.body.data.senderEmail).toMatch(/\*\*\*\*@/);
  });
  it('emails credentials on account creation / password reset only when asked, and reports delivery honestly', async () => {
    const s = await seedBasic();
    const admin = await login('admin');
    mailOutbox.length = 0;
    const c = await request(app).post('/api/v1/users').set(auth(admin.accessToken)).send({ name: 'New Agent', email: 'new.agent@dbs.test', phone: '9123456780', username: 'newagent', password: 'Welcome123!', role: 'agent', teamId: String(s.team._id), sendCredentials: true });
    expect(c.status).toBe(201);
    expect(mailOutbox).toHaveLength(1); expect(mailOutbox[0].kind).toBe('credentials'); expect(mailOutbox[0].to).toBe('new.agent@dbs.test'); expect(mailOutbox[0].text).toContain('Welcome123!');
    expect(c.body.data.credentialsEmail).toMatchObject({ sent: false }); // log driver in tests → honest "not delivered"
    expect(c.body.data.passwordHash).toBeUndefined();
    const r = await request(app).patch(`/api/v1/users/${c.body.data.id}`).set(auth(admin.accessToken)).send({ password: 'Reset456!', sendCredentials: true });
    expect(r.status).toBe(200); expect(mailOutbox).toHaveLength(2); expect(mailOutbox[1].kind).toBe('password_reset'); expect(mailOutbox[1].text).toContain('Reset456!');
    const quiet = await request(app).patch(`/api/v1/users/${c.body.data.id}`).set(auth(admin.accessToken)).send({ designation: 'Senior agent' });
    expect(quiet.status).toBe(200); expect(mailOutbox).toHaveLength(2); expect(quiet.body.data.credentialsEmail).toBeNull();
  });
});

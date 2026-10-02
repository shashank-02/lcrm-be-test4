import request from 'supertest';
import { app, startDb, stopDb, resetDb, seedBasic, login, auth } from '../helpers/db';
import { FieldDefinition, ImportJob, Lead } from '../../src/models';

beforeAll(startDb); afterAll(stopDb); beforeEach(resetDb);

const waitForJob = async (id: string) => {
  for (let i = 0; i < 50; i++) {
    const job = await ImportJob.findById(id).lean();
    if (job && ['completed', 'failed'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('job did not finish');
};

describe('CSV import', () => {
  it('previews headers and suggests a mapping', async () => {
    await seedBasic();
    const admin = await login('admin');
    const csv = 'Full Name,Mobile Number,Email ID,Lead Source\nArjun,9876543210,a@b.com,Website\n';
    const res = await request(app).post('/api/v1/imports/preview').set(auth(admin.accessToken)).attach('file', Buffer.from(csv), 'leads.csv');
    expect(res.status).toBe(200);
    expect(res.body.data.headers).toEqual(['Full Name', 'Mobile Number', 'Email ID', 'Lead Source']);
    expect(res.body.data.suggestedMapping).toEqual({ 'Full Name': 'name', 'Mobile Number': 'phone', 'Email ID': 'email', 'Lead Source': 'source' });
  });

  it('imports rows, records per-row errors, creates unknown sources, then upserts', async () => {
    const s = await seedBasic();
    await FieldDefinition.create({ orgId: s.org._id, key: 'amount', label: 'Amount', type: 'currency' });
    const admin = await login('admin');
    const csv = ['Name,Phone,Source,Amount,Owner', 'A,9000000001,Website,"2,50,000",agent1@t.io', 'B,9000000002,Facebook,500000,', 'C,bad-phone,Website,1,', 'D,9000000001,Website,2,'].join('\n');
    const mapping = JSON.stringify({ Name: 'name', Phone: 'phone', Source: 'source', Amount: 'custom.amount', Owner: 'owner' });
    const res = await request(app).post('/api/v1/imports').set(auth(admin.accessToken)).field('mapping', mapping).field('importType', 'create').field('applyAssignmentRules', 'false').attach('file', Buffer.from(csv), 'leads.csv');
    expect(res.status).toBe(201);
    const job = await waitForJob(res.body.data.id);
    expect(job.status).toBe('completed');
    expect(job.totals).toMatchObject({ rows: 4, created: 2, errored: 2 });
    expect(job.rowErrors.map((e) => e.row).sort()).toEqual([4, 5]);
    const a = await Lead.findOne({ phone: '9000000001' }).lean();
    expect(a?.customFields).toEqual({ amount: 250000 });
    expect(String(a?.ownerId)).toBe(String(s.agent1._id));
    expect(String(a?.teamId)).toBe(String(s.team._id));
    const errCsv = await request(app).get(`/api/v1/imports/${job._id}/errors.csv`).set(auth(admin.accessToken));
    expect(errCsv.text.split('\n')).toHaveLength(3);

    // upsert mode updates existing rows instead of erroring
    const csv2 = 'Phone,Name\n9000000001,A updated\n9000000009,New\n';
    const res2 = await request(app).post('/api/v1/imports').set(auth(admin.accessToken)).field('mapping', JSON.stringify({ Phone: 'phone', Name: 'name' })).field('importType', 'upsert').attach('file', Buffer.from(csv2), 'leads2.csv');
    const job2 = await waitForJob(res2.body.data.id);
    expect(job2.totals).toMatchObject({ created: 1, updated: 1, errored: 0 });
    expect((await Lead.findOne({ phone: '9000000001' }).lean())?.name).toBe('A updated');
  });

  it('requires a phone mapping and lead.import permission', async () => {
    await seedBasic();
    const admin = await login('admin');
    const res = await request(app).post('/api/v1/imports').set(auth(admin.accessToken)).field('mapping', JSON.stringify({ Name: 'name' })).attach('file', Buffer.from('Name\nX\n'), 'x.csv');
    expect(res.status).toBe(400);
    const agent = await login('agent1');
    expect((await request(app).post('/api/v1/imports/preview').set(auth(agent.accessToken)).attach('file', Buffer.from('a\n1'), 'x.csv')).status).toBe(403);
  });
});

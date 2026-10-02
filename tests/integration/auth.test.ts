import request from 'supertest';
import { app, startDb, stopDb, resetDb, seedBasic, login, auth } from '../helpers/db';

beforeAll(startDb); afterAll(stopDb); beforeEach(resetDb);

describe('auth', () => {
  it('logs in with email, username or phone and returns permissions', async () => {
    const s = await seedBasic();
    for (const id of ['agent1@t.io', 'agent1', s.agent1.phone]) {
      const res = await request(app).post('/api/v1/auth/login').send({ identifier: id, password: 'Passw0rd!' });
      expect(res.status).toBe(200);
      expect(res.body.data.user.role).toBe('agent');
      expect(res.body.data.user.permissions).toContain('lead.view');
      expect(res.body.data.user.permissions).not.toContain('lead.delete');
    }
  });
  it('rejects bad credentials and inactive users', async () => {
    const s = await seedBasic();
    expect((await request(app).post('/api/v1/auth/login').send({ identifier: 'agent1', password: 'nope' })).status).toBe(401);
    s.agent1.isActive = false; await s.agent1.save();
    expect((await request(app).post('/api/v1/auth/login').send({ identifier: 'agent1', password: 'Passw0rd!' })).status).toBe(401);
  });
  it('rotates refresh tokens and revokes the old one', async () => {
    await seedBasic();
    const { refreshToken } = await login('admin');
    const r1 = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.data.accessToken).toBeTruthy();
    const r2 = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(r2.status).toBe(401);
    const me = await request(app).get('/api/v1/auth/me').set(auth(r1.body.data.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.data.role).toBe('admin');
  });
  it('protects routes and admin has every permission', async () => {
    await seedBasic();
    expect((await request(app).get('/api/v1/leads')).status).toBe(401);
    const { accessToken, user } = await login('admin');
    expect(user.permissions).toContain('admin.permissions');
    const boot = await request(app).get('/api/v1/bootstrap').set(auth(accessToken));
    expect(boot.status).toBe(200);
    expect(boot.body.data.stages).toHaveLength(4);
  });
});

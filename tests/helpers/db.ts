import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../../src/app';
import { Organisation, PermissionTemplate, Source, Stage, Status, Team, User } from '../../src/models';
import { DEFAULT_ROLE_PERMISSIONS } from '../../src/common/permissions';

let mongo: MongoMemoryServer | null = null;
export const app = createApp();

/**
 * Tests run against an in-memory MongoDB by default. Set MONGO_TEST_URI to use an external server instead
 * (e.g. a real mongod, or FerretDB in sandboxes that cannot download the Mongo binary). Each test file gets its own
 * database name so files can run in parallel.
 */
export const EXTERNAL_DB = !!process.env.MONGO_TEST_URI;
/** True when the external server is FerretDB (no $lookup/$facet/partial indexes); tests needing those skip. */
export const FERRET = process.env.MONGO_TEST_FLAVOUR === 'ferret';
export const itMongo = FERRET ? it.skip : it;
export const describeMongo = FERRET ? describe.skip : describe;

export async function startDb() {
  if (EXTERNAL_DB) {
    const name = `t_${process.env.JEST_WORKER_ID ?? '0'}_${Math.random().toString(36).slice(2, 8)}`;
    await mongoose.connect(`${process.env.MONGO_TEST_URI!.replace(/\/$/, '')}/${name}`, { serverSelectionTimeoutMS: 10_000 });
    return;
  }
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}
export async function stopDb() {
  if (EXTERNAL_DB) { try { await mongoose.connection.db?.dropDatabase(); } catch { /* ignore */ } }
  await mongoose.disconnect();
  await mongo?.stop();
}
export async function resetDb() {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

/** Org with admin, manager, team lead and two agents in one team, plus pipeline basics. */
export async function seedBasic() {
  const org = await Organisation.create({ name: 'Test Org', slug: 'test-org' });
  const hash = await bcrypt.hash('Passw0rd!', 4);
  for (const role of ['branch_manager', 'team_lead', 'agent'] as const) {
    await PermissionTemplate.create({ orgId: org._id, role, name: `${role} default`, isSystem: true, isDefault: true, permissions: DEFAULT_ROLE_PERMISSIONS[role] });
  }
  const mk = (name: string, role: string, teamId: unknown = null) =>
    User.create({ orgId: org._id, name, email: `${name}@t.io`, phone: `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`, username: name, passwordHash: hash, role, teamId });
  const admin = await mk('admin', 'admin');
  const manager = await mk('manager', 'branch_manager');
  const team = await Team.create({ orgId: org._id, name: 'Team A', managerId: manager._id });
  const otherTeam = await Team.create({ orgId: org._id, name: 'Team B' });
  const tl = await mk('tl', 'team_lead', team._id);
  team.teamLeadId = tl._id; await team.save();
  const agent1 = await mk('agent1', 'agent', team._id);
  const agent2 = await mk('agent2', 'agent', team._id);
  const outsider = await mk('outsider', 'agent', otherTeam._id);
  const stages = await Stage.insertMany(['Lead', 'Prospect', 'Logged', 'Approved'].map((name, i) => ({ orgId: org._id, name, order: i, isWon: name === 'Approved' })));
  const statuses = await Status.insertMany(['Callback', 'Interested', 'Not Interested'].map((name, i) => ({ orgId: org._id, name, order: i })));
  const source = await Source.create({ orgId: org._id, name: 'Website' });
  return { org, admin, manager, tl, agent1, agent2, outsider, team, otherTeam, stages, statuses, source };
}

export async function login(identifier: string, password = 'Passw0rd!') {
  const res = await request(app).post('/api/v1/auth/login').send({ identifier, password });
  if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.body)}`);
  return res.body.data as { accessToken: string; refreshToken: string; user: { id: string; permissions: string[] } };
}
export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

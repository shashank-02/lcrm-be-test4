import { Types } from 'mongoose';
import { leadScope, visibleTeamIds } from '../../src/services/scope.service';
import type { AuthUser } from '../../src/common/types';

const org = new Types.ObjectId().toString();
const mk = (over: Partial<AuthUser>): AuthUser => ({ id: new Types.ObjectId().toString(), orgId: org, name: 'x', email: 'x@x', role: 'agent', teamId: null, managedTeamIds: [], permissions: new Set(), timezone: 'Asia/Kolkata', ...over });

describe('leadScope', () => {
  it('admin sees whole org', () => {
    const f = leadScope(mk({ role: 'admin' }));
    expect(String(f.orgId)).toBe(org); expect(f.isDeleted).toBe(false); expect(f.$or).toBeUndefined(); expect(f.ownerId).toBeUndefined();
  });
  it('agent sees only own leads', () => {
    const u = mk({ role: 'agent' });
    expect(String(leadScope(u).ownerId)).toBe(u.id);
  });
  it('team lead sees team leads plus own', () => {
    const t = new Types.ObjectId().toString();
    const f = leadScope(mk({ role: 'team_lead', teamId: t, permissions: new Set(['lead.view_team']) })) as { $or: Record<string, unknown>[] };
    expect(f.$or).toHaveLength(2);
    expect((f.$or[0].teamId as { $in: Types.ObjectId[] }).$in.map(String)).toEqual([t]);
  });
  it('branch manager sees managed teams', () => {
    const a = new Types.ObjectId().toString(), b = new Types.ObjectId().toString();
    const f = leadScope(mk({ role: 'branch_manager', managedTeamIds: [a, b], permissions: new Set(['lead.view_team']) })) as { $or: Record<string, unknown>[] };
    expect((f.$or[0].teamId as { $in: Types.ObjectId[] }).$in.map(String).sort()).toEqual([a, b].sort());
  });
  it('visibleTeamIds is null for admin and de-duplicates for others', () => {
    expect(visibleTeamIds(mk({ role: 'admin' }))).toBeNull();
    const t = new Types.ObjectId().toString();
    expect(visibleTeamIds(mk({ role: 'team_lead', teamId: t, managedTeamIds: [t], permissions: new Set(['lead.view_team']) }))).toEqual([t]);
  });
  it('team lead without lead.view_team falls back to own leads only', () => {
    const u = mk({ role: 'team_lead', teamId: new Types.ObjectId().toString() });
    expect(String(leadScope(u).ownerId)).toBe(u.id);
  });
});

import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, isPermissionKey } from '../../src/common/permissions';
import { hasPermission } from '../../src/middleware/auth';

describe('permission catalogue', () => {
  it('has unique keys', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });
  it('role defaults are nested: agent ⊂ team lead ⊂ manager ⊂ admin', () => {
    const inc = (a: string[], b: string[]) => a.every((k) => b.includes(k));
    expect(inc(DEFAULT_ROLE_PERMISSIONS.agent, DEFAULT_ROLE_PERMISSIONS.team_lead)).toBe(true);
    expect(inc(DEFAULT_ROLE_PERMISSIONS.team_lead, DEFAULT_ROLE_PERMISSIONS.branch_manager)).toBe(true);
    expect(inc(DEFAULT_ROLE_PERMISSIONS.branch_manager, DEFAULT_ROLE_PERMISSIONS.admin)).toBe(true);
  });
  it('agents cannot delete or import by default', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.agent).not.toContain('lead.delete');
    expect(DEFAULT_ROLE_PERMISSIONS.agent).not.toContain('lead.import');
    expect(DEFAULT_ROLE_PERMISSIONS.agent).toContain('lead.communicate');
  });
  it('validates keys and admin bypass', () => {
    expect(isPermissionKey('lead.view')).toBe(true);
    expect(isPermissionKey('lead.hack')).toBe(false);
    expect(hasPermission({ role: 'admin', permissions: new Set() }, 'anything')).toBe(true);
    expect(hasPermission({ role: 'agent', permissions: new Set(['lead.view']) }, 'lead.delete')).toBe(false);
  });
});

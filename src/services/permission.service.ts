import { PermissionTemplate, Team, User, Organisation } from '../models';
import { DEFAULT_ROLE_PERMISSIONS, ALL_PERMISSIONS } from '../common/permissions';
import type { AuthUser, Role } from '../common/types';

/**
 * Resolve the effective permission set for a user:
 *  - Admins receive every permission (cannot be locked out of the admin panel).
 *  - Otherwise: the user's assigned template, else the org default template for the role,
 *    else the hard-coded role defaults.
 */
export async function resolvePermissions(user: {
  _id: unknown;
  orgId: unknown;
  role: Role;
  teamId?: unknown;
  permissionTemplateId?: unknown;
}): Promise<Set<string>> {
  if (user.role === 'admin') return new Set(ALL_PERMISSIONS);
  if (user.permissionTemplateId) {
    const tpl = await PermissionTemplate.findOne({ _id: user.permissionTemplateId, orgId: user.orgId }).lean();
    if (tpl) return new Set(tpl.permissions);
  }
  // Team-level default (Project Administration → Teams → permission template)
  if (user.teamId) {
    const team = await Team.findById(user.teamId).select('permissionTemplateId').lean();
    if (team?.permissionTemplateId) {
      const tpl = await PermissionTemplate.findOne({ _id: team.permissionTemplateId, orgId: user.orgId, role: user.role }).lean();
      if (tpl) return new Set(tpl.permissions);
    }
  }
  const def = await PermissionTemplate.findOne({ orgId: user.orgId, role: user.role, isDefault: true }).lean();
  if (def) return new Set(def.permissions);
  return new Set(DEFAULT_ROLE_PERMISSIONS[user.role]);
}

/** Builds the AuthUser attached to every authenticated request. */
export async function buildAuthUser(userId: string): Promise<AuthUser | null> {
  const user = await User.findById(userId).lean();
  if (!user || !user.isActive) return null;
  const [permissions, org, managed] = await Promise.all([
    resolvePermissions(user),
    Organisation.findById(user.orgId).select('timezone').lean(),
    user.role === 'branch_manager'
      ? Team.find({ orgId: user.orgId, managerId: user._id, isActive: true }).select('_id').lean()
      : user.role === 'team_lead'
        ? Team.find({ orgId: user.orgId, $or: [{ teamLeadId: user._id }, { _id: user.teamId }], isActive: true })
            .select('_id')
            .lean()
        : Promise.resolve([]),
  ]);
  return {
    id: String(user._id),
    orgId: String(user.orgId),
    name: user.name,
    email: user.email,
    role: user.role,
    teamId: user.teamId ? String(user.teamId) : null,
    managedTeamIds: managed.map((t) => String(t._id)),
    permissions,
    timezone: org?.timezone ?? 'Asia/Kolkata',
  };
}

import type { FilterQuery } from 'mongoose';
import { Types } from 'mongoose';
import type { AuthUser } from '../common/types';
import { Team, User } from '../models';

const oid = (s: string) => new Types.ObjectId(s);

/**
 * Data-visibility filter for leads, derived from the role hierarchy:
 *  admin           -> whole organisation
 *  branch_manager  -> leads in teams they manage (+ their own)
 *  team_lead       -> leads in their team (+ their own)
 *  agent           -> leads they own
 */
export function leadScope(user: AuthUser): FilterQuery<Record<string, unknown>> {
  const base = { orgId: oid(user.orgId), isDeleted: false };
  switch (user.role) {
    case 'admin':
      return base;
    case 'branch_manager': {
      if (!user.permissions.has('lead.view_team')) return { ...base, ownerId: oid(user.id) };
      return { ...base, $or: [{ teamId: { $in: user.managedTeamIds.map(oid) } }, { ownerId: oid(user.id) }] };
    }
    case 'team_lead': {
      if (!user.permissions.has('lead.view_team')) return { ...base, ownerId: oid(user.id) };
      const teams = new Set(user.managedTeamIds);
      if (user.teamId) teams.add(user.teamId);
      return { ...base, $or: [{ teamId: { $in: Array.from(teams).map(oid) } }, { ownerId: oid(user.id) }] };
    }
    case 'agent':
    default:
      return { ...base, ownerId: oid(user.id) };
  }
}

/** Ids of teams the user can see. `null` means all teams. */
export function visibleTeamIds(user: AuthUser): string[] | null {
  if (user.role === 'admin') return null;
  if (!user.permissions.has('lead.view_team')) return user.teamId ? [user.teamId] : [];
  const set = new Set(user.managedTeamIds);
  if (user.teamId) set.add(user.teamId);
  return Array.from(set);
}

/** Users the current user may see / assign leads to. */
export async function assignableUsers(user: AuthUser) {
  const filter: FilterQuery<Record<string, unknown>> = { orgId: oid(user.orgId), isActive: true };
  const teams = visibleTeamIds(user);
  if (user.role === 'agent') filter._id = oid(user.id);
  else if (teams) filter.$or = [{ teamId: { $in: teams.map(oid) } }, { _id: oid(user.id) }];
  return User.find(filter).select('name email role teamId avatarColor').sort({ name: 1 }).lean();
}

export async function canAssignTo(user: AuthUser, targetUserId: string): Promise<boolean> {
  if (user.role === 'admin') return true;
  if (user.role === 'agent') return false;
  const target = await User.findOne({ _id: targetUserId, orgId: user.orgId, isActive: true }).select('teamId').lean();
  if (!target) return false;
  const teams = visibleTeamIds(user) ?? [];
  return !!target.teamId && teams.includes(String(target.teamId));
}

/** Resolve ownership triple (owner -> team -> manager) from a user id. */
export async function ownershipFor(orgId: string, ownerId: string | null) {
  if (!ownerId) return { ownerId: null, teamId: null, managerId: null };
  const owner = await User.findOne({ _id: ownerId, orgId }).select('teamId').lean();
  if (!owner) return { ownerId: null, teamId: null, managerId: null };
  const team = owner.teamId ? await Team.findById(owner.teamId).select('managerId').lean() : null;
  return { ownerId: oid(ownerId), teamId: owner.teamId ?? null, managerId: team?.managerId ?? null };
}

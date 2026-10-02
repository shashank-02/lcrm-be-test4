import type { AuthUser } from '../common/types';
import type { FilterQuery } from 'mongoose';
import { Types } from 'mongoose';

export interface Audience { all?: boolean; roles?: string[]; teamIds?: (Types.ObjectId | string)[]; userIds?: (Types.ObjectId | string)[] }

/** Maps a role to the audience group name used in documents/training visibility. */
export const roleGroup = (role: string) => (role === 'admin' ? 'admins' : role === 'agent' ? 'agents' : 'managers');

/**
 * Visibility decision for documents, folders and training items.
 * Admins see everything. Otherwise the user must match at least one selected audience dimension,
 * and when both a role group AND teams are selected they must match BOTH (role + team combination).
 */
export function canSee(user: AuthUser, aud: Audience | null | undefined): boolean {
  if (user.role === 'admin') return true;
  if (!aud) return false;
  if (aud.all) return true;
  const userIds = (aud.userIds ?? []).map(String);
  if (userIds.includes(user.id)) return true;
  const roles = aud.roles ?? [];
  const teams = (aud.teamIds ?? []).map(String);
  const myTeams = new Set([user.teamId, ...user.managedTeamIds].filter(Boolean) as string[]);
  const roleOk = roles.includes(roleGroup(user.role));
  const teamOk = teams.some((t) => myTeams.has(t));
  if (roles.length && teams.length) return roleOk && teamOk;
  if (roles.length) return roleOk;
  if (teams.length) return teamOk;
  return false;
}

/** Mongo filter equivalent of canSee() for list queries. */
export function audienceFilter(user: AuthUser): FilterQuery<Record<string, unknown>> {
  if (user.role === 'admin') return {};
  const myTeams = [user.teamId, ...user.managedTeamIds].filter(Boolean).map((t) => new Types.ObjectId(t as string));
  const group = roleGroup(user.role);
  return {
    $or: [
      { 'audience.all': true },
      { 'audience.userIds': new Types.ObjectId(user.id) },
      // role only (no team restriction)
      { 'audience.roles': group, 'audience.teamIds': { $size: 0 } },
      // team only
      { 'audience.teamIds': { $in: myTeams }, 'audience.roles': { $size: 0 } },
      // role + team
      { 'audience.roles': group, 'audience.teamIds': { $in: myTeams } },
    ],
  };
}

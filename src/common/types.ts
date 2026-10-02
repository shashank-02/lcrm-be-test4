export const ROLES = ['admin', 'branch_manager', 'team_lead', 'agent'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  branch_manager: 'Branch Manager',
  team_lead: 'Team Lead',
  agent: 'Calling Agent',
};

/** Rank used for "can manage" checks — lower is more powerful. */
export const ROLE_RANK: Record<Role, number> = { admin: 1, branch_manager: 2, team_lead: 3, agent: 4 };

export interface AuthUser {
  id: string;
  orgId: string;
  name: string;
  email: string;
  role: Role;
  teamId: string | null;
  /** Teams this user manages (branch managers) or leads (team leads). */
  managedTeamIds: string[];
  permissions: Set<string>;
  timezone: string;
  sessionId?: string | null;
}

import type { Role } from './types';

/**
 * Single source of truth for feature permissions.
 * Keys are stored in permission templates; the frontend mirrors this catalogue.
 */
export const PERMISSION_CATALOGUE = {
  Leads: {
    'lead.view': 'View leads',
    'lead.create': 'Create lead',
    'lead.edit': 'Edit lead details',
    'lead.delete': 'Delete lead',
    'lead.assign': 'Assign / reassign owner',
    'lead.update_stage': 'Update stage',
    'lead.update_status': 'Update status',
    'lead.update_source': 'Update source',
    'lead.reset_followup': 'Reset follow-up',
    'lead.export': 'Export leads (CSV)',
    'lead.import': 'Bulk import leads',
    'lead.erase_history': 'Erase history when reassigning',
    'lead.communicate': 'WhatsApp / Email / Call',
    'lead.view_team': 'View team / subordinate agents\' leads',
    'lead.edit_subordinates': 'Edit subordinate agents\' leads',
    'context.view': 'See authorised teams / members in the context dropdown',
    'context.switch': 'Switch the lead list between teams / members',
  },
  'Bulk actions': {
    'lead.bulk_assign': 'Bulk assign',
    'lead.bulk_update': 'Bulk update stage / status / source / field',
    'lead.bulk_delete': 'Bulk delete',
    'lead.bulk_communicate': 'Bulk WhatsApp / Email templates',
  },
  Activities: {
    'activity.view': 'View activity timeline',
    'note.view': 'View notes',
    'note.create': 'Add notes',
    'note.edit': 'Edit notes',
    'note.delete': 'Delete notes',
    'task.view': 'View tasks',
    'task.create': 'Create tasks',
    'task.edit': 'Edit / complete tasks',
    'task.delete': 'Delete tasks',
    'call.view': 'View call logs',
    'call.create': 'Log calls',
    'file.view': 'View documents',
    'file.upload': 'Upload documents',
    'file.delete': 'Delete documents',
    'notification.view': 'Notification centre',
    'topup.view': 'View top-up follow-up reminders',
    'topup.action': 'Complete / snooze top-up reminders',
  },
  'Files corner': {
    'files.view': 'View permitted documents',
    'files.download': 'Download documents',
    'files.manage': 'Upload, edit, delete documents & folders, set visibility',
  },
  Training: {
    'training.view': 'View permitted training',
    'training.manage': 'Add, edit, delete training & categories',
    'training.view_progress': 'View completion of other users',
  },
  Reports: {
    'report.view_own': 'Own performance',
    'report.view_team': 'Team reports',
    'report.view_org': 'Organisation-wide reports',
  },
  Administration: {
    'admin.settings': 'Organisation settings',
    'admin.users': 'Manage users',
    'admin.teams': 'Manage teams',
    'admin.permissions': 'Manage permission templates',
    'admin.pipeline': 'Manage stages, statuses, sources, directives',
    'admin.fields': 'Manage lead fields & views',
    'admin.templates': 'Manage message templates',
    'admin.assignment_rules': 'Manage assignment rules',
    'admin.imports': 'View all import history',
    'admin.project': 'Project administration',
    'admin.audit': 'View audit log',
    'admin.profiles': 'Edit other members\' profiles',
  },
} as const;

export type PermissionKey = {
  [G in keyof typeof PERMISSION_CATALOGUE]: keyof (typeof PERMISSION_CATALOGUE)[G];
}[keyof typeof PERMISSION_CATALOGUE];

export const ALL_PERMISSIONS: PermissionKey[] = Object.values(PERMISSION_CATALOGUE).flatMap(
  (g) => Object.keys(g) as PermissionKey[],
);

export const isPermissionKey = (k: string): k is PermissionKey => (ALL_PERMISSIONS as string[]).includes(k);

const agentBase: PermissionKey[] = [
  'lead.view', 'lead.create', 'lead.edit', 'lead.update_stage', 'lead.update_status', 'lead.communicate',
  'activity.view', 'note.view', 'note.create', 'task.view', 'task.create', 'task.edit',
  'call.view', 'call.create', 'file.view', 'file.upload', 'report.view_own',
  'notification.view', 'topup.view', 'topup.action', 'files.view', 'training.view',
];

const teamLeadBase: PermissionKey[] = [
  ...agentBase, 'lead.assign', 'lead.update_source', 'lead.reset_followup', 'lead.bulk_update',
  'lead.bulk_communicate', 'lead.bulk_assign', 'note.edit', 'note.delete', 'task.delete', 'file.delete', 'report.view_team',
  'lead.view_team', 'lead.edit_subordinates', 'context.view', 'context.switch', 'training.view_progress',
];

const managerBase: PermissionKey[] = [
  ...teamLeadBase, 'lead.delete', 'lead.export', 'lead.import', 'lead.bulk_delete', 'lead.erase_history',
];

/** Default (system) permission templates seeded per role. Admin has every permission implicitly. */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, PermissionKey[]> = {
  admin: ALL_PERMISSIONS,
  branch_manager: Array.from(new Set(managerBase)),
  team_lead: Array.from(new Set(teamLeadBase)),
  agent: agentBase,
};

/** Applied to system (default) templates on seed so already-deployed orgs pick up policy changes. */
export const PERMISSION_MIGRATIONS: { role: Role; add: PermissionKey[]; remove: PermissionKey[] }[] = [
  { role: 'agent', add: ['notification.view', 'topup.view', 'topup.action', 'files.view', 'training.view'], remove: ['note.edit', 'note.delete'] },
  { role: 'team_lead', add: ['notification.view', 'topup.view', 'topup.action', 'files.view', 'training.view', 'lead.view_team', 'lead.edit_subordinates', 'context.view', 'context.switch', 'training.view_progress', 'note.edit'], remove: [] },
  { role: 'branch_manager', add: ['notification.view', 'topup.view', 'topup.action', 'files.view', 'training.view', 'lead.view_team', 'lead.edit_subordinates', 'context.view', 'context.switch', 'training.view_progress', 'note.edit'], remove: [] },
];

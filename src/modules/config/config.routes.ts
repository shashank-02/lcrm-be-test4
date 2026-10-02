import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { crudRouter } from '../../common/crud';
import { conflict, badRequest } from '../../common/errors';
import { ROLES } from '../../common/types';
import {
  Stage, Status, Source, StageDirective, MessageTemplate, FieldDefinition, ListView, AssignmentRule, Lead,
  FIELD_TYPES, TEMPLATE_CHANNELS, ASSIGNMENT_STRATEGIES,
} from '../../models';

const objectId = z.string().refine((v) => Types.ObjectId.isValid(v), 'Invalid id');
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #185FA5');

const leadCountGuard = (field: string, label: string) => async (doc: Record<string, unknown>) => {
  const n = await Lead.countDocuments({ orgId: doc.orgId, [field]: doc._id, isDeleted: false });
  if (n > 0) throw conflict(`${label} is used by ${n} lead(s). Deactivate it instead of deleting.`, { inUse: n });
};

// ---------- Stages ----------
const stageCreate = z.object({
  name: z.string().min(1).max(60),
  order: z.number().int().optional(),
  color: color.optional(),
  isWon: z.boolean().optional(),
  isLost: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export const stagesRouter = crudRouter({
  model: Stage, entityName: 'Stage', createSchema: stageCreate, updateSchema: stageCreate.partial(),
  managePermission: 'admin.pipeline', supportsReorder: true, beforeDelete: leadCountGuard('stageId', 'Stage'),
});

// ---------- Statuses ----------
const statusCreate = z.object({
  name: z.string().min(1).max(60),
  stageIds: z.array(objectId).optional(),
  subStatuses: z.array(z.string().min(1).max(60)).max(30).optional(),
  color: color.optional(),
  order: z.number().int().optional(),
  isActive: z.boolean().optional(),
});
export const statusesRouter = crudRouter({
  model: Status, entityName: 'Status', createSchema: statusCreate, updateSchema: statusCreate.partial(),
  managePermission: 'admin.pipeline', supportsReorder: true, beforeDelete: leadCountGuard('statusId', 'Status'),
});

// ---------- Sources ----------
const sourceCreate = z.object({ name: z.string().min(1).max(60), isActive: z.boolean().optional() });
export const sourcesRouter = crudRouter({
  model: Source, entityName: 'Source', createSchema: sourceCreate, updateSchema: sourceCreate.partial(),
  managePermission: 'admin.pipeline', sort: { name: 1 }, beforeDelete: leadCountGuard('sourceId', 'Source'),
});

// ---------- Stage directives ----------
const directiveCreate = z.object({
  name: z.string().min(1).max(80),
  fromStageId: objectId.nullable().optional(),
  toStageId: objectId,
  requiredFields: z.array(z.string()).optional(),
  requireRemark: z.boolean().optional(),
  requireNextFollowUp: z.boolean().optional(),
  allowedRoles: z.array(z.enum(ROLES)).optional(),
  isActive: z.boolean().optional(),
});
export const directivesRouter = crudRouter({
  model: StageDirective, entityName: 'Stage directive', createSchema: directiveCreate,
  updateSchema: directiveCreate.partial(), managePermission: 'admin.pipeline', sort: { createdAt: 1 },
});

// ---------- Message templates ----------
const templateCreate = z.object({
  name: z.string().min(1).max(80),
  channel: z.enum(TEMPLATE_CHANNELS),
  subject: z.string().max(200).optional(),
  body: z.string().min(1).max(5000),
  isActive: z.boolean().optional(),
});
export const templatesRouter = crudRouter({
  model: MessageTemplate, entityName: 'Template', createSchema: templateCreate,
  updateSchema: templateCreate.partial(), managePermission: 'admin.templates', sort: { channel: 1, name: 1 },
});

// ---------- Field definitions ----------
const fieldCreate = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,59}$/, 'Key must start with a letter and contain only letters, numbers, underscores'),
  label: z.string().min(1).max(100),
  type: z.enum(FIELD_TYPES).optional(),
  options: z.array(z.string()).optional(),
  tab: z.string().min(1).max(60).optional(),
  section: z.string().min(1).max(80).optional(),
  order: z.number().int().optional(),
  required: z.boolean().optional(),
  showInList: z.boolean().optional(),
  showInCreate: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  placeholder: z.string().max(120).optional(),
  helpText: z.string().max(300).optional(),
  isActive: z.boolean().optional(),
});
export const fieldsRouter = crudRouter({
  model: FieldDefinition, entityName: 'Field', createSchema: fieldCreate,
  updateSchema: fieldCreate.omit({ key: true }).partial(), managePermission: 'admin.fields',
  sort: { tab: 1, section: 1, order: 1 }, supportsReorder: true,
  beforeSave: async (data) => {
    if ((data.type === 'select' || data.type === 'multiselect') && !(data.options as string[] | undefined)?.length) {
      throw badRequest('Select fields need at least one option');
    }
  },
});

// ---------- Saved list views ----------
const viewCreate = z.object({
  name: z.string().min(1).max(60),
  columns: z.array(z.string()).optional(),
  filters: z.record(z.unknown()).optional(),
  baseTab: z.enum(['all', 'contacted_today', 'assigned_today', 'created_today', 'followup_today', 'overdue', 'unassigned', 'today_list', 'custom']).optional(),
  roles: z.array(z.enum(ROLES)).optional(),
  teamIds: z.array(objectId).optional(),
  groupId: objectId.nullable().optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  personal: z.boolean().optional(),
  order: z.number().int().optional(),
});
export const viewsRouter = crudRouter({
  model: ListView, entityName: 'View tab', createSchema: viewCreate, updateSchema: viewCreate.partial(),
  managePermission: 'admin.project', supportsReorder: true,
  beforeSave: async (data, req, existing) => {
    if (data.personal) data.userId = req.user!.id;
    delete data.personal;
    if (data.isDefault) await ListView.updateMany({ orgId: req.user!.orgId, userId: null, _id: { $ne: existing?._id } }, { $set: { isDefault: false } });
  },
  beforeDelete: async (doc) => { if (doc.isSystem) throw conflict('Built-in tabs cannot be deleted. Deactivate the tab instead.'); },
});

// ---------- Assignment rules ----------
const ruleCreate = z.object({
  name: z.string().min(1).max(80),
  priority: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  conditions: z
    .object({
      sourceIds: z.array(objectId).optional(),
      stageIds: z.array(objectId).optional(),
      cities: z.array(z.string()).optional(),
      states: z.array(z.string()).optional(),
    })
    .optional(),
  strategy: z.enum(ASSIGNMENT_STRATEGIES).optional(),
  targetUserIds: z.array(objectId).optional(),
  targetTeamId: objectId.nullable().optional(),
});
export const rulesRouter = crudRouter({
  model: AssignmentRule, entityName: 'Assignment rule', createSchema: ruleCreate, updateSchema: ruleCreate.partial(),
  managePermission: 'admin.assignment_rules', sort: { priority: 1 },
  beforeSave: async (data, _req, existing) => {
    const users = (data.targetUserIds ?? existing?.targetUserIds ?? []) as unknown[];
    const team = data.targetTeamId ?? existing?.targetTeamId;
    if (!users.length && !team) throw badRequest('Choose target users or a target team');
  },
});

export const configRouter = Router();
configRouter.use('/stages', stagesRouter);
configRouter.use('/statuses', statusesRouter);
configRouter.use('/sources', sourcesRouter);
configRouter.use('/stage-directives', directivesRouter);
configRouter.use('/templates', templatesRouter);
configRouter.use('/fields', fieldsRouter);
configRouter.use('/views', viewsRouter);
configRouter.use('/assignment-rules', rulesRouter);

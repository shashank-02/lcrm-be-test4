import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { asyncHandler, ok } from '../../common/http';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/auth';
import { crudRouter, normalise } from '../../common/crud';
import { paginationQuery, toSkipLimit, buildMeta } from '../../common/pagination';
import { AuditLog, FbConversionEvent, PrioritizationRule, User, ViewGroup, ListView, PRIORITY_FACTORS, PRIORITY_OPERATORS, FB_TRIGGERS } from '../../models';
import { encryptField } from '../../services/crypto.service';
import { invalidateRuleCache, recomputeAllPriorities } from '../../services/prioritization.service';
import { audit } from '../../services/audit.service';

const objectId = z.string().refine((v) => Types.ObjectId.isValid(v), 'Invalid id');

// ---------- Audit log ----------
export const auditRouter = Router();
const auditQuery = paginationQuery.extend({ entity: z.string().max(40).optional(), userId: z.string().optional(), action: z.string().max(60).optional(), from: z.string().optional(), to: z.string().optional() });
auditRouter.get('/', requirePermission('admin.audit'), validate({ query: auditQuery }), asyncHandler(async (req, res) => {
  const q = req.query as unknown as z.infer<typeof auditQuery>;
  const f: Record<string, unknown> = { orgId: req.user!.orgId };
  if (q.entity) f.entity = q.entity; if (q.action) f.action = new RegExp(`^${q.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  if (q.userId && Types.ObjectId.isValid(q.userId)) f.userId = q.userId;
  if (q.from || q.to) f.createdAt = { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? { $lte: new Date(q.to) } : {}) };
  const [items, total] = await Promise.all([AuditLog.find(f).sort({ createdAt: -1 }).skip(toSkipLimit(q).skip).limit(q.limit).lean(), AuditLog.countDocuments(f)]);
  const users = await User.find({ _id: { $in: items.map((i) => i.userId).filter(Boolean) } }).select('name avatarColor').lean();
  const um = new Map(users.map((u) => [String(u._id), normalise(u)]));
  ok(res, items.map((i) => ({ ...normalise(i), user: i.userId ? um.get(String(i.userId)) ?? null : null })), buildMeta(q, total));
}));

// ---------- View groups ----------
export const viewGroupsRouter = crudRouter({ model: ViewGroup, entityName: 'View group', createSchema: z.object({ name: z.string().min(1).max(60), order: z.number().int().optional() }), updateSchema: z.object({ name: z.string().min(1).max(60), order: z.number().int().optional() }).partial(), managePermission: 'admin.project', supportsReorder: true, beforeDelete: async (doc) => { await ListView.updateMany({ groupId: doc._id }, { $set: { groupId: null } }); } });

// ---------- Prioritisation rules ----------
const prioBody = z.object({ name: z.string().min(1).max(80), factor: z.enum(PRIORITY_FACTORS), fieldKey: z.string().max(60).optional(), operator: z.enum(PRIORITY_OPERATORS), value: z.unknown().optional(), points: z.number().int().min(-100).max(100), isActive: z.boolean().optional(), order: z.number().int().optional() });
export const prioritizationRouter = crudRouter({ model: PrioritizationRule, entityName: 'Prioritisation rule', createSchema: prioBody, updateSchema: prioBody.partial(), managePermission: 'admin.project', supportsReorder: true, beforeSave: async (data, req) => { if (data.factor === 'customField' && !data.fieldKey) throw new (await import('../../common/errors')).AppError(400, 'BAD_REQUEST', 'Choose the custom field'); invalidateRuleCache(req.user!.orgId); } });
prioritizationRouter.post('/recompute', requirePermission('admin.project'), asyncHandler(async (req, res) => { invalidateRuleCache(req.user!.orgId); const updated = await recomputeAllPriorities(req.user!.orgId); audit(req.user!, { action: 'prioritization.recompute', entity: 'Lead', summary: `Recomputed priority for ${updated} leads`, ip: req.ip }); ok(res, { updated }); }));

// ---------- FB conversion events ----------
const fbBody = z.object({ name: z.string().min(1).max(80), trigger: z.enum(FB_TRIGGERS), stageId: objectId.nullable().optional(), statusId: objectId.nullable().optional(), sourceIds: z.array(objectId).optional(), eventName: z.string().min(1).max(60), pixelId: z.string().max(40).optional(), accessToken: z.string().max(500).optional(), testEventCode: z.string().max(40).optional(), isActive: z.boolean().optional() });
export const fbEventsRouter = crudRouter({ model: FbConversionEvent, entityName: 'Conversion event', createSchema: fbBody, updateSchema: fbBody.partial(), managePermission: 'admin.project', sort: { createdAt: 1 }, beforeSave: async (data, req, existing) => {
  if (typeof data.accessToken === 'string') { if (data.accessToken) data.accessTokenEnc = encryptField(data.accessToken); delete data.accessToken; }
  audit(req.user!, { action: existing ? 'fb_event.update' : 'fb_event.create', entity: 'FbConversionEvent', entityId: existing?._id, summary: `${existing ? 'Updated' : 'Created'} conversion event ${data.name ?? existing?.name}`, ip: req.ip });
} });

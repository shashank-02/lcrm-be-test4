import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok, created } from '../../common/http';
import { badRequest, conflict, notFound } from '../../common/errors';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/auth';
import { idParam, normalise } from '../../common/crud';
import { PermissionTemplate, User } from '../../models';
import { ROLES } from '../../common/types';
import { isPermissionKey } from '../../common/permissions';
import { audit } from '../../services/audit.service';

export const permissionsRouter = Router();

const schema = z.object({
  name: z.string().min(1).max(80),
  role: z.enum(ROLES),
  description: z.string().max(300).optional(),
  permissions: z.array(z.string()).refine((arr) => arr.every(isPermissionKey), 'Unknown permission key'),
  isDefault: z.boolean().optional(),
});

permissionsRouter.get(
  '/',
  requirePermission('admin.permissions', 'admin.users'),
  asyncHandler(async (req, res) => {
    const tpls = await PermissionTemplate.find({ orgId: req.user!.orgId }).sort({ role: 1, isSystem: -1, name: 1 }).lean();
    const usage = await User.aggregate<{ _id: unknown; n: number }>([
      { $match: { orgId: tpls[0]?.orgId, permissionTemplateId: { $ne: null } } },
      { $group: { _id: '$permissionTemplateId', n: { $sum: 1 } } },
    ]);
    const uMap = new Map(usage.map((u) => [String(u._id), u.n]));
    ok(res, tpls.map((t) => ({ ...normalise(t), userCount: uMap.get(String(t._id)) ?? 0 })));
  }),
);

permissionsRouter.post(
  '/',
  requirePermission('admin.permissions'),
  validate({ body: schema }),
  asyncHandler(async (req, res) => {
    if (req.body.role === 'admin') throw badRequest('Admins always have every permission; templates apply to other roles');
    const tpl = await PermissionTemplate.create({ ...req.body, orgId: req.user!.orgId });
    if (tpl.isDefault) await setDefault(tpl);
    audit(req.user!, { action: 'permission_template.create', entity: 'PermissionTemplate', entityId: tpl._id, summary: `Created template ${tpl.name}`, after: tpl.toJSON(), ip: req.ip });
    created(res, tpl.toJSON());
  }),
);

permissionsRouter.post(
  '/:id/clone',
  requirePermission('admin.permissions'),
  validate({ params: idParam, body: z.object({ name: z.string().min(1).max(80) }) }),
  asyncHandler(async (req, res) => {
    const src = await PermissionTemplate.findOne({ _id: req.params.id, orgId: req.user!.orgId }).lean();
    if (!src) throw notFound('Template');
    const tpl = await PermissionTemplate.create({ orgId: src.orgId, role: src.role, permissions: src.permissions, description: src.description, name: req.body.name, isSystem: false, isDefault: false });
    created(res, tpl.toJSON());
  }),
);

permissionsRouter.patch(
  '/:id',
  requirePermission('admin.permissions'),
  validate({ params: idParam, body: schema.partial() }),
  asyncHandler(async (req, res) => {
    const tpl = await PermissionTemplate.findOne({ _id: req.params.id, orgId: req.user!.orgId });
    if (!tpl) throw notFound('Template');
    if (req.body.role && req.body.role !== tpl.role) throw badRequest('A template cannot change role; clone it instead');
    const before = { name: tpl.name, permissions: [...tpl.permissions], isDefault: tpl.isDefault };
    tpl.set(req.body);
    await tpl.save();
    audit(req.user!, { action: 'permission_template.update', entity: 'PermissionTemplate', entityId: tpl._id, summary: `Updated template ${tpl.name}`, before, after: { name: tpl.name, permissions: tpl.permissions, isDefault: tpl.isDefault }, ip: req.ip });
    if (req.body.isDefault) await setDefault(tpl);
    ok(res, tpl.toJSON());
  }),
);

permissionsRouter.delete(
  '/:id',
  requirePermission('admin.permissions'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const tpl = await PermissionTemplate.findOne({ _id: req.params.id, orgId: req.user!.orgId });
    if (!tpl) throw notFound('Template');
    if (tpl.isSystem) throw conflict('System templates cannot be deleted. Edit them or create a custom one.');
    const inUse = await User.countDocuments({ permissionTemplateId: tpl._id });
    if (inUse) throw conflict(`${inUse} user(s) use this template. Reassign them first.`, { inUse });
    await tpl.deleteOne();
    ok(res, { deleted: true });
  }),
);

async function setDefault(tpl: { _id: unknown; orgId: unknown; role: string }) {
  await PermissionTemplate.updateMany({ orgId: tpl.orgId, role: tpl.role, _id: { $ne: tpl._id } }, { $set: { isDefault: false } });
}

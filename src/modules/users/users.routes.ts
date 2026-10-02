import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import { asyncHandler, ok, created } from '../../common/http';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/auth';
import { idParam, normalise } from '../../common/crud';
import { paginationQuery, toSkipLimit, buildMeta, buildSort } from '../../common/pagination';
import { escapeRegex } from '../../common/mongoose';
import { ROLES, ROLE_RANK } from '../../common/types';
import { Lead, PermissionTemplate, Team, User, Organisation } from '../../models';
import { assignableUsers, visibleTeamIds, ownershipFor } from '../../services/scope.service';
import { logActivities } from '../../services/activity.service';
import { endSessions } from '../../services/session.service';
import { credentialsEmail, sendMail } from '../../services/mail.service';
import { env } from '../../config/env';
import { audit } from '../../services/audit.service';
import { avatarUrl } from '../auth/auth.routes';

export const usersRouter = Router();
const objectId = z.string().refine((v) => Types.ObjectId.isValid(v), 'Invalid id');
const AVATAR_COLORS = ['#185FA5', '#1B8A5A', '#B7791F', '#7C3AED', '#C23B3B', '#0F766E', '#BE185D', '#4338CA'];

const createSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  phone: z.string().regex(/^\+?[0-9]{8,15}$/, 'Phone must be 8-15 digits'),
  username: z.string().regex(/^[a-zA-Z0-9._-]{3,40}$/, 'Username: 3-40 letters, numbers, . _ -'),
  password: z.string().min(8).max(100),
  role: z.enum(ROLES),
  teamId: objectId.nullable().optional(),
  permissionTemplateId: objectId.nullable().optional(),
  mustChangePassword: z.boolean().optional(),
  twoFactorEnabled: z.boolean().optional(),
  employeeId: z.string().max(40).optional(),
  designation: z.string().max(80).optional(),
  /** Email the login details (username + password) to the user when a password is set. Never stored. */
  sendCredentials: z.boolean().optional(),
});
const updateSchema = createSchema.omit({ password: true }).partial().extend({ password: z.string().min(8).max(100).optional() });

/** Sends the credentials email when requested; delivery problems are reported in the response, never as a failed save. */
async function emailCredentials(orgId: string, user: { name: string; email: string; username: string }, password: string, reset: boolean): Promise<{ sent: boolean; error?: string }> {
  try {
    const org = await Organisation.findById(orgId).select('name').lean();
    const appUrl = env.APP_URL || env.CORS_ORIGINS.split(',')[0].trim();
    const r = await sendMail({ ...credentialsEmail(org?.name ?? 'Lead CRM', user.name, user.username || user.email, password, appUrl, reset), to: user.email });
    return r.delivered ? { sent: true } : { sent: false, error: 'Email delivery is not configured on the server.' };
  } catch (err) { return { sent: false, error: (err as Error).message }; }
}

const listQuery = paginationQuery.extend({
  search: z.string().optional(),
  role: z.enum(ROLES).optional(),
  teamId: objectId.optional(),
  isActive: z.enum(['true', 'false']).optional(),
});

/** Lightweight list for dropdowns — scoped to what the caller can see. */
usersRouter.get(
  '/assignable',
  asyncHandler(async (req, res) => {
    ok(res, (await assignableUsers(req.user!)).map(normalise));
  }),
);

usersRouter.get(
  '/',
  requirePermission('admin.users', 'report.view_team'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const filter: Record<string, unknown> = { orgId: req.user!.orgId };
    const teams = visibleTeamIds(req.user!);
    if (teams) filter.teamId = { $in: teams };
    if (q.teamId) filter.teamId = q.teamId;
    if (q.role) filter.role = q.role;
    if (q.isActive) filter.isActive = q.isActive === 'true';
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { username: rx }];
    }
    const [items, total] = await Promise.all([
      User.find(filter).sort(buildSort(q, ['name', 'createdAt', 'role', 'lastLoginAt'], 'name')).skip(toSkipLimit(q).skip).limit(q.limit).lean(),
      User.countDocuments(filter),
    ]);
    ok(res, items.map((u) => ({ ...normalise(stripHash(u)), avatarUrl: avatarUrl(u.avatarKey) })), buildMeta(q, total));
  }),
);

usersRouter.get(
  '/:id',
  requirePermission('admin.users', 'report.view_team'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const u = await User.findOne({ _id: req.params.id, orgId: req.user!.orgId }).lean();
    if (!u) throw notFound('User');
    const leadCount = await Lead.countDocuments({ ownerId: u._id, isDeleted: false });
    ok(res, { ...normalise(stripHash(u)), avatarUrl: avatarUrl(u.avatarKey), leadCount });
  }),
);

usersRouter.post(
  '/',
  requirePermission('admin.users'),
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    guardRoleCreation(req.user!.role, body.role);
    await validateTeamAndTemplate(req.user!.orgId, body);
    const { sendCredentials, ...createBody } = body;
    const user = await User.create({
      ...createBody,
      orgId: req.user!.orgId,
      passwordHash: await bcrypt.hash(body.password, 12),
      avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      mustChangePassword: body.mustChangePassword ?? false,
    });
    await syncTeamLead(user);
    const mail = sendCredentials ? await emailCredentials(req.user!.orgId, user, body.password, false) : null;
    audit(req.user!, { action: 'user.create', entity: 'User', entityId: user._id, summary: `Created user ${user.name} (${user.role})`, after: { name: user.name, email: user.email, role: user.role, teamId: user.teamId, twoFactorEnabled: user.twoFactorEnabled }, ip: req.ip });
    created(res, { ...user.toJSON(), credentialsEmail: mail });
  }),
);

usersRouter.patch(
  '/:id',
  requirePermission('admin.users'),
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(async (req, res) => {
    const user = await User.findOne({ _id: req.params.id, orgId: req.user!.orgId }).select('+passwordHash');
    if (!user) throw notFound('User');
    const body = req.body as z.infer<typeof updateSchema>;
    const before = { name: user.name, email: user.email, phone: user.phone, role: user.role, teamId: user.teamId, permissionTemplateId: user.permissionTemplateId, isActive: user.isActive, twoFactorEnabled: user.twoFactorEnabled };
    if (body.role) guardRoleCreation(req.user!.role, body.role);
    if (user.role === 'admin' && body.role && body.role !== 'admin') {
      const admins = await User.countDocuments({ orgId: req.user!.orgId, role: 'admin', isActive: true });
      if (admins <= 1) throw conflict('Cannot demote the only active admin');
    }
    await validateTeamAndTemplate(req.user!.orgId, body);
    const { password, sendCredentials, ...rest } = body;
    user.set(rest);
    if (password) {
      user.passwordHash = await bcrypt.hash(password, 12); user.passwordChangedAt = new Date(); user.failedLoginAttempts = 0; user.lockUntil = null;
      await endSessions({ userId: user._id, revokedAt: null }, 'password_change');
    }
    await user.save();
    await syncTeamLead(user);
    const mail = password && sendCredentials ? await emailCredentials(req.user!.orgId, user, password, true) : null;
    audit(req.user!, { action: 'user.update', entity: 'User', entityId: user._id, summary: `Updated user ${user.name}${password ? ' (password reset)' : ''}`, before, after: { name: user.name, email: user.email, phone: user.phone, role: user.role, teamId: user.teamId, permissionTemplateId: user.permissionTemplateId, isActive: user.isActive, twoFactorEnabled: user.twoFactorEnabled }, ip: req.ip });
    ok(res, { ...user.toJSON(), credentialsEmail: mail });
  }),
);

/**
 * Deactivate a user. If they still own leads, require `reassignTo` (or `force` to leave them unassigned).
 * Never deletes data.
 */
usersRouter.post(
  '/:id/deactivate',
  requirePermission('admin.users'),
  validate({ params: idParam, body: z.object({ reassignTo: objectId.optional(), force: z.boolean().optional() }) }),
  asyncHandler(async (req, res) => {
    const user = await User.findOne({ _id: req.params.id, orgId: req.user!.orgId });
    if (!user) throw notFound('User');
    if (String(user._id) === req.user!.id) throw badRequest('You cannot deactivate yourself');
    if (user.role === 'admin') {
      const admins = await User.countDocuments({ orgId: req.user!.orgId, role: 'admin', isActive: true });
      if (admins <= 1) throw conflict('Cannot deactivate the only active admin');
    }
    const leadCount = await Lead.countDocuments({ ownerId: user._id, isDeleted: false });
    if (leadCount > 0 && !req.body.reassignTo && !req.body.force) {
      throw conflict(`${user.name} owns ${leadCount} lead(s). Choose who should receive them.`, { leadCount, requiresReassignment: true });
    }
    let reassigned = 0;
    if (leadCount > 0) {
      const target = req.body.reassignTo ? await ownershipFor(req.user!.orgId, req.body.reassignTo) : { ownerId: null, teamId: null, managerId: null };
      const leads = await Lead.find({ ownerId: user._id, isDeleted: false }).select('_id').lean();
      await Lead.updateMany({ ownerId: user._id, isDeleted: false }, { $set: { ...target, assignedAt: target.ownerId ? new Date() : null } });
      await logActivities(leads.map((l) => ({
        orgId: req.user!.orgId, leadId: l._id, userId: req.user!.id, type: target.ownerId ? 'assigned' : 'unassigned',
        description: target.ownerId ? `Reassigned after ${user.name} was deactivated` : `Unassigned after ${user.name} was deactivated`,
        payload: { previousOwnerId: user._id, ownerId: target.ownerId },
      })));
      reassigned = leads.length;
    }
    user.isActive = false;
    await user.save();
    await endSessions({ userId: user._id, revokedAt: null }, 'revoked');
    await Team.updateMany({ teamLeadId: user._id }, { $set: { teamLeadId: null } });
    audit(req.user!, { action: 'user.deactivate', entity: 'User', entityId: user._id, summary: `Deactivated ${user.name}; ${reassigned} leads reassigned`, ip: req.ip });
    ok(res, { deactivated: true, reassigned });
  }),
);

usersRouter.post(
  '/:id/activate',
  requirePermission('admin.users'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const user = await User.findOneAndUpdate({ _id: req.params.id, orgId: req.user!.orgId }, { $set: { isActive: true } }, { new: true });
    if (!user) throw notFound('User');
    ok(res, user.toJSON());
  }),
);

function stripHash<T extends { passwordHash?: string }>(u: T) {
  const { passwordHash, ...rest } = u;
  void passwordHash;
  return rest;
}

function guardRoleCreation(actorRole: string, targetRole: string) {
  // Only admins reach here via permission, but keep the hierarchy check for custom templates.
  if (ROLE_RANK[targetRole as keyof typeof ROLE_RANK] < ROLE_RANK[actorRole as keyof typeof ROLE_RANK]) {
    throw forbidden('You cannot create a user with a higher role than your own');
  }
}

async function validateTeamAndTemplate(orgId: string, body: { teamId?: string | null; permissionTemplateId?: string | null; role?: string }) {
  if (body.teamId) {
    const team = await Team.findOne({ _id: body.teamId, orgId }).lean();
    if (!team) throw badRequest('Team not found');
  }
  if (body.permissionTemplateId) {
    const tpl = await PermissionTemplate.findOne({ _id: body.permissionTemplateId, orgId }).lean();
    if (!tpl) throw badRequest('Permission template not found');
    if (body.role && tpl.role !== body.role) throw badRequest(`Template "${tpl.name}" is for role ${tpl.role}`);
  }
}

/** Keep Team.teamLeadId in sync when a team_lead is placed in a team. */
async function syncTeamLead(user: { _id: unknown; role: string; teamId?: unknown }) {
  if (user.role === 'team_lead' && user.teamId) {
    await Team.updateOne({ _id: user.teamId }, { $set: { teamLeadId: user._id } });
  }
}

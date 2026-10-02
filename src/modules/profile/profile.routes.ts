import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { z } from 'zod';
import { asyncHandler, ok } from '../../common/http';
import { badRequest, notFound } from '../../common/errors';
import { validate } from '../../middleware/validate';
import { hasPermission } from '../../middleware/auth';
import { idParam, normalise } from '../../common/crud';
import { Organisation, Team, User } from '../../models';
import { decryptField, encryptField, mask } from '../../services/crypto.service';
import { buildStorageKey, storage } from '../../services/storage.service';
import { audit } from '../../services/audit.service';
import { avatarUrl } from '../auth/auth.routes';

export const profileRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });
const IMG: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

const profileBody = z.object({
  name: z.string().min(1).max(100).optional(), phone: z.string().regex(/^\+?[0-9]{8,15}$/).optional(), email: z.string().email().optional(),
  employeeId: z.string().max(40).optional(), designation: z.string().max(80).optional(), dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  bankName: z.string().max(80).optional(), bankAccountName: z.string().max(100).optional(), bankAccountNumber: z.string().max(34).optional(), ifscCode: z.string().max(20).optional(), panNumber: z.string().max(12).optional(),
});

export async function serializeProfile(userId: string, viewerIsSelfOrAdmin: boolean) {
  const u = await User.findById(userId).lean(); if (!u) throw notFound('User');
  const [org, team, managed, owner] = await Promise.all([
    Organisation.findById(u.orgId).select('name').lean(), u.teamId ? Team.findById(u.teamId).select('name').lean() : null,
    Team.find({ orgId: u.orgId, $or: [{ managerId: u._id }, { teamLeadId: u._id }] }).select('name managerId teamLeadId').lean(),
    User.findOne({ orgId: u.orgId, role: 'admin', isActive: true }).sort({ createdAt: 1 }).select('name email').lean(),
  ]);
  const bank = decryptField(u.bankAccountNumberEnc ?? ''); const pan = decryptField(u.panNumberEnc ?? '');
  const projects = [...(team ? [{ id: String(team._id), name: team.name, role: u.role === 'team_lead' ? 'team lead' : 'member' }] : []), ...managed.filter((m) => String(m._id) !== String(u.teamId)).map((m) => ({ id: String(m._id), name: m.name, role: String(m.managerId) === String(u._id) ? 'manager' : 'team lead' }))];
  return {
    ...normalise(u), passwordHash: undefined, bankAccountNumberEnc: undefined, panNumberEnc: undefined,
    avatarUrl: avatarUrl(u.avatarKey), bankAccountNumber: viewerIsSelfOrAdmin ? bank : mask(bank), panNumber: viewerIsSelfOrAdmin ? pan : mask(pan),
    account: { name: org?.name ?? '', owner: owner?.name ?? '', ownerEmail: owner?.email ?? '' }, teamName: team?.name ?? '', projects,
  };
}

profileRouter.get('/', asyncHandler(async (req, res) => ok(res, await serializeProfile(req.user!.id, true))));

profileRouter.patch('/', validate({ body: profileBody }), asyncHandler(async (req, res) => {
  const u = await User.findById(req.user!.id); if (!u) throw notFound('User');
  const before = { name: u.name, phone: u.phone, email: u.email, employeeId: u.employeeId, designation: u.designation };
  const { bankAccountNumber, panNumber, dateOfBirth, ...rest } = req.body as z.infer<typeof profileBody>;
  u.set(rest);
  if (dateOfBirth !== undefined) u.dateOfBirth = dateOfBirth ? new Date(dateOfBirth) : null;
  if (bankAccountNumber !== undefined) u.bankAccountNumberEnc = encryptField(bankAccountNumber);
  if (panNumber !== undefined) u.panNumberEnc = encryptField(panNumber.toUpperCase());
  await u.save();
  audit(req.user!, { action: 'profile.update', entity: 'User', entityId: u._id, summary: 'Updated own profile', before, after: { name: u.name, phone: u.phone, email: u.email, employeeId: u.employeeId, designation: u.designation }, ip: req.ip });
  ok(res, await serializeProfile(req.user!.id, true));
}));

profileRouter.post('/avatar', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Choose an image (JPG, PNG or WEBP up to 3 MB)');
  const ext = path.extname(req.file.originalname).slice(1).toLowerCase();
  if (!IMG[ext] || !req.file.mimetype.startsWith('image/')) throw badRequest('Only JPG, PNG or WEBP images are allowed');
  const u = await User.findById(req.user!.id); if (!u) throw notFound('User');
  const key = buildStorageKey(req.user!.orgId, 'avatars', `avatar.${ext}`);
  await storage().putObject(key, req.file.buffer, IMG[ext]);
  const old = u.avatarKey; u.avatarKey = key; await u.save();
  if (old) storage().deleteObject(old).catch(() => undefined);
  ok(res, { avatarUrl: avatarUrl(key) });
}));
profileRouter.delete('/avatar', asyncHandler(async (req, res) => {
  const u = await User.findById(req.user!.id); if (!u) throw notFound('User');
  if (u.avatarKey) { storage().deleteObject(u.avatarKey).catch(() => undefined); u.avatarKey = ''; await u.save(); }
  ok(res, { avatarUrl: null });
}));

/** Admin: view/edit another member's profile (admin.profiles). */
export const memberProfileRouter = Router();
memberProfileRouter.get('/:id/profile', validate({ params: idParam }), asyncHandler(async (req, res) => {
  if (!hasPermission(req.user!, 'admin.profiles') && !hasPermission(req.user!, 'admin.users')) throw badRequest('Not allowed');
  const u = await User.findOne({ _id: req.params.id, orgId: req.user!.orgId }).select('_id').lean(); if (!u) throw notFound('User');
  ok(res, await serializeProfile(req.params.id, req.user!.role === 'admin'));
}));
memberProfileRouter.patch('/:id/profile', validate({ params: idParam, body: profileBody }), asyncHandler(async (req, res) => {
  if (!hasPermission(req.user!, 'admin.profiles')) throw badRequest('Not allowed');
  const u = await User.findOne({ _id: req.params.id, orgId: req.user!.orgId }); if (!u) throw notFound('User');
  const { bankAccountNumber, panNumber, dateOfBirth, ...rest } = req.body as z.infer<typeof profileBody>;
  u.set(rest); if (dateOfBirth !== undefined) u.dateOfBirth = dateOfBirth ? new Date(dateOfBirth) : null;
  if (bankAccountNumber !== undefined) u.bankAccountNumberEnc = encryptField(bankAccountNumber); if (panNumber !== undefined) u.panNumberEnc = encryptField(panNumber.toUpperCase());
  await u.save();
  audit(req.user!, { action: 'profile.admin_update', entity: 'User', entityId: u._id, summary: `Edited profile of ${u.name}`, after: rest, ip: req.ip });
  ok(res, await serializeProfile(req.params.id, true));
}));

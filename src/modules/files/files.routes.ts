import { Router } from 'express';
import express from 'express';
import path from 'node:path';
import { z } from 'zod';
import { asyncHandler, ok, created } from '../../common/http';
import { badRequest, forbidden, notFound, unauthorized } from '../../common/errors';
import { validate } from '../../middleware/validate';
import { hasPermission, requireAuth, requirePermission } from '../../middleware/auth';
import { idParam, normalise } from '../../common/crud';
import { LeadFile, User } from '../../models';
import { buildStorageKey, storage } from '../../services/storage.service';
import { logActivity } from '../../services/activity.service';
import { getLeadInScope, objectId } from '../leads/lead.service';
import { verifyAccessToken } from '../../services/token.service';
import { buildAuthUser } from '../../services/permission.service';

const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'text/plain']);
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Per-lead document routes: /leads/:leadId/files */
export const leadFilesRouter = Router({ mergeParams: true });
const leadParam = z.object({ leadId: objectId });

leadFilesRouter.get('/', requirePermission('file.view'), validate({ params: leadParam }), asyncHandler(async (req, res) => {
  const lead = await getLeadInScope(req.user!, req.params.leadId);
  const files = await LeadFile.find({ leadId: lead._id }).sort({ createdAt: -1 }).lean();
  const users = await User.find({ _id: { $in: files.map((f) => f.createdById) } }).select('name').lean();
  const um = new Map(users.map((u) => [String(u._id), normalise(u)]));
  ok(res, files.map((f) => ({ ...normalise(f), uploadedBy: um.get(String(f.createdById)) ?? null })));
}));

/**
 * Step 1: register metadata and get an upload URL.
 * The browser then PUTs the binary to `uploadUrl` (S3 presigned, or this API when STORAGE_DRIVER=local).
 * Step 2: POST /files/:id/confirm.
 */
leadFilesRouter.post('/presign', requirePermission('file.upload'), validate({ params: leadParam, body: z.object({ title: z.string().min(1).max(120), description: z.string().max(500).optional(), category: z.string().max(60).optional(), isMandatory: z.boolean().optional(), fileName: z.string().min(1).max(200), mimeType: z.string().min(3).max(120), size: z.number().int().min(1).max(MAX_FILE_BYTES) }) }), asyncHandler(async (req, res) => {
  const lead = await getLeadInScope(req.user!, req.params.leadId);
  if (!ALLOWED_MIME.has(req.body.mimeType)) throw badRequest('File type not allowed. Upload PDF, images, Word, Excel or CSV.');
  const driver = storage();
  const key = buildStorageKey(req.user!.orgId, `leads/${lead._id}`, req.body.fileName);
  const file = await LeadFile.create({ ...req.body, orgId: req.user!.orgId, leadId: lead._id, createdById: req.user!.id, storageDriver: driver.name, storageKey: key, status: 'pending' });
  const uploadUrl = await driver.presignUpload(key, req.body.mimeType, { fileId: String(file._id), userId: req.user!.id, orgId: req.user!.orgId, role: req.user!.role });
  created(res, { file: file.toJSON(), uploadUrl, method: 'PUT', headers: { 'Content-Type': req.body.mimeType } });
}));

/** Global file routes: /files */
export const filesRouter = Router();

filesRouter.post('/:id/confirm', requireAuth, requirePermission('file.upload'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const file = await LeadFile.findOne({ _id: req.params.id, orgId: req.user!.orgId });
  if (!file) throw notFound('File');
  await getLeadInScope(req.user!, String(file.leadId));
  file.status = 'uploaded'; await file.save();
  await logActivity({ orgId: req.user!.orgId, leadId: file.leadId, userId: req.user!.id, type: 'file_uploaded', description: `Uploaded ${file.title}`, payload: { fileId: file._id, fileName: file.fileName } });
  ok(res, file.toJSON());
}));

filesRouter.get('/:id/download', requireAuth, requirePermission('file.view'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const file = await LeadFile.findOne({ _id: req.params.id, orgId: req.user!.orgId }).lean();
  if (!file) throw notFound('File');
  await getLeadInScope(req.user!, String(file.leadId));
  if (file.status === 'pending') throw badRequest('Upload has not completed');
  ok(res, { url: await storage().presignDownload(file.storageKey, file.fileName), fileName: file.fileName, mimeType: file.mimeType });
}));

filesRouter.patch('/:id', requireAuth, requirePermission('file.upload'), validate({ params: idParam, body: z.object({ title: z.string().min(1).max(120).optional(), description: z.string().max(500).optional(), category: z.string().max(60).optional(), status: z.enum(['uploaded', 'verified', 'rejected']).optional() }) }), asyncHandler(async (req, res) => {
  const file = await LeadFile.findOne({ _id: req.params.id, orgId: req.user!.orgId });
  if (!file) throw notFound('File');
  await getLeadInScope(req.user!, String(file.leadId));
  if (req.body.status && ['verified', 'rejected'].includes(req.body.status) && req.user!.role === 'agent') throw forbidden('Only team leads and above can verify documents');
  file.set(req.body); await file.save();
  ok(res, file.toJSON());
}));

filesRouter.delete('/:id', requireAuth, requirePermission('file.delete'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const file = await LeadFile.findOne({ _id: req.params.id, orgId: req.user!.orgId });
  if (!file) throw notFound('File');
  await getLeadInScope(req.user!, String(file.leadId));
  if (!hasPermission(req.user!, 'file.delete')) throw forbidden();
  try { await storage().deleteObject(file.storageKey); } catch { /* metadata removal still proceeds */ }
  await file.deleteOne();
  await logActivity({ orgId: req.user!.orgId, leadId: file.leadId, userId: req.user!.id, type: 'file_deleted', description: `Deleted ${file.title}` });
  ok(res, { deleted: true });
}));

// ---------- Local storage driver endpoints (dev / single-server deployments) ----------
/** Browser PUTs raw bytes here when STORAGE_DRIVER=local. Token comes from the presign step. */
filesRouter.put('/:id/upload', express.raw({ type: '*/*', limit: `${MAX_FILE_BYTES}b` }), asyncHandler(async (req, res) => {
  const token = String(req.query.token ?? '');
  let userId: string;
  try { userId = verifyAccessToken(token).sub; } catch { throw unauthorized('Upload token invalid'); }
  const user = await buildAuthUser(userId); if (!user) throw unauthorized();
  const file = await LeadFile.findOne({ _id: req.params.id, orgId: user.orgId, storageDriver: 'local' });
  if (!file || file.storageKey !== String(req.query.key)) throw notFound('File');
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !body.length) throw badRequest('Empty upload');
  await storage().putObject(file.storageKey, body, file.mimeType);
  file.size = body.length; await file.save();
  ok(res, { stored: true });
}));

/** Serves local files. Requires a valid access token via query (?token=) or Authorization header. */
filesRouter.get('/raw/:key', asyncHandler(async (req, res) => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : String(req.query.token ?? '');
  let userId: string;
  try { userId = verifyAccessToken(token).sub; } catch { throw unauthorized(); }
  const user = await buildAuthUser(userId); if (!user) throw unauthorized();
  const key = decodeURIComponent(req.params.key);
  const file = await LeadFile.findOne({ storageKey: key, orgId: user.orgId }).lean();
  if (!file) throw notFound('File');
  await getLeadInScope(user, String(file.leadId));
  const buf = await storage().getObject(key);
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(file.fileName)}"`);
  res.send(buf);
}));

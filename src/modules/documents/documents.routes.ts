import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { z } from 'zod';
import { Types } from 'mongoose';
import { asyncHandler, ok, created } from '../../common/http';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../common/errors';
import { validate } from '../../middleware/validate';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { idParam, normalise } from '../../common/crud';
import { DocFolder, Document, Organisation, Team, User } from '../../models';
import { audienceFilter, canSee } from '../../services/access.service';
import { buildStorageKey, storage } from '../../services/storage.service';
import { signViewToken, verifyViewToken } from '../../services/token.service';
import { buildAuthUser } from '../../services/permission.service';
import { audit } from '../../services/audit.service';
import { escapeRegex } from '../../common/mongoose';
import { buildMeta } from '../../common/pagination';

export const documentsRouter = Router();
const objectId = z.string().refine((v) => Types.ObjectId.isValid(v), 'Invalid id');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

const audienceSchema = z.object({ all: z.boolean().optional(), roles: z.array(z.enum(['admins', 'managers', 'agents'])).optional(), teamIds: z.array(objectId).optional(), userIds: z.array(objectId).optional() });
type AudienceIn = z.infer<typeof audienceSchema>;
const normaliseAudience = (a?: AudienceIn) => ({ all: !!a?.all, roles: a?.all ? [] : a?.roles ?? [], teamIds: a?.all ? [] : a?.teamIds ?? [], userIds: a?.all ? [] : a?.userIds ?? [] });
const parseAudience = (raw: unknown): AudienceIn | undefined => { if (raw === undefined) return undefined; try { return audienceSchema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch { throw badRequest('Invalid audience'); } };
const MIME_BY_EXT: Record<string, string> = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', mp4: 'video/mp4', webm: 'video/webm' };

async function checkFile(orgId: string, file: Express.Multer.File) {
  const org = await Organisation.findById(orgId).select('settings.files').lean();
  const allowed = org?.settings?.files?.allowedTypes ?? ['pdf'];
  const maxMb = org?.settings?.files?.maxSizeMb ?? 25;
  const ext = path.extname(file.originalname).slice(1).toLowerCase();
  if (!allowed.includes(ext)) throw badRequest(`File type .${ext} is not allowed. Allowed: ${allowed.join(', ')}`);
  if (file.size > maxMb * 1024 * 1024) throw badRequest(`File exceeds the ${maxMb} MB limit`);
  return { ext, mime: MIME_BY_EXT[ext] ?? file.mimetype ?? 'application/octet-stream' };
}

// ---------- Folders ----------
documentsRouter.get('/folders', requirePermission('files.view'), asyncHandler(async (req, res) => {
  const folders = await DocFolder.find({ orgId: req.user!.orgId, ...audienceFilter(req.user!) }).sort({ order: 1, name: 1 }).lean();
  ok(res, folders.map(normalise));
}));
const folderBody = z.object({ name: z.string().min(1).max(100), parentId: objectId.nullable().optional(), audience: audienceSchema.optional(), order: z.number().int().optional() });
documentsRouter.post('/folders', requirePermission('files.manage'), validate({ body: folderBody }), asyncHandler(async (req, res) => {
  const f = await DocFolder.create({ ...req.body, parentId: req.body.parentId ?? null, audience: normaliseAudience(req.body.audience), orgId: req.user!.orgId, createdById: req.user!.id });
  audit(req.user!, { action: 'folder.create', entity: 'DocFolder', entityId: f._id, summary: `Created folder ${f.name}`, after: f.toJSON(), ip: req.ip });
  created(res, f.toJSON());
}));
documentsRouter.patch('/folders/:id', requirePermission('files.manage'), validate({ params: idParam, body: folderBody.partial() }), asyncHandler(async (req, res) => {
  const f = await DocFolder.findOne({ _id: req.params.id, orgId: req.user!.orgId }); if (!f) throw notFound('Folder');
  const before = f.toJSON();
  if (req.body.audience) f.audience = normaliseAudience(req.body.audience) as never;
  const { audience, ...rest } = req.body; void audience; f.set(rest); await f.save();
  audit(req.user!, { action: 'folder.update', entity: 'DocFolder', entityId: f._id, summary: `Updated folder ${f.name}`, before, after: f.toJSON(), ip: req.ip });
  ok(res, f.toJSON());
}));
documentsRouter.delete('/folders/:id', requirePermission('files.manage'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const f = await DocFolder.findOne({ _id: req.params.id, orgId: req.user!.orgId }); if (!f) throw notFound('Folder');
  const [docs, sub] = await Promise.all([Document.countDocuments({ folderId: f._id }), DocFolder.countDocuments({ parentId: f._id })]);
  if (docs || sub) throw conflict(`Folder contains ${docs} document(s) and ${sub} sub-folder(s). Move or delete them first.`);
  await f.deleteOne();
  audit(req.user!, { action: 'folder.delete', entity: 'DocFolder', entityId: f._id, summary: `Deleted folder ${f.name}`, ip: req.ip });
  ok(res, { deleted: true });
}));

// ---------- Documents ----------
const listQuery = z.object({ folderId: z.string().optional(), search: z.string().max(100).optional(), teamId: z.string().optional(), type: z.string().max(10).optional(), role: z.enum(['admins', 'managers', 'agents']).optional(), uploadedBy: z.string().optional(), from: z.string().optional(), to: z.string().optional(), includeInactive: z.enum(['true', 'false']).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(100) });
documentsRouter.get('/', requirePermission('files.view'), validate({ query: listQuery }), asyncHandler(async (req, res) => {
  const q = req.query as unknown as z.infer<typeof listQuery>;
  const isManager = req.user!.role === 'admin' || req.user!.permissions.has('files.manage');
  const f: Record<string, unknown> = { orgId: req.user!.orgId, ...audienceFilter(req.user!) };
  if (!(isManager && q.includeInactive === 'true')) f.isActive = true;
  if (q.folderId !== undefined && q.search === undefined) f.folderId = q.folderId === '' || q.folderId === 'root' ? null : q.folderId;
  if (q.search) f.$and = [{ $or: [{ name: new RegExp(escapeRegex(q.search), 'i') }, { description: new RegExp(escapeRegex(q.search), 'i') }] }];
  if (q.type) f.docType = q.type.toLowerCase();
  if (q.teamId && Types.ObjectId.isValid(q.teamId)) f['audience.teamIds'] = q.teamId;
  if (isManager) { if (q.role) f['audience.roles'] = q.role; if (q.uploadedBy) f.uploadedById = q.uploadedBy; if (q.from || q.to) f.createdAt = { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? { $lte: new Date(q.to) } : {}) }; }
  const [items, total] = await Promise.all([Document.find(f).sort({ name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Document.countDocuments(f)]);
  const [users, teams] = await Promise.all([User.find({ _id: { $in: items.map((d) => d.uploadedById) } }).select('name').lean(), Team.find({ orgId: req.user!.orgId }).select('name').lean()]);
  const um = new Map(users.map((u) => [String(u._id), u.name])); const tm = new Map(teams.map((t) => [String(t._id), t.name]));
  ok(res, items.map((d) => ({ ...normalise(d), uploadedBy: um.get(String(d.uploadedById)) ?? '', teamNames: d.audience.teamIds.map((t) => tm.get(String(t)) ?? '') })), buildMeta({ page: q.page, limit: q.limit, sortDir: 'asc' }, total));
}));

documentsRouter.post('/', requirePermission('files.manage'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Attach the document in the "file" field');
  const body = z.object({ name: z.string().min(1).max(150), description: z.string().max(1000).optional(), folderId: objectId.nullable().optional() }).parse({ ...req.body, folderId: req.body.folderId || null });
  const audience = normaliseAudience(parseAudience(req.body.audience) ?? { all: true });
  const { ext, mime } = await checkFile(req.user!.orgId, req.file);
  const driver = storage(); const key = buildStorageKey(req.user!.orgId, 'documents', req.file.originalname);
  await driver.putObject(key, req.file.buffer, mime);
  const doc = await Document.create({ ...body, orgId: req.user!.orgId, fileName: req.file.originalname, mimeType: mime, docType: ext, size: req.file.size, storageDriver: driver.name, storageKey: key, audience, uploadedById: req.user!.id });
  audit(req.user!, { action: 'document.upload', entity: 'Document', entityId: doc._id, summary: `Uploaded "${doc.name}"`, after: doc.toJSON(), ip: req.ip });
  created(res, doc.toJSON());
}));

documentsRouter.patch('/:id', requirePermission('files.manage'), validate({ params: idParam, body: z.object({ name: z.string().min(1).max(150).optional(), description: z.string().max(1000).optional(), folderId: objectId.nullable().optional(), audience: audienceSchema.optional(), isActive: z.boolean().optional() }) }), asyncHandler(async (req, res) => {
  const doc = await Document.findOne({ _id: req.params.id, orgId: req.user!.orgId }); if (!doc) throw notFound('Document');
  const before = doc.toJSON();
  const { audience, ...rest } = req.body; doc.set(rest); if (audience) doc.audience = normaliseAudience(audience) as never; doc.updatedById = req.user!.id as never;
  await doc.save();
  audit(req.user!, { action: audience ? 'document.visibility' : 'document.update', entity: 'Document', entityId: doc._id, summary: `${audience ? 'Changed visibility of' : 'Updated'} "${doc.name}"`, before, after: doc.toJSON(), ip: req.ip });
  ok(res, doc.toJSON());
}));

documentsRouter.post('/:id/replace', requirePermission('files.manage'), validate({ params: idParam }), upload.single('file'), asyncHandler(async (req, res) => {
  const doc = await Document.findOne({ _id: req.params.id, orgId: req.user!.orgId }); if (!doc) throw notFound('Document');
  if (!req.file) throw badRequest('Attach the new file in the "file" field');
  const { ext, mime } = await checkFile(req.user!.orgId, req.file);
  const driver = storage(); const key = buildStorageKey(req.user!.orgId, 'documents', req.file.originalname);
  await driver.putObject(key, req.file.buffer, mime);
  const oldKey = doc.storageKey;
  doc.set({ fileName: req.file.originalname, mimeType: mime, docType: ext, size: req.file.size, storageDriver: driver.name, storageKey: key, version: doc.version + 1, updatedById: req.user!.id });
  await doc.save();
  try { await driver.deleteObject(oldKey); } catch { /* old file may already be gone */ }
  audit(req.user!, { action: 'document.replace', entity: 'Document', entityId: doc._id, summary: `Replaced file of "${doc.name}" (v${doc.version})`, ip: req.ip });
  ok(res, doc.toJSON());
}));

documentsRouter.delete('/:id', requirePermission('files.manage'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const doc = await Document.findOne({ _id: req.params.id, orgId: req.user!.orgId }); if (!doc) throw notFound('Document');
  try { await storage().deleteObject(doc.storageKey); } catch { /* ignore */ }
  await doc.deleteOne();
  audit(req.user!, { action: 'document.delete', entity: 'Document', entityId: doc._id, summary: `Deleted "${doc.name}"`, before: doc.toJSON(), ip: req.ip });
  ok(res, { deleted: true });
}));

/** Step 1 of viewing: permission check → short-lived token bound to this document and user. */
documentsRouter.get('/:id/view-token', requirePermission('files.view'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const doc = await Document.findOne({ _id: req.params.id, orgId: req.user!.orgId }).lean(); if (!doc) throw notFound('Document');
  if (!doc.isActive && req.user!.role !== 'admin') throw forbidden('Access denied');
  if (!canSee(req.user!, doc.audience)) throw forbidden('Access denied');
  ok(res, { token: signViewToken(req.user!.id, `doc:${doc._id}`, 300), url: `/api/v1/documents/${doc._id}/view`, mimeType: doc.mimeType, fileName: doc.fileName, canDownload: req.user!.role === 'admin' || req.user!.permissions.has('files.download') });
}));

/** Step 2: stream inline (view-only). Re-checks visibility; never sends Content-Disposition: attachment. Mounted before requireAuth. */
export const documentViewHandlers = [validate({ params: idParam }), asyncHandler(async (req, res) => {
  let userId: string; try { userId = verifyViewToken(String(req.query.token ?? ''), `doc:${req.params.id}`); } catch { throw unauthorized('View link expired. Open the document again.'); }
  const user = await buildAuthUser(userId); if (!user) throw unauthorized();
  const doc = await Document.findOne({ _id: req.params.id, orgId: user.orgId }).lean(); if (!doc) throw notFound('Document');
  if ((!doc.isActive && user.role !== 'admin') || !canSee(user, doc.audience)) throw forbidden('Access denied');
  const buf = await storage().getObject(doc.storageKey);
  res.setHeader('Content-Type', doc.mimeType); res.setHeader('Content-Disposition', 'inline'); res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.send(buf);
})];

/** Download: admins (or files.download) only — enforced here, not just hidden in the UI. */
documentsRouter.get('/:id/download', requireAuth, requirePermission('files.download'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const doc = await Document.findOne({ _id: req.params.id, orgId: req.user!.orgId }).lean(); if (!doc) throw notFound('Document');
  const buf = await storage().getObject(doc.storageKey);
  res.setHeader('Content-Type', doc.mimeType); res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.fileName)}"`); res.setHeader('Cache-Control', 'private, no-store');
  audit(req.user!, { action: 'document.download', entity: 'Document', entityId: doc._id, summary: `Downloaded "${doc.name}"`, ip: req.ip });
  res.send(buf);
}));

import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { Types } from 'mongoose';
import { asyncHandler, ok, created } from '../../common/http';
import { badRequest, forbidden, notFound, unauthorized } from '../../common/errors';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/auth';
import { crudRouter, idParam, normalise } from '../../common/crud';
import { Organisation, Training, TrainingCategory, TrainingProgress, User, TRAINING_TYPES } from '../../models';
import { audienceFilter, canSee } from '../../services/access.service';
import { buildStorageKey, storage } from '../../services/storage.service';
import { signViewToken, verifyViewToken } from '../../services/token.service';
import { buildAuthUser } from '../../services/permission.service';
import { audit } from '../../services/audit.service';
import { escapeRegex } from '../../common/mongoose';
import { env } from '../../config/env';

export const trainingRouter = Router();
const objectId = z.string().refine((v) => Types.ObjectId.isValid(v), 'Invalid id');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 600 * 1024 * 1024 } });
const audienceSchema = z.object({ all: z.boolean().optional(), roles: z.array(z.enum(['admins', 'managers', 'agents'])).optional(), teamIds: z.array(objectId).optional(), userIds: z.array(objectId).optional() });
const normaliseAudience = (a?: z.infer<typeof audienceSchema>) => ({ all: !!a?.all, roles: a?.all ? [] : a?.roles ?? [], teamIds: a?.all ? [] : a?.teamIds ?? [], userIds: a?.all ? [] : a?.userIds ?? [] });
const VIDEO_EXT: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v' };
const DOC_EXT: Record<string, string> = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
const isHttpUrl = (u: string) => { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:'; } catch { return false; } };

/** Categories: plain org-scoped CRUD (admin manage, everyone read). */
trainingRouter.use('/categories', crudRouter({ model: TrainingCategory, entityName: 'Category', createSchema: z.object({ name: z.string().min(1).max(60), order: z.number().int().optional(), isActive: z.boolean().optional() }), updateSchema: z.object({ name: z.string().min(1).max(60), order: z.number().int().optional(), isActive: z.boolean().optional() }).partial(), managePermission: 'training.manage', supportsReorder: true }));

const listQuery = z.object({ search: z.string().max(100).optional(), categoryId: z.string().optional(), type: z.enum(TRAINING_TYPES).optional(), includeInactive: z.enum(['true', 'false']).optional() });
trainingRouter.get('/', requirePermission('training.view'), validate({ query: listQuery }), asyncHandler(async (req, res) => {
  const q = req.query as unknown as z.infer<typeof listQuery>;
  const manager = req.user!.role === 'admin' || req.user!.permissions.has('training.manage');
  const f: Record<string, unknown> = { orgId: req.user!.orgId, ...audienceFilter(req.user!) };
  if (!(manager && q.includeInactive === 'true')) f.isActive = true;
  if (q.categoryId && Types.ObjectId.isValid(q.categoryId)) f.categoryId = q.categoryId;
  if (q.type) f.type = q.type;
  if (q.search) f.$and = [{ $or: [{ title: new RegExp(escapeRegex(q.search), 'i') }, { description: new RegExp(escapeRegex(q.search), 'i') }] }];
  const items = await Training.find(f).select('-content').sort({ order: 1, createdAt: -1 }).limit(500).lean();
  const [progress, users, cats] = await Promise.all([
    TrainingProgress.find({ userId: req.user!.id, trainingId: { $in: items.map((t) => t._id) } }).lean(),
    User.find({ _id: { $in: items.map((t) => t.createdById) } }).select('name').lean(),
    TrainingCategory.find({ orgId: req.user!.orgId }).select('name').lean(),
  ]);
  const pm = new Map(progress.map((p) => [String(p.trainingId), p])); const um = new Map(users.map((u) => [String(u._id), u.name])); const cm = new Map(cats.map((c) => [String(c._id), c.name]));
  ok(res, items.map((t) => ({ ...normalise(t), storageKey: undefined, category: t.categoryId ? cm.get(String(t.categoryId)) ?? '' : '', addedBy: um.get(String(t.createdById)) ?? '', progress: pm.get(String(t._id)) ? { status: pm.get(String(t._id))!.status, progressPct: pm.get(String(t._id))!.progressPct, positionSec: pm.get(String(t._id))!.positionSec } : { status: 'not_started', progressPct: 0, positionSec: 0 } })));
}));

/** Admin overview: totals + completion. */
trainingRouter.get('/overview', requirePermission('training.view_progress', 'training.manage'), asyncHandler(async (req, res) => {
  const orgId = new Types.ObjectId(req.user!.orgId);
  const [total, active, users, byStatus] = await Promise.all([
    Training.countDocuments({ orgId }), Training.countDocuments({ orgId, isActive: true }), User.countDocuments({ orgId, isActive: true }),
    TrainingProgress.aggregate<{ _id: string; n: number }>([{ $match: { orgId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const s = Object.fromEntries(byStatus.map((b) => [b._id, b.n]));
  ok(res, { total, active, inactive: total - active, users, completed: s.completed ?? 0, inProgress: s.in_progress ?? 0, pending: Math.max(0, active * users - (s.completed ?? 0) - (s.in_progress ?? 0)) });
}));

async function trainingBody(req: import('express').Request) {
  const schema = z.object({ title: z.string().min(1).max(160), description: z.string().max(3000).optional(), type: z.enum(TRAINING_TYPES), categoryId: objectId.nullable().optional(), url: z.string().max(2000).optional(), content: z.string().max(50_000).optional(), durationSec: z.coerce.number().int().min(0).optional(), isActive: z.coerce.boolean().optional(), isNew: z.coerce.boolean().optional(), allowDownload: z.coerce.boolean().optional(), order: z.coerce.number().int().optional() });
  const b = schema.parse({ ...req.body, categoryId: req.body.categoryId || null, isActive: req.body.isActive ?? true, isNew: req.body.isNew ?? false, allowDownload: req.body.allowDownload ?? false });
  const audience = req.body.audience !== undefined ? normaliseAudience(audienceSchema.parse(typeof req.body.audience === 'string' ? JSON.parse(req.body.audience) : req.body.audience)) : undefined;
  if ((b.type === 'video_link' || b.type === 'external_link') && !(b.url && isHttpUrl(b.url))) throw badRequest(b.type === 'video_link' ? 'Enter a valid video URL (YouTube, Vimeo or a direct https link)' : 'Enter a valid https URL');
  if (b.type === 'tutorial' && !b.content?.trim()) throw badRequest('Add the tutorial content');
  return { b, audience };
}
async function storeFile(orgId: string, type: string, file?: Express.Multer.File) {
  if (!file) return null;
  const ext = path.extname(file.originalname).slice(1).toLowerCase();
  const table = type === 'video_upload' ? VIDEO_EXT : DOC_EXT;
  if (!table[ext]) throw badRequest(`Unsupported file type .${ext}. Allowed: ${Object.keys(table).join(', ')}`);
  const org = await Organisation.findById(orgId).select('settings.training settings.files').lean();
  const maxMb = type === 'video_upload' ? org?.settings?.training?.maxVideoSizeMb ?? 500 : org?.settings?.files?.maxSizeMb ?? 25;
  if (file.size > maxMb * 1024 * 1024) throw badRequest(`File exceeds the ${maxMb} MB limit`);
  const driver = storage(); const key = buildStorageKey(orgId, 'training', file.originalname);
  await driver.putObject(key, file.buffer, table[ext]);
  return { fileName: file.originalname, mimeType: table[ext], size: file.size, storageDriver: driver.name, storageKey: key };
}

trainingRouter.post('/', requirePermission('training.manage'), upload.single('file'), asyncHandler(async (req, res) => {
  const { b, audience } = await trainingBody(req);
  const file = await storeFile(req.user!.orgId, b.type, req.file);
  if ((b.type === 'video_upload' || b.type === 'document') && !file) throw badRequest('Upload the training file');
  const t = await Training.create({ ...b, ...(file ?? {}), audience: audience ?? { all: true }, orgId: req.user!.orgId, createdById: req.user!.id });
  audit(req.user!, { action: 'training.create', entity: 'Training', entityId: t._id, summary: `Added training "${t.title}"`, ip: req.ip });
  created(res, t.toJSON());
}));
trainingRouter.patch('/:id', requirePermission('training.manage'), validate({ params: idParam }), upload.single('file'), asyncHandler(async (req, res) => {
  const t = await Training.findOne({ _id: req.params.id, orgId: req.user!.orgId }); if (!t) throw notFound('Training');
  const before = t.toJSON();
  const partial = z.object({ title: z.string().min(1).max(160).optional(), description: z.string().max(3000).optional(), categoryId: objectId.nullable().optional(), url: z.string().max(2000).optional(), content: z.string().max(50_000).optional(), durationSec: z.coerce.number().int().min(0).optional(), isActive: z.coerce.boolean().optional(), isNew: z.coerce.boolean().optional(), allowDownload: z.coerce.boolean().optional(), order: z.coerce.number().int().optional() }).parse({ ...req.body, categoryId: req.body.categoryId === '' ? null : req.body.categoryId });
  if (partial.url !== undefined && (t.type === 'video_link' || t.type === 'external_link') && !isHttpUrl(partial.url)) throw badRequest('Enter a valid https URL');
  if (req.body.audience !== undefined) t.audience = normaliseAudience(audienceSchema.parse(typeof req.body.audience === 'string' ? JSON.parse(req.body.audience) : req.body.audience)) as never;
  const file = await storeFile(req.user!.orgId, t.type, req.file);
  if (file) { const old = t.storageKey; t.set(file); if (old) storage().deleteObject(old).catch(() => undefined); }
  t.set(partial); await t.save();
  audit(req.user!, { action: req.body.audience !== undefined ? 'training.visibility' : 'training.update', entity: 'Training', entityId: t._id, summary: `${req.body.audience !== undefined ? 'Changed visibility of' : 'Updated'} training "${t.title}"`, before, after: t.toJSON(), ip: req.ip });
  ok(res, t.toJSON());
}));
trainingRouter.delete('/:id', requirePermission('training.manage'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const t = await Training.findOne({ _id: req.params.id, orgId: req.user!.orgId }); if (!t) throw notFound('Training');
  if (t.storageKey) storage().deleteObject(t.storageKey).catch(() => undefined);
  await Promise.all([t.deleteOne(), TrainingProgress.deleteMany({ trainingId: t._id })]);
  audit(req.user!, { action: 'training.delete', entity: 'Training', entityId: t._id, summary: `Deleted training "${t.title}"`, ip: req.ip });
  ok(res, { deleted: true });
}));

async function visibleTraining(req: import('express').Request) {
  const t = await Training.findOne({ _id: req.params.id, orgId: req.user!.orgId }).lean(); if (!t) throw notFound('Training');
  const manager = req.user!.role === 'admin' || req.user!.permissions.has('training.manage');
  if ((!t.isActive && !manager) || !canSee(req.user!, t.audience)) throw forbidden('Access denied');
  return t;
}
trainingRouter.get('/:id', requirePermission('training.view'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const t = await visibleTraining(req);
  const [creator, cat, progress] = await Promise.all([User.findById(t.createdById).select('name').lean(), t.categoryId ? TrainingCategory.findById(t.categoryId).select('name').lean() : null, TrainingProgress.findOne({ trainingId: t._id, userId: req.user!.id }).lean()]);
  const needsToken = t.type === 'video_upload' || t.type === 'document';
  ok(res, { ...normalise(t), storageKey: undefined, addedBy: creator?.name ?? '', category: cat?.name ?? '', progress: progress ? normalise(progress) : null, viewToken: needsToken ? signViewToken(req.user!.id, `training:${t._id}`, 3600) : null, viewUrl: needsToken ? `/api/v1/training/${t._id}/view` : null, canDownload: t.allowDownload && (req.user!.role === 'admin' || req.user!.permissions.has('files.download')) });
}));

/** Streams uploaded video/document with HTTP Range support (seeking). Token bound to this item + user. Mounted before requireAuth. */
export const trainingViewHandlers = [validate({ params: idParam }), asyncHandler(async (req, res) => {
  let userId: string; try { userId = verifyViewToken(String(req.query.token ?? ''), `training:${req.params.id}`); } catch { throw unauthorized('View link expired. Open the training again.'); }
  const user = await buildAuthUser(userId); if (!user) throw unauthorized();
  const t = await Training.findOne({ _id: req.params.id, orgId: user.orgId }).lean(); if (!t || !t.storageKey) throw notFound('Training file');
  if ((!t.isActive && user.role !== 'admin') || !canSee(user, t.audience)) throw forbidden('Access denied');
  res.setHeader('Content-Type', t.mimeType); res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Disposition', 'inline');
  if (t.storageDriver === 'local') {
    const full = path.resolve(env.LOCAL_STORAGE_DIR, t.storageKey); const stat = fs.statSync(full);
    const range = req.headers.range;
    if (range) {
      const [s, e] = range.replace(/bytes=/, '').split('-'); const start = Number(s) || 0; const end = e ? Math.min(Number(e), stat.size - 1) : Math.min(start + 4 * 1024 * 1024 - 1, stat.size - 1);
      res.status(206); res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`); res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(full, { start, end }).pipe(res);
    }
    res.setHeader('Content-Length', stat.size); res.setHeader('Accept-Ranges', 'bytes');
    return fs.createReadStream(full).pipe(res);
  }
  // S3: hand off to a short-lived presigned GET so the browser can range-request directly.
  res.redirect(302, await storage().presignDownload(t.storageKey, t.fileName));
})];

trainingRouter.post('/:id/progress', requirePermission('training.view'), validate({ params: idParam, body: z.object({ positionSec: z.number().min(0).optional(), durationSec: z.number().min(0).optional(), completed: z.boolean().optional() }) }), asyncHandler(async (req, res) => {
  const t = await visibleTraining(req);
  const pct = req.body.completed ? 100 : req.body.durationSec ? Math.min(100, Math.round(((req.body.positionSec ?? 0) / req.body.durationSec) * 100)) : undefined;
  const set: Record<string, unknown> = { lastViewedAt: new Date(), ...(req.body.positionSec !== undefined ? { positionSec: req.body.positionSec } : {}), ...(pct !== undefined ? { progressPct: pct } : {}) };
  if (req.body.completed || pct === 100) { set.status = 'completed'; set.completedAt = new Date(); } else set.status = 'in_progress';
  const p = await TrainingProgress.findOneAndUpdate({ trainingId: t._id, userId: req.user!.id }, { $set: set, $setOnInsert: { orgId: req.user!.orgId } }, { upsert: true, new: true });
  ok(res, p.toJSON());
}));
trainingRouter.get('/:id/progress', requirePermission('training.view_progress', 'training.manage'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const rows = await TrainingProgress.find({ trainingId: req.params.id, orgId: req.user!.orgId }).lean();
  const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } }).select('name role avatarColor').lean();
  const um = new Map(users.map((u) => [String(u._id), normalise(u)]));
  ok(res, rows.map((r) => ({ ...normalise(r), user: um.get(String(r.userId)) ?? null })));
}));

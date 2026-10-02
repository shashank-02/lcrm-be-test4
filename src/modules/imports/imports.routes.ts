import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { Types } from 'mongoose';
import { parse } from 'csv-parse/sync';
import { asyncHandler, ok, created } from '../../common/http';
import { badRequest, notFound } from '../../common/errors';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/auth';
import { idParam, normalise } from '../../common/crud';
import { paginationQuery, toSkipLimit, buildMeta } from '../../common/pagination';
import { FieldDefinition, ImportJob, User } from '../../models';
import { buildStorageKey, storage } from '../../services/storage.service';
import { visibleTeamIds } from '../../services/scope.service';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { runImport, LEAD_IMPORT_TARGETS } from './import.service';

export const importsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const objectId = z.string().refine((v) => Types.ObjectId.isValid(v), 'Invalid id');

/** Fields a CSV column can be mapped onto (system + custom.<key>). */
importsRouter.get('/targets', requirePermission('lead.import'), asyncHandler(async (req, res) => {
  const custom = await FieldDefinition.find({ orgId: req.user!.orgId, isActive: true }).select('key label type').lean();
  ok(res, { system: LEAD_IMPORT_TARGETS, custom: custom.map((c) => ({ key: `custom.${c.key}`, label: c.label, type: c.type })) });
}));

/** Preview: parse headers + first rows so the UI can build the column mapping. */
importsRouter.post('/preview', requirePermission('lead.import'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Attach a CSV file in the "file" field');
  const records = parseCsv(req.file.buffer, 6);
  const headers = records.length ? Object.keys(records[0]) : [];
  ok(res, { headers, sample: records.slice(0, 5), suggestedMapping: suggestMapping(headers) });
}));

const startSchema = z.object({
  mapping: z.string().transform((s, ctx) => { try { return JSON.parse(s) as Record<string, string>; } catch { ctx.addIssue({ code: 'custom', message: 'mapping must be JSON' }); return z.NEVER; } }),
  importType: z.enum(['create', 'upsert']).default('create'),
  stageId: objectId.optional(), statusId: objectId.optional(), sourceId: objectId.optional(),
  ownerId: objectId.optional(), teamId: objectId.optional(),
  applyAssignmentRules: z.enum(['true', 'false']).default('true'),
});

/** Start an import. Processing runs asynchronously in-process; poll GET /imports/:id. */
importsRouter.post('/', requirePermission('lead.import'), upload.single('file'), validate({ body: startSchema }), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Attach a CSV file in the "file" field');
  const body = req.body as unknown as z.infer<typeof startSchema>;
  if (!Object.values(body.mapping).includes('phone')) throw badRequest('Map a column to "phone" — it identifies each lead');
  const records = parseCsv(req.file.buffer);
  if (!records.length) throw badRequest('CSV has no data rows');
  if (records.length > env.MAX_IMPORT_ROWS) throw badRequest(`CSV exceeds ${env.MAX_IMPORT_ROWS} rows; split the file`);

  const driver = storage();
  const key = buildStorageKey(req.user!.orgId, 'imports', req.file.originalname);
  await driver.putObject(key, req.file.buffer, 'text/csv');

  const job = await ImportJob.create({
    orgId: req.user!.orgId, fileName: req.file.originalname, storageKey: key, storageDriver: driver.name,
    importType: body.importType, mapping: body.mapping,
    defaults: { stageId: body.stageId ?? null, statusId: body.statusId ?? null, sourceId: body.sourceId ?? null, ownerId: body.ownerId ?? null, teamId: body.teamId ?? null, applyAssignmentRules: body.applyAssignmentRules === 'true' },
    status: 'pending', totals: { rows: records.length }, startedById: req.user!.id,
  });
  // Fire and forget — the job document is the source of truth for progress.
  setImmediate(() => runImport(job._id, records, req.user!).catch((err) => logger.error({ err, jobId: job._id }, 'Import crashed')));
  created(res, job.toJSON());
}));

importsRouter.get('/', requirePermission('lead.import', 'admin.imports'), validate({ query: paginationQuery }), asyncHandler(async (req, res) => {
  const q = req.query as unknown as z.infer<typeof paginationQuery>;
  const filter: Record<string, unknown> = { orgId: req.user!.orgId };
  if (visibleTeamIds(req.user!) && !req.user!.permissions.has('admin.imports')) filter.startedById = req.user!.id;
  const [jobs, total] = await Promise.all([
    ImportJob.find(filter).select('-rowErrors').sort({ createdAt: -1 }).skip(toSkipLimit(q).skip).limit(q.limit).lean(),
    ImportJob.countDocuments(filter),
  ]);
  const users = await User.find({ _id: { $in: jobs.map((j) => j.startedById) } }).select('name').lean();
  const um = new Map(users.map((u) => [String(u._id), normalise(u)]));
  ok(res, jobs.map((j) => ({ ...normalise(j), startedBy: um.get(String(j.startedById)) ?? null })), buildMeta(q, total));
}));

importsRouter.get('/:id', requirePermission('lead.import', 'admin.imports'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const job = await ImportJob.findOne({ _id: req.params.id, orgId: req.user!.orgId }).lean();
  if (!job) throw notFound('Import');
  ok(res, { ...normalise(job), errors: job.rowErrors.slice(0, 200), errorCount: job.rowErrors.length });
}));

importsRouter.get('/:id/errors.csv', requirePermission('lead.import', 'admin.imports'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const job = await ImportJob.findOne({ _id: req.params.id, orgId: req.user!.orgId }).lean();
  if (!job) throw notFound('Import');
  const headers = Array.from(new Set(job.rowErrors.flatMap((e) => Object.keys((e.data as Record<string, unknown>) ?? {}))));
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [['row', 'error', ...headers].join(','), ...job.rowErrors.map((e) => [e.row, e.message, ...headers.map((h) => (e.data as Record<string, unknown>)?.[h])].map(esc).join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="import-${job._id}-errors.csv"`);
  res.send(lines.join('\n'));
}));

importsRouter.get('/:id/file', requirePermission('lead.import', 'admin.imports'), validate({ params: idParam }), asyncHandler(async (req, res) => {
  const job = await ImportJob.findOne({ _id: req.params.id, orgId: req.user!.orgId }).lean();
  if (!job || !job.storageKey) throw notFound('Import file');
  const buf = await storage().getObject(job.storageKey);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${job.fileName}"`);
  res.send(buf);
}));

function parseCsv(buffer: Buffer, limit?: number): Record<string, string>[] {
  try {
    return parse(buffer, { columns: (h: string[]) => h.map((x) => x.trim()), skip_empty_lines: true, trim: true, bom: true, relax_column_count: true, to: limit }) as Record<string, string>[];
  } catch (e) {
    throw badRequest(`Could not parse CSV: ${(e as Error).message}`);
  }
}

function suggestMapping(headers: string[]) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const dict: Record<string, string> = { name: 'name', fullname: 'name', customername: 'name', phone: 'phone', mobile: 'phone', phonenumber: 'phone', mobilenumber: 'phone', contact: 'phone', email: 'email', emailid: 'email', city: 'city', state: 'state', country: 'country', language: 'language', source: 'source', leadsource: 'source', stage: 'stage', status: 'status', owner: 'owner', assignedto: 'owner', remarks: 'remarks', notes: 'remarks', nextfollowup: 'nextFollowUpAt', followup: 'nextFollowUpAt', altphone: 'altPhone', alternatephone: 'altPhone', createdat: 'createdAt', leadcreatedat: 'createdAt' };
  const out: Record<string, string> = {};
  for (const h of headers) { const t = dict[norm(h)]; if (t) out[h] = t; }
  return out;
}

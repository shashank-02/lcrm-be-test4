import { Router, type Request } from 'express';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { z, type ZodTypeAny } from 'zod';
import { asyncHandler, ok, created } from './http';
import { notFound } from './errors';
import { validate } from '../middleware/validate';
import { requirePermission } from '../middleware/auth';

export const idParam = z.object({ id: z.string().refine((v) => Types.ObjectId.isValid(v), 'Invalid id') });

interface CrudOptions {
  model: Model<any>;
  entityName: string;
  createSchema: ZodTypeAny;
  updateSchema: ZodTypeAny;
  /** Permission required to create / update / delete. Reads are open to any authenticated user. */
  managePermission: string;
  sort?: Record<string, 1 | -1>;
  /** Throw to block deletion (e.g. when the entity is referenced by leads). */
  beforeDelete?: (doc: Record<string, unknown>, req: Request) => Promise<void>;
  /** Mutate/validate payload before create or update. */
  beforeSave?: (data: Record<string, unknown>, req: Request, existing?: Record<string, unknown>) => Promise<void>;
  supportsReorder?: boolean;
}

/**
 * Generic org-scoped CRUD router for configuration entities
 * (stages, statuses, sources, templates, fields, rules...). Keeps every module consistent.
 */
export function crudRouter(opts: CrudOptions) {
  const r = Router();
  const { model, entityName, sort = { order: 1, createdAt: 1 } } = opts;

  r.get(
    '/',
    asyncHandler(async (req, res) => {
      const filter: Record<string, unknown> = { orgId: req.user!.orgId };
      if (req.query.includeInactive !== 'true' && model.schema.path('isActive')) filter.isActive = true;
      const docs = (await model.find(filter).sort(sort).lean()) as Record<string, unknown>[];
      ok(res, docs.map((d) => normalise(d as { _id: unknown })));
    }),
  );

  r.get(
    '/:id',
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      const doc = (await model.findOne({ _id: req.params.id, orgId: req.user!.orgId }).lean()) as { _id: unknown } | null;
      if (!doc) throw notFound(entityName);
      ok(res, normalise(doc));
    }),
  );

  r.post(
    '/',
    requirePermission(opts.managePermission),
    validate({ body: opts.createSchema }),
    asyncHandler(async (req, res) => {
      const data = { ...req.body, orgId: req.user!.orgId };
      if (opts.beforeSave) await opts.beforeSave(data, req);
      const doc = await model.create(data);
      created(res, doc.toJSON());
    }),
  );

  if (opts.supportsReorder) {
    r.post(
      '/reorder',
      requirePermission(opts.managePermission),
      validate({ body: z.object({ ids: z.array(z.string()).min(1) }) }),
      asyncHandler(async (req, res) => {
        const ids: string[] = req.body.ids;
        await model.bulkWrite(
          ids.map((id, order) => ({ updateOne: { filter: { _id: id, orgId: req.user!.orgId }, update: { $set: { order } } } })),
        );
        ok(res, { reordered: ids.length });
      }),
    );
  }

  r.patch(
    '/:id',
    requirePermission(opts.managePermission),
    validate({ params: idParam, body: opts.updateSchema }),
    asyncHandler(async (req, res) => {
      const existing = await model.findOne({ _id: req.params.id, orgId: req.user!.orgId });
      if (!existing) throw notFound(entityName);
      const data = { ...req.body };
      if (opts.beforeSave) await opts.beforeSave(data, req, existing.toObject());
      existing.set(data);
      await existing.save();
      ok(res, existing.toJSON());
    }),
  );

  r.delete(
    '/:id',
    requirePermission(opts.managePermission),
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      const existing = await model.findOne({ _id: req.params.id, orgId: req.user!.orgId });
      if (!existing) throw notFound(entityName);
      if (opts.beforeDelete) await opts.beforeDelete(existing.toObject(), req);
      await existing.deleteOne();
      ok(res, { deleted: true });
    }),
  );

  return r;
}

/** `.lean()` bypasses the toJSON plugin — normalise manually. */
export function normalise<T extends { _id?: unknown; __v?: unknown }>(doc: T): Omit<T, '_id' | '__v'> & { id: string } {
  const { _id, __v, ...rest } = doc;
  void __v;
  return { ...rest, id: String(_id) } as Omit<T, '_id' | '__v'> & { id: string };
}

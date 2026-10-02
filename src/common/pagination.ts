import { z } from 'zod';
import type { PageMeta } from './http';

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  sortBy: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

export function toSkipLimit(q: PaginationQuery) {
  return { skip: (q.page - 1) * q.limit, limit: q.limit };
}

export function buildMeta(q: PaginationQuery, total: number): PageMeta {
  return { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) };
}

/** Build a mongoose sort object, whitelisting sortable fields to avoid unindexed sorts. */
export function buildSort(q: PaginationQuery, allowed: readonly string[], fallback = 'createdAt') {
  const field = q.sortBy && allowed.includes(q.sortBy) ? q.sortBy : fallback;
  return { [field]: q.sortDir === 'asc' ? 1 : -1 } as Record<string, 1 | -1>;
}

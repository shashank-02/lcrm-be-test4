import { buildMeta, buildSort, paginationQuery, toSkipLimit } from '../../src/common/pagination';
import { todayRange } from '../../src/common/dates';
import { computeQualityScore } from '../../src/modules/leads/lead.service';

describe('pagination', () => {
  it('parses defaults and computes skip/limit and meta', () => {
    const q = paginationQuery.parse({ page: '3', limit: '25' });
    expect(toSkipLimit(q)).toEqual({ skip: 50, limit: 25 });
    expect(buildMeta(q, 101)).toEqual({ page: 3, limit: 25, total: 101, totalPages: 5 });
  });
  it('whitelists sort fields', () => {
    const q = paginationQuery.parse({ sortBy: 'passwordHash', sortDir: 'asc' });
    expect(buildSort(q, ['name', 'createdAt'])).toEqual({ createdAt: 1 });
    expect(buildSort(paginationQuery.parse({ sortBy: 'name' }), ['name'])).toEqual({ name: -1 });
  });
});

describe('todayRange', () => {
  it('returns a 24h window in the org timezone', () => {
    const ref = new Date('2025-03-10T20:30:00Z'); // 02:00 IST on Mar 11
    const { start, end } = todayRange('Asia/Kolkata', ref);
    expect(start.toISOString()).toBe('2025-03-10T18:30:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(86_400_000);
  });
});

describe('computeQualityScore', () => {
  it('rewards completeness, engagement and pipeline progress, capped at 100', () => {
    expect(computeQualityScore({})).toBe(0);
    const partial = computeQualityScore({ name: 'A', email: 'a@b.c', contactCount: 2 });
    expect(partial).toBe(30);
    const full = computeQualityScore({ name: 'A', email: 'a@b.c', city: 'X', sourceId: 'y', customFields: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }, contactCount: 10, nextFollowUpAt: new Date(), stageOrder: 7, stageCount: 8 });
    expect(full).toBe(100);
  });
});

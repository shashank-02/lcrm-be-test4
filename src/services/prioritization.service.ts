import dayjs from 'dayjs';
import { Lead, PrioritizationRule } from '../models';
import type { Types } from 'mongoose';

type Rule = { factor: string; fieldKey: string; operator: string; value: unknown; points: number };
type LeadLike = { qualityScore?: number; contactCount?: number; nextFollowUpAt?: Date | null; stageId?: unknown; statusId?: unknown; sourceId?: unknown; createdAt?: Date; customFields?: Record<string, unknown> };

function factorValue(rule: Rule, lead: LeadLike): unknown {
  switch (rule.factor) {
    case 'qualityScore': return lead.qualityScore ?? 0;
    case 'contactCount': return lead.contactCount ?? 0;
    case 'nextFollowUpAt': return lead.nextFollowUpAt ?? null;
    case 'stage': return lead.stageId ? String(lead.stageId) : null;
    case 'status': return lead.statusId ? String(lead.statusId) : null;
    case 'source': return lead.sourceId ? String(lead.sourceId) : null;
    case 'leadAgeDays': return lead.createdAt ? dayjs().diff(lead.createdAt, 'day') : 0;
    case 'customField': return lead.customFields?.[rule.fieldKey];
    default: return null;
  }
}

/** Pure evaluation — unit tested. */
export function matchesRule(rule: Rule, lead: LeadLike): boolean {
  const v = factorValue(rule, lead);
  const target = rule.value;
  const num = (x: unknown) => (x instanceof Date ? x.getTime() : Number(x));
  switch (rule.operator) {
    case 'exists': return v !== null && v !== undefined && v !== '';
    case 'eq': return String(v ?? '') === String(target ?? '');
    case 'neq': return String(v ?? '') !== String(target ?? '');
    case 'gt': return v != null && num(v) > num(target);
    case 'gte': return v != null && num(v) >= num(target);
    case 'lt': return v != null && num(v) < num(target);
    case 'lte': return v != null && num(v) <= num(target);
    case 'in': return Array.isArray(target) && target.map(String).includes(String(v ?? ''));
    case 'overdue': return v instanceof Date && v < new Date();
    case 'due_today': return v instanceof Date && dayjs(v).isSame(dayjs(), 'day');
    default: return false;
  }
}

export function computePriority(rules: Rule[], lead: LeadLike): number {
  return Math.max(0, Math.min(100, rules.reduce((sum, r) => (matchesRule(r, lead) ? sum + r.points : sum), 0)));
}

const cache = new Map<string, { rules: Rule[]; at: number }>();
export async function activeRules(orgId: unknown): Promise<Rule[]> {
  const k = String(orgId); const c = cache.get(k);
  if (c && Date.now() - c.at < 30_000) return c.rules;
  const rules = (await PrioritizationRule.find({ orgId, isActive: true }).sort({ order: 1 }).lean()) as unknown as Rule[];
  cache.set(k, { rules, at: Date.now() });
  return rules;
}
export const invalidateRuleCache = (orgId: unknown) => cache.delete(String(orgId));

/** Recompute and persist priority for one lead (cheap: one indexed read + one write). */
export async function recomputeLeadPriority(orgId: unknown, leadId: Types.ObjectId | string) {
  const rules = await activeRules(orgId);
  const lead = await Lead.findById(leadId).select('qualityScore contactCount nextFollowUpAt stageId statusId sourceId createdAt customFields priority').lean();
  if (!lead) return;
  const p = computePriority(rules, lead as LeadLike);
  if (p !== lead.priority) await Lead.updateOne({ _id: leadId }, { $set: { priority: p } });
}

/** Batch recompute for an org (admin action) — processes in pages to keep memory flat. */
export async function recomputeAllPriorities(orgId: unknown) {
  const rules = await activeRules(orgId);
  let updated = 0;
  const cursor = Lead.find({ orgId, isDeleted: false }).select('qualityScore contactCount nextFollowUpAt stageId statusId sourceId createdAt customFields priority').lean().cursor();
  let ops: { updateOne: { filter: { _id: unknown }; update: { $set: { priority: number } } } }[] = [];
  for await (const lead of cursor) {
    const p = computePriority(rules, lead as LeadLike);
    if (p !== lead.priority) ops.push({ updateOne: { filter: { _id: lead._id }, update: { $set: { priority: p } } } });
    if (ops.length >= 500) { await Lead.bulkWrite(ops as never, { ordered: false }); updated += ops.length; ops = []; }
  }
  if (ops.length) { await Lead.bulkWrite(ops as never, { ordered: false }); updated += ops.length; }
  return updated;
}

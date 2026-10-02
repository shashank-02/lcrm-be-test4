import { Types } from 'mongoose';
import dayjs from 'dayjs';
import { Lead, Organisation, Stage, TopUpReminder, User } from '../models';
import { logActivity } from './activity.service';
import { notify } from './notification.service';
import { logger } from '../config/logger';

/**
 * Start (or keep) the post-disbursement top-up timer for a lead. Idempotent per disbursement day.
 * `disbursedAt` defaults to now; leads carrying a `disbursedDate` custom field use that.
 */
export async function ensureTopUpReminder(orgId: Types.ObjectId | string, leadId: Types.ObjectId, opts: { disbursedAt?: Date | null } = {}) {
  const lead = await Lead.findById(leadId).select('ownerId customFields isDeleted').lean();
  if (!lead || lead.isDeleted) return null;
  const org = await Organisation.findById(orgId).select('settings.topUpReminderMonths').lean();
  const months = org?.settings?.topUpReminderMonths ?? 3;
  const custom = (lead.customFields as Record<string, unknown> | undefined)?.disbursedDate;
  const disbursedAt = opts.disbursedAt ?? (custom ? new Date(String(custom)) : new Date());
  if (Number.isNaN(disbursedAt.getTime())) return null;
  const cycleKey = `${leadId}:${dayjs(disbursedAt).format('YYYY-MM-DD')}`;
  const dueAt = dayjs(disbursedAt).add(months, 'month').toDate();
  try {
    const existing = await TopUpReminder.findOne({ orgId, cycleKey }).lean();
    if (existing) return existing;
    const r = await TopUpReminder.create({ orgId, leadId, ownerId: lead.ownerId ?? null, disbursedAt, dueAt, cycleKey, status: dueAt <= new Date() ? 'due' : 'scheduled' });
    await logActivity({ orgId, leadId, userId: null, type: 'topup_scheduled', description: `Top-up follow-up scheduled for ${dayjs(dueAt).format('DD-MMM-YYYY')}`, payload: { reminderId: r._id, dueAt } });
    return r;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return TopUpReminder.findOne({ orgId, cycleKey }).lean();
    logger.warn({ err }, 'ensureTopUpReminder failed');
    return null;
  }
}

/** Called by the scheduler: notify owners of reminders that became due (or whose snooze ended). */
export async function dispatchDueTopUps(now = new Date()) {
  const due = await TopUpReminder.find({
    $or: [{ status: 'scheduled', dueAt: { $lte: now } }, { status: 'snoozed', snoozedUntil: { $lte: now } }],
  }).limit(500).lean();
  let n = 0;
  for (const r of due) {
    const lead = await Lead.findById(r.leadId).select('name phone ownerId isDeleted').lean();
    if (!lead || lead.isDeleted) { await TopUpReminder.updateOne({ _id: r._id }, { $set: { status: 'dismissed' } }); continue; }
    const ownerId = lead.ownerId ?? r.ownerId;
    await TopUpReminder.updateOne({ _id: r._id }, { $set: { status: 'due', notifiedAt: now, ownerId, snoozedUntil: null } });
    if (ownerId) {
      await notify({
        orgId: r.orgId, userId: ownerId, leadId: r.leadId, leadName: lead.name || lead.phone, type: 'topup_due', scheduledAt: r.dueAt,
        title: 'Top-up follow-up due', body: `${lead.name || lead.phone}'s loan was disbursed ${dayjs(r.disbursedAt).fromNow()}. Contact the customer to check interest in a top-up.`,
        ref: { kind: 'topup', id: r._id }, dedupeKey: `topup_due:${r._id}:${r.status === 'snoozed' ? String(r.snoozedUntil?.getTime()) : 'first'}`,
      });
    }
    n++;
  }
  return n;
}

/** Backfill for leads already in a won/disbursed stage before this feature existed. */
export async function backfillTopUpReminders(orgId: Types.ObjectId | string) {
  const wonStages = await Stage.find({ orgId, isWon: true }).select('_id').lean();
  if (!wonStages.length) return 0;
  const leads = await Lead.find({ orgId, isDeleted: false, stageId: { $in: wonStages.map((s) => s._id) } }).select('_id updatedAt customFields').lean();
  const existing = new Set((await TopUpReminder.find({ orgId, leadId: { $in: leads.map((l) => l._id) } }).select('leadId').lean()).map((r) => String(r.leadId)));
  let created = 0;
  for (const l of leads) {
    if (existing.has(String(l._id))) continue;
    const custom = (l.customFields as Record<string, unknown> | undefined)?.disbursedDate;
    const r = await ensureTopUpReminder(orgId, l._id, { disbursedAt: custom ? new Date(String(custom)) : l.updatedAt });
    if (r) created++;
  }
  return created;
}

export async function ownerName(id: unknown) { const u = id ? await User.findById(id).select('name').lean() : null; return u?.name ?? ''; }

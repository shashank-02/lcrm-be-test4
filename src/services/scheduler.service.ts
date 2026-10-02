import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { Lead, Note, Task, Organisation, Notification, Stage } from '../models';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { notify } from './notification.service';
import { dispatchDueTopUps } from './topup.service';
import { sweepStaleSessions } from './session.service';
dayjs.extend(relativeTime);

/**
 * Lightweight in-process scheduler (one tick per minute). Every query hits an index and every
 * generated notification carries a dedupeKey, so running several API instances is safe.
 */
let timer: NodeJS.Timeout | null = null;
let running = false;

export function startScheduler() {
  if (env.SCHEDULER_ENABLED !== 'true' || timer) return;
  timer = setInterval(() => { tick().catch((err) => logger.error({ err }, 'scheduler tick failed')); }, env.SCHEDULER_INTERVAL_MS);
  timer.unref();
  tick().catch((err) => logger.error({ err }, 'scheduler first tick failed'));
  logger.info('Scheduler started');
}
export function stopScheduler() { if (timer) clearInterval(timer); timer = null; }

export async function tick(now = new Date()) {
  if (running) return; running = true;
  try {
    await Promise.all([followUpsDue(now), followUpsOverdue(now), tasksDue(now), noteReminders(now), wakeSnoozed(now), dispatchDueTopUps(now), sweepStaleSessions(now)]);
  } finally { running = false; }
}

/** Follow-up time has arrived (within the last 24h window to survive downtime). */
async function followUpsDue(now: Date) {
  const since = dayjs(now).subtract(24, 'hour').toDate();
  const leads = await Lead.find({ isDeleted: false, ownerId: { $ne: null }, nextFollowUpAt: { $gt: since, $lte: now } }).select('orgId ownerId name phone nextFollowUpAt').limit(1000).lean();
  for (const l of leads) {
    await notify({ orgId: l.orgId, userId: l.ownerId!, leadId: l._id, leadName: l.name || l.phone, type: 'followup_due', scheduledAt: l.nextFollowUpAt, title: 'Follow-up due', body: `Call ${l.name || l.phone} for the scheduled follow-up at ${dayjs(l.nextFollowUpAt).format('hh:mm A')}.`, dedupeKey: `followup_due:${l._id}:${l.nextFollowUpAt!.getTime()}` });
  }
}

/** Follow-up passed more than 30 minutes ago and the lead was not contacted since. */
async function followUpsOverdue(now: Date) {
  const cutoff = dayjs(now).subtract(30, 'minute').toDate();
  const since = dayjs(now).subtract(7, 'day').toDate();
  const leads = await Lead.find({ isDeleted: false, ownerId: { $ne: null }, nextFollowUpAt: { $gt: since, $lte: cutoff } }).select('orgId ownerId name phone nextFollowUpAt lastContactedAt').limit(1000).lean();
  for (const l of leads) {
    if (l.lastContactedAt && l.lastContactedAt > l.nextFollowUpAt!) continue;
    await notify({ orgId: l.orgId, userId: l.ownerId!, leadId: l._id, leadName: l.name || l.phone, type: 'followup_overdue', scheduledAt: l.nextFollowUpAt, title: 'Follow-up overdue', body: `${l.name || l.phone} was due ${dayjs(l.nextFollowUpAt).fromNow()} and has not been contacted since.`, dedupeKey: `followup_overdue:${l._id}:${l.nextFollowUpAt!.getTime()}` });
  }
}

async function tasksDue(now: Date) {
  const tasks = await Task.find({ status: 'open', dueAt: { $lte: now }, remindedAt: null }).select('orgId leadId assigneeId createdById title dueAt').limit(500).lean();
  for (const t of tasks) {
    const lead = await Lead.findById(t.leadId).select('name phone').lean();
    await notify({ orgId: t.orgId, userId: t.assigneeId ?? t.createdById, leadId: t.leadId, leadName: lead?.name || lead?.phone, type: 'task_due', scheduledAt: t.dueAt, title: 'Task due', body: `${t.title} — ${lead?.name || lead?.phone || 'lead'}`, ref: { kind: 'task', id: t._id }, dedupeKey: `task_due:${t._id}` });
    await Task.updateOne({ _id: t._id }, { $set: { remindedAt: now } });
  }
}

async function noteReminders(now: Date) {
  const notes = await Note.find({ remindAt: { $lte: now }, remindedAt: null }).select('orgId leadId createdById body remindAt').limit(500).lean();
  for (const n of notes) {
    const lead = await Lead.findById(n.leadId).select('name phone ownerId').lean();
    const target = lead?.ownerId ?? n.createdById;
    await notify({ orgId: n.orgId, userId: target, leadId: n.leadId, leadName: lead?.name || lead?.phone, type: 'note_reminder', scheduledAt: n.remindAt, title: 'Note reminder', body: n.body.slice(0, 160), ref: { kind: 'note', id: n._id }, dedupeKey: `note_reminder:${n._id}` });
    await Note.updateOne({ _id: n._id }, { $set: { remindedAt: now } });
  }
}

/** Snoozed notifications come back as unread when the snooze ends. */
async function wakeSnoozed(now: Date) {
  await Notification.updateMany({ status: 'snoozed', snoozedUntil: { $lte: now } }, { $set: { status: 'pending', readAt: null, snoozedUntil: null } });
}

/** Notify the owner when someone else (admin/manager) acts on their lead. */
export async function notifyOwnerOfAdminAction(actor: { id: string; role: string; name: string }, lead: { _id: unknown; orgId: unknown; ownerId?: unknown; name?: string; phone?: string }, type: 'admin_note' | 'admin_update' | 'admin_status' | 'admin_stage' | 'admin_request', body: string) {
  if (!lead.ownerId || String(lead.ownerId) === actor.id || actor.role === 'agent') return;
  const titles = { admin_note: 'Note added on your lead', admin_update: 'Your lead was updated', admin_status: 'Status changed on your lead', admin_stage: 'Stage changed on your lead', admin_request: 'Action requested' };
  await notify({ orgId: lead.orgId as never, userId: lead.ownerId as never, leadId: lead._id as never, leadName: lead.name || lead.phone, actorId: actor.id, type, title: titles[type], body: `${actor.name}: ${body}`.slice(0, 300) });
}

export async function isWonStage(orgId: unknown, stageId: unknown) {
  if (!stageId) return false;
  const s = await Stage.findOne({ _id: stageId, orgId }).select('isWon').lean();
  return !!s?.isWon;
}
export { Organisation };

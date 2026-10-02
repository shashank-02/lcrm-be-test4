import { Types } from 'mongoose';
import { Notification, type NotificationType } from '../models';
import { logger } from '../config/logger';

const CATEGORY: Record<NotificationType, 'followups' | 'assignments' | 'admin' | 'reminders' | 'general'> = {
  followup_due: 'followups', followup_overdue: 'followups', callback_due: 'followups', task_due: 'reminders', note_reminder: 'reminders', topup_due: 'reminders',
  lead_assigned: 'assignments', lead_reassigned: 'assignments', admin_note: 'admin', admin_update: 'admin', admin_status: 'admin', admin_stage: 'admin', admin_request: 'admin', system: 'general',
};
const PRIORITY: Record<NotificationType, 'high' | 'medium' | 'normal'> = {
  followup_due: 'high', followup_overdue: 'high', callback_due: 'high', topup_due: 'high', admin_request: 'high',
  lead_assigned: 'medium', lead_reassigned: 'medium', admin_note: 'medium', task_due: 'medium', note_reminder: 'medium',
  admin_update: 'normal', admin_status: 'normal', admin_stage: 'normal', system: 'normal',
};

export interface NotifyInput {
  orgId: string | Types.ObjectId; userId: string | Types.ObjectId; type: NotificationType; title: string; body?: string;
  leadId?: string | Types.ObjectId | null; leadName?: string; actorId?: string | Types.ObjectId | null; scheduledAt?: Date | null;
  ref?: { kind: string; id: string | Types.ObjectId }; dedupeKey?: string; priority?: 'high' | 'medium' | 'normal';
}

/** Creates a notification; silently ignores duplicates by dedupeKey. Never throws. */
export async function notify(input: NotifyInput) {
  try {
    // Never notify people about their own actions.
    if (input.actorId && String(input.actorId) === String(input.userId)) return null;
    if (input.dedupeKey && (await Notification.exists({ dedupeKey: input.dedupeKey }))) return null;
    return await Notification.create({
      orgId: input.orgId, userId: input.userId, leadId: input.leadId ?? null, actorId: input.actorId ?? null, type: input.type,
      category: CATEGORY[input.type], priority: input.priority ?? PRIORITY[input.type], title: input.title, body: input.body ?? '',
      leadName: input.leadName ?? '', scheduledAt: input.scheduledAt ?? null, ref: input.ref ? { kind: input.ref.kind, id: input.ref.id } : undefined, dedupeKey: input.dedupeKey ?? null,
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return null; // duplicate reminder — expected
    logger.warn({ err }, 'notification create failed');
    return null;
  }
}

/** When a lead changes owner, pending reminders about it follow the new owner. */
export async function retargetLeadNotifications(leadId: Types.ObjectId | string, newOwnerId: Types.ObjectId | string | null) {
  if (!newOwnerId) return;
  await Notification.updateMany(
    { leadId, status: { $in: ['pending', 'read', 'snoozed'] }, category: { $in: ['followups', 'reminders'] } },
    { $set: { userId: newOwnerId } },
  );
}

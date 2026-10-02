import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../common/mongoose';

export const NOTIFICATION_TYPES = [
  'followup_due', 'followup_overdue', 'callback_due', 'task_due', 'note_reminder', 'topup_due',
  'lead_assigned', 'lead_reassigned', 'admin_note', 'admin_update', 'admin_status', 'admin_stage', 'admin_request', 'system',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export const NOTIFICATION_CATEGORIES = ['followups', 'assignments', 'admin', 'reminders', 'general'] as const;
export const NOTIFICATION_PRIORITIES = ['high', 'medium', 'normal'] as const;
export const NOTIFICATION_STATUSES = ['pending', 'read', 'snoozed', 'completed', 'dismissed'] as const;

/**
 * Persistent per-user notification. Stays until completed/dismissed.
 * `dedupeKey` prevents the scheduler from creating the same reminder twice.
 */
const schema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    category: { type: String, enum: NOTIFICATION_CATEGORIES, required: true },
    priority: { type: String, enum: NOTIFICATION_PRIORITIES, default: 'normal' },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    leadName: { type: String, default: '' },
    scheduledAt: { type: Date, default: null },
    status: { type: String, enum: NOTIFICATION_STATUSES, default: 'pending' },
    readAt: { type: Date, default: null },
    snoozedUntil: { type: Date, default: null },
    actionedAt: { type: Date, default: null },
    /** Related entity for action buttons (reminderId, taskId, noteId...) */
    ref: { kind: { type: String, default: '' }, id: { type: Schema.Types.ObjectId, default: null } },
    dedupeKey: { type: String, default: null },
  },
  { timestamps: true },
);
schema.index({ userId: 1, status: 1, createdAt: -1 });
schema.index({ userId: 1, status: 1, priority: 1 });
schema.index({ userId: 1, category: 1, createdAt: -1 });
schema.index({ orgId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
schema.index({ status: 1, snoozedUntil: 1 });
schema.index({ leadId: 1, status: 1 });
schema.plugin(toJSONPlugin);

export type NotificationDoc = InferSchemaType<typeof schema>;
export const Notification = model('Notification', schema);

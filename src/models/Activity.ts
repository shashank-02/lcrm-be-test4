import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../common/mongoose';

export const ACTIVITY_TYPES = [
  'created', 'updated', 'stage_changed', 'status_changed', 'source_changed', 'assigned', 'unassigned',
  'followup_set', 'followup_reset', 'note_added', 'note_updated', 'note_deleted', 'task_created', 'task_updated',
  'call_logged', 'file_uploaded', 'file_deleted', 'whatsapp_sent', 'email_sent', 'call_initiated',
  'imported', 'deleted', 'restored', 'history_erased', 'bulk_updated', 'topup_scheduled', 'topup_completed', 'topup_snoozed', 'topup_dismissed', 'fb_event',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** Immutable audit trail + lead timeline. Never updated after insert. */
const schema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    description: { type: String, default: '' },
    payload: { type: Schema.Types.Mixed, default: {} },
    /** Set true on "erase history" so the new owner cannot see it; admin can still audit. */
    hidden: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
schema.index({ leadId: 1, createdAt: -1 });
schema.index({ orgId: 1, userId: 1, createdAt: -1 });
schema.index({ orgId: 1, type: 1, createdAt: -1 });
schema.plugin(toJSONPlugin);

export type ActivityDoc = InferSchemaType<typeof schema>;
export const Activity = model('Activity', schema);

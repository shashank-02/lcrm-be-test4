import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../common/mongoose';

export const TOPUP_OUTCOMES = ['interested', 'not_interested', 'call_back_later', 'unable_to_reach', 'already_taken', 'other'] as const;
export const TOPUP_STATUSES = ['scheduled', 'due', 'snoozed', 'completed', 'dismissed'] as const;

/** One reminder per disbursement cycle. Created automatically when a lead reaches a won/disbursed stage. */
const schema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    disbursedAt: { type: Date, required: true },
    dueAt: { type: Date, required: true },
    status: { type: String, enum: TOPUP_STATUSES, default: 'scheduled' },
    snoozedUntil: { type: Date, default: null },
    notifiedAt: { type: Date, default: null },
    outcome: { type: String, enum: [...TOPUP_OUTCOMES, ''], default: '' },
    outcomeNotes: { type: String, default: '' },
    completedAt: { type: Date, default: null },
    completedById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Cycle key = leadId + disbursement day, guarantees no duplicate reminder for one disbursement. */
    cycleKey: { type: String, required: true },
  },
  { timestamps: true },
);
schema.index({ orgId: 1, cycleKey: 1 }, { unique: true });
schema.index({ orgId: 1, status: 1, dueAt: 1 });
schema.index({ orgId: 1, ownerId: 1, status: 1 });
schema.index({ leadId: 1, createdAt: -1 });
schema.plugin(toJSONPlugin);

export type TopUpReminderDoc = InferSchemaType<typeof schema>;
export const TopUpReminder = model('TopUpReminder', schema);

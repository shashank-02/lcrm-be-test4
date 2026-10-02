import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../common/mongoose';

export const TEMPLATE_CHANNELS = ['whatsapp', 'email', 'sms'] as const;

/**
 * Message templates rendered with {{placeholders}}.
 * Delivery is via deep links (wa.me / mailto:) — see modules/communications for the adapter seam.
 */
const schema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    name: { type: String, required: true, trim: true },
    channel: { type: String, enum: TEMPLATE_CHANNELS, required: true },
    subject: { type: String, default: '' },
    body: { type: String, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
schema.index({ orgId: 1, name: 1 }, { unique: true });
schema.plugin(toJSONPlugin);

export type MessageTemplateDoc = InferSchemaType<typeof schema>;
export const MessageTemplate = model('MessageTemplate', schema);

import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../common/mongoose';

/** Append-only trail of administrative and sensitive actions. */
const schema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    action: { type: String, required: true }, // e.g. permission_template.update
    entity: { type: String, required: true },
    entityId: { type: String, default: '' },
    summary: { type: String, default: '' },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
schema.index({ orgId: 1, createdAt: -1 });
schema.index({ orgId: 1, entity: 1, entityId: 1, createdAt: -1 });
schema.index({ orgId: 1, userId: 1, createdAt: -1 });
schema.plugin(toJSONPlugin);

export type AuditLogDoc = InferSchemaType<typeof schema>;
export const AuditLog = model('AuditLog', schema);

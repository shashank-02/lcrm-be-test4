import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../common/mongoose';

const schema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    fileName: { type: String, required: true },
    storageKey: { type: String, default: '' },
    storageDriver: { type: String, default: 'local' },
    importType: { type: String, enum: ['create', 'upsert'], default: 'create' },
    /** csvHeader -> lead field path ("name", "phone", "custom.cardLimit", "stage", "status", "source", "owner") */
    mapping: { type: Schema.Types.Mixed, default: {} },
    defaults: {
      stageId: { type: Schema.Types.ObjectId, default: null },
      statusId: { type: Schema.Types.ObjectId, default: null },
      sourceId: { type: Schema.Types.ObjectId, default: null },
      ownerId: { type: Schema.Types.ObjectId, default: null },
      teamId: { type: Schema.Types.ObjectId, default: null },
      applyAssignmentRules: { type: Boolean, default: true },
    },
    status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
    totals: {
      rows: { type: Number, default: 0 },
      processed: { type: Number, default: 0 },
      created: { type: Number, default: 0 },
      updated: { type: Number, default: 0 },
      errored: { type: Number, default: 0 },
    },
    rowErrors: { type: [{ row: Number, message: String, data: Schema.Types.Mixed }], default: [] },
    failureReason: { type: String, default: '' },
    startedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
schema.index({ orgId: 1, createdAt: -1 });
schema.plugin(toJSONPlugin);

export type ImportJobDoc = InferSchemaType<typeof schema>;
export const ImportJob = model('ImportJob', schema);

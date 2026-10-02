import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../common/mongoose';

const stageSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    name: { type: String, required: true, trim: true },
    order: { type: Number, default: 0 },
    color: { type: String, default: '#185FA5' },
    isWon: { type: Boolean, default: false },
    isLost: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
stageSchema.index({ orgId: 1, name: 1 }, { unique: true });
stageSchema.plugin(toJSONPlugin);
export type StageDoc = InferSchemaType<typeof stageSchema>;
export const Stage = model('Stage', stageSchema);

const statusSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    name: { type: String, required: true, trim: true },
    /** Optional stage restriction. Empty => available in every stage. */
    stageIds: { type: [Schema.Types.ObjectId], default: [] },
    /** Optional sub-statuses shown in the call-log form (e.g. Callback → Callback Requested) */
    subStatuses: { type: [String], default: [] },
    color: { type: String, default: '#6B7280' },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
statusSchema.index({ orgId: 1, name: 1 }, { unique: true });
statusSchema.plugin(toJSONPlugin);
export type StatusDoc = InferSchemaType<typeof statusSchema>;
export const Status = model('Status', statusSchema);

const sourceSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    name: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
sourceSchema.index({ orgId: 1, name: 1 }, { unique: true });
sourceSchema.plugin(toJSONPlugin);
export type SourceDoc = InferSchemaType<typeof sourceSchema>;
export const Source = model('Source', sourceSchema);

/** Rules enforced when a lead moves between stages. */
const directiveSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    name: { type: String, required: true, trim: true },
    fromStageId: { type: Schema.Types.ObjectId, ref: 'Stage', default: null }, // null = any
    toStageId: { type: Schema.Types.ObjectId, ref: 'Stage', required: true },
    requiredFields: { type: [String], default: [] }, // lead fields or custom.<key>
    requireRemark: { type: Boolean, default: false },
    requireNextFollowUp: { type: Boolean, default: false },
    allowedRoles: { type: [String], default: [] }, // empty = all roles
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
directiveSchema.plugin(toJSONPlugin);
export type StageDirectiveDoc = InferSchemaType<typeof directiveSchema>;
export const StageDirective = model('StageDirective', directiveSchema);

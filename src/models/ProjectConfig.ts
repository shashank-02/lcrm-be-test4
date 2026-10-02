import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../common/mongoose';

export const PRIORITY_FACTORS = ['qualityScore', 'contactCount', 'nextFollowUpAt', 'stage', 'status', 'source', 'leadAgeDays', 'customField'] as const;
export const PRIORITY_OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'exists', 'overdue', 'due_today'] as const;

/** Configurable prioritisation: each matching rule adds `points` to lead.priority. */
const prioritySchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    name: { type: String, required: true, trim: true },
    factor: { type: String, enum: PRIORITY_FACTORS, required: true },
    fieldKey: { type: String, default: '' }, // for customField
    operator: { type: String, enum: PRIORITY_OPERATORS, required: true },
    value: { type: Schema.Types.Mixed, default: null },
    points: { type: Number, default: 10 },
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);
prioritySchema.index({ orgId: 1, isActive: 1, order: 1 });
prioritySchema.plugin(toJSONPlugin);
export type PrioritizationRuleDoc = InferSchemaType<typeof prioritySchema>;
export const PrioritizationRule = model('PrioritizationRule', prioritySchema);

export const FB_TRIGGERS = ['lead_created', 'stage_changed', 'status_changed', 'lead_won'] as const;

/** Meta Conversions API event mapping. Sending is best-effort and audited. */
const fbSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    name: { type: String, required: true, trim: true },
    trigger: { type: String, enum: FB_TRIGGERS, required: true },
    stageId: { type: Schema.Types.ObjectId, default: null },
    statusId: { type: Schema.Types.ObjectId, default: null },
    sourceIds: { type: [Schema.Types.ObjectId], default: [] },
    eventName: { type: String, required: true }, // Lead, CompleteRegistration, Purchase, custom
    pixelId: { type: String, default: '' },
    /** stored encrypted; never returned to the client */
    accessTokenEnc: { type: String, default: '' },
    testEventCode: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    lastFiredAt: { type: Date, default: null },
    firedCount: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
  },
  { timestamps: true },
);
fbSchema.index({ orgId: 1, isActive: 1, trigger: 1 });
fbSchema.plugin(toJSONPlugin);
fbSchema.set('toJSON', { virtuals: true, versionKey: false, transform: (_d, ret: Record<string, unknown>) => { ret.id = String(ret._id); delete ret._id; ret.hasAccessToken = !!ret.accessTokenEnc; delete ret.accessTokenEnc; return ret; } });
export type FbConversionEventDoc = InferSchemaType<typeof fbSchema>;
export const FbConversionEvent = model('FbConversionEvent', fbSchema);

/** Groups for saved list views (tabs). */
const viewGroupSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    name: { type: String, required: true, trim: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);
viewGroupSchema.index({ orgId: 1, name: 1 }, { unique: true });
viewGroupSchema.plugin(toJSONPlugin);
export const ViewGroup = model('ViewGroup', viewGroupSchema);

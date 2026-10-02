import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../common/mongoose';

const schema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    name: { type: String, default: '', trim: true },
    phone: { type: String, required: true, trim: true },
    altPhone: { type: String, default: '', trim: true },
    email: { type: String, default: '', lowercase: true, trim: true },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    country: { type: String, default: '' },
    language: { type: String, default: '' },

    stageId: { type: Schema.Types.ObjectId, ref: 'Stage', default: null },
    statusId: { type: Schema.Types.ObjectId, ref: 'Status', default: null },
    sourceId: { type: Schema.Types.ObjectId, ref: 'Source', default: null },

    // Ownership model
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    teamId: { type: Schema.Types.ObjectId, ref: 'Team', default: null },
    managerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    assignedAt: { type: Date, default: null },

    remarks: { type: String, default: '' },
    nextFollowUpAt: { type: Date, default: null },
    firstContactedAt: { type: Date, default: null },
    lastContactedAt: { type: Date, default: null },
    contactCount: { type: Number, default: 0 },

    qualityScore: { type: Number, default: 0, min: 0, max: 100 },
    priority: { type: Number, default: 0 },
    color: { type: String, default: '' },
    tags: { type: [String], default: [] },
    inTodayList: { type: Boolean, default: false },

    /** Admin-defined fields, keyed by FieldDefinition.key */
    customFields: { type: Schema.Types.Mixed, default: {} },

    importJobId: { type: Schema.Types.ObjectId, ref: 'ImportJob', default: null },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, minimize: false },
);

schema.index({ orgId: 1, phone: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
schema.index({ orgId: 1, isDeleted: 1, ownerId: 1, createdAt: -1 });
schema.index({ orgId: 1, isDeleted: 1, teamId: 1, createdAt: -1 });
schema.index({ orgId: 1, isDeleted: 1, stageId: 1 });
schema.index({ orgId: 1, isDeleted: 1, statusId: 1 });
schema.index({ orgId: 1, isDeleted: 1, sourceId: 1 });
schema.index({ orgId: 1, isDeleted: 1, nextFollowUpAt: 1 });
schema.index({ orgId: 1, isDeleted: 1, lastContactedAt: -1 });
schema.index({ orgId: 1, isDeleted: 1, assignedAt: -1 });
schema.index({ orgId: 1, importJobId: 1 });
schema.index({ orgId: 1, isDeleted: 1, priority: -1, createdAt: -1 });
// NOTE: no $text index on leads. Search uses anchored regexes (see lead.service), and a text index would use the
// lead's `language` field (e.g. "Hindi") as the text-search language override, which MongoDB rejects on every write
// ("language override unsupported"). Legacy deployments get the index dropped by `migrateIndexes()` at start-up.
schema.plugin(toJSONPlugin);

export type LeadDoc = InferSchemaType<typeof schema>;
export const Lead = model('Lead', schema);

export const LEAD_SORTABLE = [
  'createdAt', 'updatedAt', 'name', 'phone', 'assignedAt', 'nextFollowUpAt', 'lastContactedAt',
  'firstContactedAt', 'qualityScore', 'priority',
] as const;

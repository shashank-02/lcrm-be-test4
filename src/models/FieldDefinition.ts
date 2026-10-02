import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../common/mongoose';

export const FIELD_TYPES = [
  'text', 'textarea', 'number', 'currency', 'percent', 'date', 'datetime',
  'select', 'multiselect', 'boolean', 'phone', 'email', 'url',
] as const;

/**
 * Custom lead field. Rendered on the lead detail page grouped by `tab` -> `section`.
 * Values are stored in `lead.customFields[key]`.
 */
const schema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    type: { type: String, enum: FIELD_TYPES, default: 'text' },
    options: { type: [String], default: [] },
    tab: { type: String, default: 'Basic Info' },
    section: { type: String, default: 'Other Information' },
    order: { type: Number, default: 0 },
    required: { type: Boolean, default: false },
    showInList: { type: Boolean, default: false },
    showInCreate: { type: Boolean, default: false },
    readOnly: { type: Boolean, default: false },
    placeholder: { type: String, default: '' },
    helpText: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
schema.index({ orgId: 1, key: 1 }, { unique: true });
schema.plugin(toJSONPlugin);

export type FieldDefinitionDoc = InferSchemaType<typeof schema>;
export const FieldDefinition = model('FieldDefinition', schema);

/** Saved list views (columns + filters). */
const viewSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    name: { type: String, required: true, trim: true },
    columns: { type: [String], default: [] },
    filters: { type: Schema.Types.Mixed, default: {} },
    isDefault: { type: Boolean, default: false },
    /** Built-in tab this view is based on (all, contacted_today...) — 'custom' uses only filters */
    baseTab: { type: String, default: 'all' },
    /** Empty = every role */
    roles: { type: [String], default: [] },
    teamIds: { type: [Schema.Types.ObjectId], default: [] },
    groupId: { type: Schema.Types.ObjectId, ref: 'ViewGroup', default: null },
    isActive: { type: Boolean, default: true },
    isSystem: { type: Boolean, default: false },
    /** null => shared with the whole org; otherwise personal. */
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);
viewSchema.plugin(toJSONPlugin);
export type ListViewDoc = InferSchemaType<typeof viewSchema>;
export const ListView = model('ListView', viewSchema);

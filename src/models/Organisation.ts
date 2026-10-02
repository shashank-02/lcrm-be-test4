import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../common/mongoose';

const schema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    timezone: { type: String, default: 'Asia/Kolkata' },
    currency: { type: String, default: 'INR' },
    plan: { type: String, default: 'standard' },
    branding: {
      logoUrl: { type: String, default: '' },
      logoKey: { type: String, default: '' },
      logoMime: { type: String, default: '' },
      primaryColor: { type: String, default: '#185FA5' },
    },
    settings: {
      defaultRowsPerPage: { type: Number, default: 100 },
      workingHours: { start: { type: String, default: '09:30' }, end: { type: String, default: '18:30' } },
      workingDays: { type: [Number], default: [1, 2, 3, 4, 5, 6] },
      defaultFollowUpHours: { type: Number, default: 24 },
      duplicatePhoneCheck: { type: Boolean, default: true },
      showLeadStageBar: { type: Boolean, default: true },
      topUpReminderMonths: { type: Number, default: 3 },
      followUpReminderLeadMinutes: { type: Number, default: 0 },
      twoFactorDefault: { type: Boolean, default: false },
      files: {
        allowedTypes: { type: [String], default: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'csv', 'txt'] },
        maxSizeMb: { type: Number, default: 25 },
      },
      training: { maxVideoSizeMb: { type: Number, default: 500 } },
      /** Lead list column configuration (Project Administration → Lead Settings → Columns) */
      leadColumns: { type: [{ key: String, label: String, visible: Boolean, order: Number }], default: [] },
      columnGroups: { type: [{ name: String, columns: [String], order: Number }], default: [] },
      /** Lead-page tab order/visibility (system tabs + custom field tabs as `tab:<name>`) */
      leadTabs: { type: [{ key: String, label: String, visible: Boolean, order: Number }], default: [] },
      /** Per-role dashboard widgets (KPI cards + charts) */
      dashboards: { type: Schema.Types.Mixed, default: {} },
      /** Lead-page quick-action floaters */
      quickActions: { type: [{ key: String, label: String, visible: Boolean, order: Number, roles: [String] }], default: [] },
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
schema.plugin(toJSONPlugin);

export type OrganisationDoc = InferSchemaType<typeof schema>;
export const Organisation = model('Organisation', schema);

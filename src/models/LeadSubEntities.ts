import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../common/mongoose';

const base = {
  orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
  createdById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  hidden: { type: Boolean, default: false },
};

const noteSchema = new Schema({ ...base, body: { type: String, required: true }, remindAt: { type: Date, default: null }, remindedAt: { type: Date, default: null } }, { timestamps: true });
noteSchema.index({ orgId: 1, remindAt: 1 }, { partialFilterExpression: { remindAt: { $type: 'date' }, remindedAt: null } });
noteSchema.index({ leadId: 1, createdAt: -1 });
noteSchema.plugin(toJSONPlugin);
export type NoteDoc = InferSchemaType<typeof noteSchema>;
export const Note = model('Note', noteSchema);

const taskSchema = new Schema(
  {
    ...base,
    title: { type: String, required: true },
    description: { type: String, default: '' },
    dueAt: { type: Date, default: null },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['open', 'done', 'cancelled'], default: 'open' },
    completedAt: { type: Date, default: null },
    remindedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
taskSchema.index({ orgId: 1, assigneeId: 1, status: 1, dueAt: 1 });
taskSchema.plugin(toJSONPlugin);
export type TaskDoc = InferSchemaType<typeof taskSchema>;
export const Task = model('Task', taskSchema);

const callLogSchema = new Schema(
  {
    ...base,
    outcomeStatusId: { type: Schema.Types.ObjectId, ref: 'Status', default: null },
    outcome: { type: String, default: '' },
    subStatus: { type: String, default: '' },
    /** connected | not_connected | busy | no_answer | switched_off | wrong_number | voicemail */
    callStatus: { type: String, default: '' },
    notes: { type: String, default: '' },
    durationSec: { type: Number, default: 0 },
    followUpAt: { type: Date, default: null },
    direction: { type: String, enum: ['outbound', 'inbound'], default: 'outbound' },
  },
  { timestamps: true },
);
callLogSchema.index({ leadId: 1, createdAt: -1 });
callLogSchema.index({ orgId: 1, createdById: 1, createdAt: -1 });
callLogSchema.plugin(toJSONPlugin);
export type CallLogDoc = InferSchemaType<typeof callLogSchema>;
export const CallLog = model('CallLog', callLogSchema);

/** Document metadata. The binary lives in S3 (or local disk in dev) — `storageKey` references it. */
const fileSchema = new Schema(
  {
    ...base,
    title: { type: String, required: true },
    description: { type: String, default: '' },
    category: { type: String, default: 'Other' },
    isMandatory: { type: Boolean, default: false },
    fileName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, default: 0 },
    storageDriver: { type: String, enum: ['local', 's3'], required: true },
    storageKey: { type: String, required: true },
    status: { type: String, enum: ['pending', 'uploaded', 'verified', 'rejected'], default: 'pending' },
  },
  { timestamps: true },
);
fileSchema.index({ leadId: 1, createdAt: -1 });
fileSchema.plugin(toJSONPlugin);
export type LeadFileDoc = InferSchemaType<typeof fileSchema>;
export const LeadFile = model('LeadFile', fileSchema);

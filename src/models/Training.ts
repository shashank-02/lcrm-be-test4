import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../common/mongoose';
import { audienceSchema } from './Documents';

export const TRAINING_TYPES = ['video_upload', 'video_link', 'external_link', 'document', 'tutorial'] as const;

const categorySchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    name: { type: String, required: true, trim: true },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
categorySchema.index({ orgId: 1, name: 1 }, { unique: true });
categorySchema.plugin(toJSONPlugin);
export const TrainingCategory = model('TrainingCategory', categorySchema);

const trainingSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    type: { type: String, enum: TRAINING_TYPES, required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'TrainingCategory', default: null },
    /** video_link / external_link */
    url: { type: String, default: '' },
    /** video_upload / document */
    fileName: { type: String, default: '' },
    mimeType: { type: String, default: '' },
    size: { type: Number, default: 0 },
    storageDriver: { type: String, default: '' },
    storageKey: { type: String, default: '' },
    /** tutorial */
    content: { type: String, default: '' },
    durationSec: { type: Number, default: 0 },
    audience: { type: audienceSchema, default: () => ({ all: true }) },
    isActive: { type: Boolean, default: true },
    isNew: { type: Boolean, default: false },
    allowDownload: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    createdById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
trainingSchema.index({ orgId: 1, isActive: 1, categoryId: 1, order: 1 });
trainingSchema.index({ orgId: 1, type: 1 });
trainingSchema.index({ title: 'text', description: 'text' });
trainingSchema.plugin(toJSONPlugin);
export type TrainingDoc = InferSchemaType<typeof trainingSchema>;
export const Training = model('Training', trainingSchema);

const progressSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    trainingId: { type: Schema.Types.ObjectId, ref: 'Training', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['not_started', 'in_progress', 'completed'], default: 'in_progress' },
    progressPct: { type: Number, default: 0, min: 0, max: 100 },
    positionSec: { type: Number, default: 0 },
    lastViewedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
progressSchema.index({ trainingId: 1, userId: 1 }, { unique: true });
progressSchema.index({ userId: 1, status: 1 });
progressSchema.plugin(toJSONPlugin);
export const TrainingProgress = model('TrainingProgress', progressSchema);

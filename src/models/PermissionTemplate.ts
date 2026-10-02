import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../common/mongoose';
import { ROLES } from '../common/types';

const schema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    name: { type: String, required: true, trim: true },
    role: { type: String, enum: ROLES, required: true },
    description: { type: String, default: '' },
    permissions: { type: [String], default: [] },
    isSystem: { type: Boolean, default: false },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true },
);
schema.index({ orgId: 1, name: 1 }, { unique: true });
schema.plugin(toJSONPlugin);

export type PermissionTemplateDoc = InferSchemaType<typeof schema>;
export const PermissionTemplate = model('PermissionTemplate', schema);

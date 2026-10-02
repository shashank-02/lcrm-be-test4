import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../common/mongoose';

const schema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    managerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    teamLeadId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Default permission template applied to members without their own template */
    permissionTemplateId: { type: Schema.Types.ObjectId, ref: 'PermissionTemplate', default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
schema.index({ orgId: 1, name: 1 }, { unique: true });
schema.index({ orgId: 1, managerId: 1 });
schema.plugin(toJSONPlugin);

export type TeamDoc = InferSchemaType<typeof schema>;
export const Team = model('Team', schema);

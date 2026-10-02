import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../common/mongoose';
import { ROLES } from '../common/types';

const schema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, required: true, trim: true },
    username: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    twoFactorEnabled: { type: Boolean, default: false },
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
    avatarKey: { type: String, default: '' },
    employeeId: { type: String, default: '' },
    designation: { type: String, default: '' },
    dateOfBirth: { type: Date, default: null },
    bankName: { type: String, default: '' },
    bankAccountName: { type: String, default: '' },
    /** encrypted at rest (AES-256-GCM) */
    bankAccountNumberEnc: { type: String, default: '' },
    ifscCode: { type: String, default: '' },
    panNumberEnc: { type: String, default: '' },
    role: { type: String, enum: ROLES, required: true },
    teamId: { type: Schema.Types.ObjectId, ref: 'Team', default: null },
    permissionTemplateId: { type: Schema.Types.ObjectId, ref: 'PermissionTemplate', default: null },
    isActive: { type: Boolean, default: true },
    mustChangePassword: { type: Boolean, default: false },
    lastLoginAt: { type: Date, default: null },
    avatarColor: { type: String, default: '#185FA5' },
  },
  { timestamps: true },
);
schema.index({ orgId: 1, email: 1 }, { unique: true });
schema.index({ orgId: 1, username: 1 }, { unique: true });
schema.index({ orgId: 1, phone: 1 }, { unique: true });
schema.index({ orgId: 1, teamId: 1 });
schema.plugin(toJSONPlugin);

export type UserDoc = InferSchemaType<typeof schema>;
export const User = model('User', schema);

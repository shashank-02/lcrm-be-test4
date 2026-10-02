import { Schema, model, type InferSchemaType } from 'mongoose';

/** Email OTP challenge issued after a correct password when 2FA is enabled. Auto-expires via TTL index. */
const schema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    challengeId: { type: String, required: true, unique: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date, default: null },
    lastSentAt: { type: Date, default: Date.now },
    resendCount: { type: Number, default: 0 },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
  },
  { timestamps: true },
);
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 600 });
schema.index({ userId: 1, createdAt: -1 });

export type OtpChallengeDoc = InferSchemaType<typeof schema>;
export const OtpChallenge = model('OtpChallenge', schema);

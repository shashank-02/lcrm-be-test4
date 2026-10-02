import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * One row per sign-in. Carries the refresh-token hash for revocation AND the login/logout timeline used by the
 * Reports → Login & Logout tab. `lastSeenAt` is bumped (throttled) on every authenticated request so that sessions
 * abandoned by closing the browser can be closed honestly by the scheduler (reason "expired") instead of inventing
 * a logout time.
 */
const schema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', index: true },
    teamId: { type: Schema.Types.ObjectId, ref: 'Team', default: null },
    role: { type: String, default: '' },
    tokenHash: { type: String, required: true, unique: true },
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    /** Explicit sign-in time (createdAt is identical; kept as a named field for the report + indexes). */
    loginAt: { type: Date, default: () => new Date(), index: true },
    lastSeenAt: { type: Date, default: () => new Date() },
    /** When the session ended; null while the user is still signed in. */
    endedAt: { type: Date, default: null },
    endReason: { type: String, enum: ['', 'logout', 'logout_all', 'expired', 'revoked', 'password_change'], default: '' },
    durationSec: { type: Number, default: null },
  },
  { timestamps: true },
);
schema.index({ orgId: 1, loginAt: -1 });
schema.index({ orgId: 1, userId: 1, loginAt: -1 });
schema.index({ endedAt: 1, expiresAt: 1, lastSeenAt: 1 });
// Keep the login history for a year; expiry of the refresh token no longer deletes the row.
schema.index({ loginAt: 1 }, { expireAfterSeconds: 365 * 86_400 });

export type SessionDoc = InferSchemaType<typeof schema>;
export const Session = model('Session', schema);

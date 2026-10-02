import crypto from 'node:crypto';
import { OtpChallenge, Organisation, type UserDoc } from '../models';
import { env, isProd } from '../config/env';
import { AppError, badRequest, unauthorized } from '../common/errors';
import { randomDigits, sha256, timingSafeEqualHex } from './crypto.service';
import { mailConfigured, otpEmail, sendMail } from './mail.service';
import type { Types } from 'mongoose';

const RESEND_COOLDOWN_MS = 45_000;
const MAX_RESENDS = 3;

const hashCode = (challengeId: string, code: string) => sha256(`${challengeId}:${code}:${env.JWT_REFRESH_SECRET}`);

/** Creates a challenge, emails the code, returns what the client needs (never the code). */
export async function startOtpChallenge(user: UserDoc & { _id: Types.ObjectId }, meta: { ip?: string; ua?: string }) {
  if (isProd && !mailConfigured()) throw new AppError(503, 'MAIL_NOT_CONFIGURED', 'Two-factor codes cannot be sent because email delivery is not configured. Ask your administrator to set up SMTP.');
  const challengeId = crypto.randomUUID();
  const code = randomDigits(6);
  const expiresAt = new Date(Date.now() + env.OTP_TTL_MINUTES * 60_000);
  const org = await Organisation.findById(user.orgId).select('name').lean();
  // Send first: a challenge is only stored once the relay accepted the message.
  const sent = await sendMail({ ...otpEmail(org?.name ?? 'Lead CRM', user.name, code, env.OTP_TTL_MINUTES), to: user.email });
  await OtpChallenge.create({ userId: user._id, challengeId, codeHash: hashCode(challengeId, code), expiresAt, ip: meta.ip ?? '', userAgent: meta.ua ?? '' });
  return { challengeId, expiresAt, maskedEmail: maskEmail(user.email), ttlSeconds: env.OTP_TTL_MINUTES * 60, delivered: sent.delivered, ...(sent.delivered || isProd ? {} : { devCode: code, deliveryNote: 'Email delivery is not configured (MAIL_DRIVER=log); the code is shown here only in non-production environments.' }) };
}

/** Verifies a code; consumes the challenge on success. Returns the userId. */
export async function verifyOtpChallenge(challengeId: string, code: string): Promise<Types.ObjectId> {
  const ch = await OtpChallenge.findOne({ challengeId });
  if (!ch || ch.consumedAt) throw unauthorized('This code is no longer valid. Sign in again.');
  if (ch.expiresAt < new Date()) throw new AppError(401, 'OTP_EXPIRED', 'The code has expired. Request a new one.');
  if (ch.attempts >= env.OTP_MAX_ATTEMPTS) throw new AppError(401, 'OTP_LOCKED', 'Too many incorrect attempts. Sign in again to get a new code.');
  ch.attempts += 1;
  const ok = timingSafeEqualHex(ch.codeHash, hashCode(challengeId, code));
  if (!ok) { await ch.save(); throw new AppError(401, 'OTP_INVALID', `Incorrect code. ${Math.max(0, env.OTP_MAX_ATTEMPTS - ch.attempts)} attempt(s) left.`); }
  ch.consumedAt = new Date();
  await ch.save();
  return ch.userId as Types.ObjectId;
}

/** Re-issues a code on the same challenge with a cooldown. */
export async function resendOtp(challengeId: string, user: UserDoc & { _id: Types.ObjectId }) {
  const ch = await OtpChallenge.findOne({ challengeId, userId: user._id, consumedAt: null });
  if (!ch) throw unauthorized('Sign in again to get a new code.');
  if (Date.now() - ch.lastSentAt.getTime() < RESEND_COOLDOWN_MS) throw badRequest(`Please wait ${Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - ch.lastSentAt.getTime())) / 1000)}s before requesting another code`);
  if (ch.resendCount >= MAX_RESENDS) throw badRequest('Resend limit reached. Sign in again.');
  const code = randomDigits(6);
  const org = await Organisation.findById(user.orgId).select('name').lean();
  const sent = await sendMail({ ...otpEmail(org?.name ?? 'Lead CRM', user.name, code, env.OTP_TTL_MINUTES), to: user.email });
  ch.codeHash = hashCode(challengeId, code); ch.expiresAt = new Date(Date.now() + env.OTP_TTL_MINUTES * 60_000); ch.attempts = 0; ch.lastSentAt = new Date(); ch.resendCount += 1;
  await ch.save();
  return { challengeId, expiresAt: ch.expiresAt, maskedEmail: maskEmail(user.email), ttlSeconds: env.OTP_TTL_MINUTES * 60, delivered: sent.delivered, ...(sent.delivered || isProd ? {} : { devCode: code }) };
}

export function maskEmail(email: string) {
  const [u, d] = email.split('@');
  if (!d) return email;
  return `${u.slice(0, 2)}${'*'.repeat(Math.max(1, u.length - 2))}@${d}`;
}

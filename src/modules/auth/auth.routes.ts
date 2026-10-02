import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { Types } from 'mongoose';
import { asyncHandler, ok } from '../../common/http';
import { AppError, unauthorized, badRequest } from '../../common/errors';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { endSessions } from '../../services/session.service';
import { Session, User, Organisation } from '../../models';
import { hashToken, signAccessToken, signRefreshToken, verifyRefreshToken } from '../../services/token.service';
import { buildAuthUser } from '../../services/permission.service';
import { resendOtp, startOtpChallenge, verifyOtpChallenge } from '../../services/otp.service';
import { PERMISSION_CATALOGUE } from '../../common/permissions';
import { ROLE_LABELS } from '../../common/types';
import { env, isTest } from '../../config/env';
import { audit } from '../../services/audit.service';

export const authRouter = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: isTest ? 10_000 : 20, standardHeaders: true, legacyHeaders: false, message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in 15 minutes.' } } });
const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: isTest ? 10_000 : 30, standardHeaders: true, legacyHeaders: false });

const loginSchema = z.object({ identifier: z.string().min(2).max(120), password: z.string().min(1).max(200) });


/** Issue an access + refresh pair bound to a new session row (the access token carries the session id). */
async function issueTokens(user: { _id: unknown; orgId: unknown; role: string; teamId?: unknown }, meta: { ua?: string; ip?: string }) {
  const sessionId = new Types.ObjectId();
  const refresh = signRefreshToken(String(user._id), String(sessionId));
  const now = new Date();
  await Session.create({ _id: sessionId, userId: user._id, orgId: user.orgId, teamId: user.teamId ?? null, role: user.role, tokenHash: hashToken(refresh.token), expiresAt: refresh.expiresAt, userAgent: (meta.ua ?? '').slice(0, 200), ip: meta.ip ?? '', loginAt: now, lastSeenAt: now });
  const accessToken = signAccessToken(String(user._id), String(user.orgId), user.role, String(sessionId));
  return { accessToken, refreshToken: refresh.token, expiresAt: refresh.expiresAt };
}

async function completeLogin(user: InstanceType<typeof User>, req: { headers: Record<string, unknown>; ip?: string }) {
  user.lastLoginAt = new Date(); user.failedLoginAttempts = 0; user.lockUntil = null;
  await user.save();
  const tokens = await issueTokens(user, { ua: req.headers['user-agent'] as string, ip: req.ip });
  const me = await buildAuthUser(String(user._id));
  return { ...tokens, user: serializeMe(me!, user) };
}

authRouter.post(
  '/login',
  loginLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const identifier = String(req.body.identifier).trim().toLowerCase();
    const user = await User.findOne({ $or: [{ email: identifier }, { username: identifier }, { phone: identifier }] }).select('+passwordHash');
    // Constant-ish time: compare against a dummy hash when the user does not exist.
    const hash = user?.passwordHash ?? '$2a$10$CwTycUXWue0Thq9StjUM0uJ8fD3fMRVoB4lbzZe6h.yNJ1S2pFq3W';
    if (user?.lockUntil && user.lockUntil > new Date()) throw new AppError(423, 'ACCOUNT_LOCKED', `Account locked after too many failed attempts. Try again in ${Math.ceil((user.lockUntil.getTime() - Date.now()) / 60000)} minute(s).`);
    const valid = await bcrypt.compare(req.body.password, hash);
    if (!user || !valid) {
      if (user) {
        user.failedLoginAttempts = (user.failedLoginAttempts ?? 0) + 1;
        if (user.failedLoginAttempts >= env.LOGIN_MAX_FAILURES) { user.lockUntil = new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000); user.failedLoginAttempts = 0; }
        await user.save();
      }
      throw unauthorized('Invalid credentials');
    }
    if (!user.isActive) throw unauthorized('Your account has been deactivated. Contact your administrator.');
    const org = await Organisation.findById(user.orgId).select('isActive settings.twoFactorDefault').lean();
    if (!org?.isActive) throw unauthorized('Organisation is inactive');

    if (user.twoFactorEnabled) {
      const challenge = await startOtpChallenge(user as never, { ip: req.ip, ua: req.headers['user-agent'] });
      return ok(res, { requires2FA: true, ...challenge });
    }
    ok(res, await completeLogin(user, req));
  }),
);

authRouter.post(
  '/verify-otp',
  otpLimiter,
  validate({ body: z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }) }),
  asyncHandler(async (req, res) => {
    const userId = await verifyOtpChallenge(req.body.challengeId, req.body.code);
    const user = await User.findById(userId);
    if (!user || !user.isActive) throw unauthorized('Account unavailable');
    ok(res, await completeLogin(user, req));
  }),
);

authRouter.post(
  '/resend-otp',
  otpLimiter,
  validate({ body: z.object({ challengeId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const { OtpChallenge } = await import('../../models');
    const ch = await OtpChallenge.findOne({ challengeId: req.body.challengeId, consumedAt: null }).select('userId').lean();
    if (!ch) throw unauthorized('Sign in again to get a new code.');
    const user = await User.findById(ch.userId);
    if (!user || !user.isActive) throw unauthorized('Account unavailable');
    ok(res, await resendOtp(req.body.challengeId, user as never));
  }),
);

authRouter.post(
  '/refresh',
  validate({ body: z.object({ refreshToken: z.string().min(10) }) }),
  asyncHandler(async (req, res) => {
    const token: string = req.body.refreshToken;
    let payload;
    try { payload = verifyRefreshToken(token); } catch { throw unauthorized('Refresh token invalid or expired'); }
    const session = await Session.findOne({ tokenHash: hashToken(token), revokedAt: null, endedAt: null });
    if (!session || session.expiresAt < new Date()) throw unauthorized('Session expired, please sign in again');
    session.lastSeenAt = new Date();
    const user = await User.findById(payload.sub);
    if (!user || !user.isActive) throw unauthorized('Account unavailable');
    // Rotate the refresh token inside the same session so the access token's sid stays valid.
    const refresh = signRefreshToken(String(user._id), String(session._id));
    session.tokenHash = hashToken(refresh.token); session.expiresAt = refresh.expiresAt;
    await session.save();
    ok(res, { accessToken: signAccessToken(String(user._id), String(user.orgId), user.role, String(session._id)), refreshToken: refresh.token, expiresAt: refresh.expiresAt });
  }),
);

/** Ends the session server-side: refresh token AND access token stop working immediately. */
authRouter.post(
  '/logout',
  validate({ body: z.object({ refreshToken: z.string().optional(), allDevices: z.boolean().optional() }) }),
  asyncHandler(async (req, res) => {
    const header = req.headers.authorization;
    let sid: string | null = null; let userId: string | null = null;
    if (header?.startsWith('Bearer ')) { try { const { verifyAccessToken } = await import('../../services/token.service'); const p = verifyAccessToken(header.slice(7)); sid = p.sid ?? null; userId = p.sub; } catch { /* token already invalid */ } }
    if (req.body.allDevices && userId) await endSessions({ userId, revokedAt: null }, 'logout_all');
    else if (sid) await endSessions({ _id: sid }, 'logout');
    if (req.body.refreshToken) await endSessions({ tokenHash: hashToken(req.body.refreshToken), revokedAt: null }, 'logout');
    ok(res, { loggedOut: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const u = await User.findById(req.user!.id).select('mustChangePassword phone username avatarColor avatarKey twoFactorEnabled employeeId designation').lean();
    ok(res, serializeMe(req.user!, u as never));
  }),
);

/** Admin-provided passwords: users may still rotate their own password if the admin allows it (admin.users manages this). */
authRouter.post(
  '/change-password',
  requireAuth,
  validate({ body: z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(100) }) }),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user!.id).select('+passwordHash');
    if (!user || !(await bcrypt.compare(req.body.currentPassword, user.passwordHash))) throw badRequest('Current password is incorrect');
    user.passwordHash = await bcrypt.hash(req.body.newPassword, 12); user.mustChangePassword = false; user.passwordChangedAt = new Date();
    await user.save();
    await endSessions({ userId: user._id, revokedAt: null, _id: { $ne: req.user!.sessionId } }, 'password_change');
    audit(req.user!, { action: 'user.password_changed', entity: 'User', entityId: user._id, summary: 'Changed own password', ip: req.ip });
    ok(res, { changed: true });
  }),
);

authRouter.get('/permission-catalogue', requireAuth, (_req, res) => ok(res, { catalogue: PERMISSION_CATALOGUE, roles: ROLE_LABELS }));

export function avatarUrl(key?: string | null) { return key ? `${env.PUBLIC_API_URL}/api/v1/public/avatar/${encodeURIComponent(key)}` : null; }

function serializeMe(me: NonNullable<Awaited<ReturnType<typeof buildAuthUser>>>, u: { mustChangePassword?: boolean; phone?: string; username?: string; avatarColor?: string; avatarKey?: string; twoFactorEnabled?: boolean; employeeId?: string; designation?: string } | null) {
  return {
    id: me.id, orgId: me.orgId, name: me.name, email: me.email, role: me.role, teamId: me.teamId, managedTeamIds: me.managedTeamIds, permissions: Array.from(me.permissions), timezone: me.timezone,
    mustChangePassword: u?.mustChangePassword ?? false, phone: u?.phone, username: u?.username, avatarColor: u?.avatarColor, avatarUrl: avatarUrl(u?.avatarKey), twoFactorEnabled: !!u?.twoFactorEnabled, employeeId: u?.employeeId ?? '', designation: u?.designation ?? '',
  };
}

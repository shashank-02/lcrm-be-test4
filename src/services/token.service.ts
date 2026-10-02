import crypto from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';

export interface AccessPayload {
  sub: string;
  org: string;
  role: string;
  /** session id — lets logout invalidate access tokens immediately */
  sid?: string;
  type: 'access';
}

export function signAccessToken(userId: string, orgId: string, role: string, sid?: string, expiresIn?: string) {
  const payload: AccessPayload = { sub: userId, org: orgId, role, ...(sid ? { sid } : {}), type: 'access' };
  if (expiresIn) return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn } as SignOptions);
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_TTL } as SignOptions);
}

export function verifyAccessToken(token: string): AccessPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessPayload;
  if (decoded.type !== 'access') throw new Error('Invalid token type');
  return decoded;
}

export interface RefreshPayload {
  sub: string;
  jti: string;
  type: 'refresh';
}

export function signRefreshToken(userId: string, jti: string = crypto.randomUUID()) {
  // `jti` is the session id (stable across rotations); `nonce` guarantees every rotation yields a new token even within the same second.
  const token = jwt.sign({ sub: userId, jti, type: 'refresh', nonce: crypto.randomUUID() } as RefreshPayload & { nonce: string }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL,
  } as SignOptions);
  const decoded = jwt.decode(token) as { exp: number };
  return { token, jti, expiresAt: new Date(decoded.exp * 1000) };
}

export function verifyRefreshToken(token: string): RefreshPayload {
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshPayload;
  if (decoded.type !== 'refresh') throw new Error('Invalid token type');
  return decoded;
}

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** Short-lived, purpose-bound token for streaming a protected file to an <img>/<iframe>/<video>. */
export function signViewToken(userId: string, resource: string, ttlSeconds = 300) {
  return jwt.sign({ sub: userId, res: resource, type: 'view' }, env.JWT_ACCESS_SECRET, { expiresIn: ttlSeconds } as SignOptions);
}
export function verifyViewToken(token: string, resource: string): string {
  const d = jwt.verify(token, env.JWT_ACCESS_SECRET) as { sub: string; res: string; type: string };
  if (d.type !== 'view' || d.res !== resource) throw new Error('Invalid view token');
  return d.sub;
}

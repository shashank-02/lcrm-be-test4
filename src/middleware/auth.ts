import type { RequestHandler } from 'express';
import { unauthorized, forbidden } from '../common/errors';
import { verifyAccessToken } from '../services/token.service';
import { buildAuthUser } from '../services/permission.service';
import type { Role } from '../common/types';
import { Session } from '../models';
import { env } from '../config/env';
import { touchSession } from '../services/session.service';

/** Verifies the bearer token and attaches `req.user` with resolved permissions. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    const payload = verifyAccessToken(header.slice(7));
    if (payload.sid) {
      // Logout / password change revokes the session, which immediately invalidates this access token too.
      const session = await Session.findById(payload.sid).select('revokedAt endedAt expiresAt').lean();
      if (!session || session.revokedAt || session.endedAt || session.expiresAt < new Date()) throw unauthorized('Session has ended. Please sign in again.');
      touchSession(payload.sid);
    }
    const user = await buildAuthUser(payload.sub);
    if (!user) throw unauthorized('Session is no longer valid');
    user.sessionId = payload.sid ?? null;
    req.user = user;
    next();
  } catch (err) {
    next(err instanceof Error && err.name !== 'AppError' ? unauthorized('Invalid or expired token') : err);
  }
};

/** Requires at least one of the listed permissions. Admins always pass. */
export const requirePermission =
  (...keys: string[]): RequestHandler =>
  (req, _res, next) => {
    const user = req.user;
    if (!user) return next(unauthorized());
    if (user.role === 'admin' || keys.some((k) => user.permissions.has(k))) return next();
    return next(forbidden(`Missing permission: ${keys.join(' or ')}`));
  };

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (roles.includes(req.user.role)) return next();
    return next(forbidden());
  };

export const hasPermission = (user: { role: Role; permissions: Set<string> }, key: string) =>
  user.role === 'admin' || user.permissions.has(key);

/** Optional shared client key: blocks casual third-party clients that are not the SPA. */
export const requireClientKey: RequestHandler = (req, _res, next) => {
  if (!env.APP_CLIENT_KEY) return next();
  if (req.headers['x-client-key'] === env.APP_CLIENT_KEY) return next();
  // Streaming endpoints are opened by <img>/<iframe>/<video> and carry their own signed token instead.
  if (req.method === 'GET' && (req.path.includes('/view') || req.path.includes('/raw/') || req.path.startsWith('/public/'))) return next();
  if (req.method === 'PUT' && /^\/files\/[^/]+\/upload$/.test(req.path)) return next(); // local-driver upload carries its own signed token
  return next(forbidden('Client key missing or invalid'));
};

/** Strips Mongo operators from user input so `{ "$gt": "" }` style payloads cannot reach queries. */
export const sanitizeInput: RequestHandler = (req, _res, next) => {
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (!k.startsWith('$')) out[k] = clean(val);
      return out;
    }
    return v;
  };
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) req.body = clean(req.body);
  if (req.query && typeof req.query === 'object') { for (const k of Object.keys(req.query)) if (k.startsWith('$')) delete (req.query as Record<string, unknown>)[k]; }
  next();
};

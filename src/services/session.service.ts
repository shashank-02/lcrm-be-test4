import { Session } from '../models';
import { env } from '../config/env';

export type EndReason = 'logout' | 'logout_all' | 'expired' | 'revoked' | 'password_change';

/** Closes matching open sessions with an honest end time and duration. Returns the number closed. */
export async function endSessions(filter: Record<string, unknown>, reason: EndReason, endedAt = new Date()) {
  const sessions = await Session.find({ ...filter, endedAt: null }).select('loginAt lastSeenAt').lean();
  if (!sessions.length) return 0;
  await Promise.all(sessions.map((s) => {
    // "expired" sessions end at the last activity we actually observed — never a fabricated logout time.
    const end = reason === 'expired' ? new Date(s.lastSeenAt ?? s.loginAt) : endedAt;
    return Session.updateOne({ _id: s._id }, { $set: { revokedAt: endedAt, endedAt: end, endReason: reason, durationSec: Math.max(0, Math.round((end.getTime() - new Date(s.loginAt).getTime()) / 1000)) } });
  }));
  return sessions.length;
}

const HEARTBEAT_MS = 60_000;
const lastBeat = new Map<string, number>();
/** Bumps lastSeenAt at most once a minute per session (fire-and-forget). */
export function touchSession(sessionId: string) {
  const now = Date.now();
  const prev = lastBeat.get(sessionId) ?? 0;
  if (now - prev < HEARTBEAT_MS) return;
  lastBeat.set(sessionId, now);
  if (lastBeat.size > 5000) lastBeat.clear();
  Session.updateOne({ _id: sessionId, endedAt: null }, { $set: { lastSeenAt: new Date(now) } }).catch(() => undefined);
}

export const inactivityMs = () => env.SESSION_INACTIVITY_MINUTES * 60_000;
/** A session counts as online while it is open and was used recently. */
export const isOnline = (s: { endedAt?: Date | null; revokedAt?: Date | null; expiresAt: Date; lastSeenAt?: Date | null }, now = Date.now()) =>
  !s.endedAt && !s.revokedAt && new Date(s.expiresAt).getTime() > now && new Date(s.lastSeenAt ?? 0).getTime() > now - inactivityMs();

/** Scheduler job: closes sessions whose refresh token expired or that have been idle past the inactivity window. */
export async function sweepStaleSessions(now = new Date()) {
  const idleBefore = new Date(now.getTime() - inactivityMs());
  return endSessions({ $or: [{ expiresAt: { $lt: now } }, { lastSeenAt: { $lt: idleBefore } }] }, 'expired', now);
}

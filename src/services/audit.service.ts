import { AuditLog } from '../models';
import type { AuthUser } from '../common/types';
import { logger } from '../config/logger';

interface AuditInput { action: string; entity: string; entityId?: unknown; summary?: string; before?: unknown; after?: unknown; ip?: string }

/** Fire-and-forget audit entry. Never throws — auditing must not break the request. */
export function audit(user: AuthUser | { id: string; orgId: string } | null, input: AuditInput) {
  AuditLog.create({
    orgId: user?.orgId, userId: user?.id ?? null, action: input.action, entity: input.entity, entityId: input.entityId ? String(input.entityId) : '',
    summary: input.summary ?? '', before: sanitise(input.before), after: sanitise(input.after), ip: input.ip ?? '',
  }).catch((err) => logger.warn({ err }, 'audit write failed'));
}

const SECRET_KEYS = new Set(['passwordHash', 'password', 'accessTokenEnc', 'bankAccountNumberEnc', 'panNumberEnc', 'codeHash', 'tokenHash']);
function sanitise(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v ?? null;
  if (Array.isArray(v)) return v.slice(0, 50);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (!SECRET_KEYS.has(k)) out[k] = val;
  return out;
}

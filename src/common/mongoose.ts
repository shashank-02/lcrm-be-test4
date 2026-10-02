import { Schema, Types } from 'mongoose';

/** Normalises documents for the API: `_id` -> `id`, drops `__v` and secrets. */
export function toJSONPlugin(schema: Schema) {
  schema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform: (_doc, ret: Record<string, unknown>) => {
      ret.id = String(ret._id);
      delete ret._id;
      delete ret.passwordHash;
      return ret;
    },
  });
}

export const oid = (v: string | Types.ObjectId) => (typeof v === 'string' ? new Types.ObjectId(v) : v);
export const isOid = (v: unknown): v is string => typeof v === 'string' && Types.ObjectId.isValid(v);

export function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const objectId = (msg = 'Invalid id') => ({ message: msg });

import crypto from 'node:crypto';
import { env } from '../config/env';

/**
 * AES-256-GCM field encryption for sensitive profile data (bank account, PAN).
 * Format: base64(iv).base64(tag).base64(ciphertext). Falls back to a key derived from the JWT secret
 * in development; production should set FIELD_ENCRYPTION_KEY.
 */
const key = env.FIELD_ENCRYPTION_KEY
  ? Buffer.from(env.FIELD_ENCRYPTION_KEY, 'hex')
  : crypto.createHash('sha256').update(`field:${env.JWT_REFRESH_SECRET}`).digest();

export function encryptField(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

export function decryptField(payload: string): string {
  if (!payload) return '';
  const [iv, tag, data] = payload.split('.');
  if (!iv || !tag || !data) return '';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** Show only the last 4 characters. */
export const mask = (v: string) => (v ? `${'•'.repeat(Math.max(0, v.length - 4))}${v.slice(-4)}` : '');

export const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
export const timingSafeEqualHex = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
export const randomDigits = (n: number) => Array.from(crypto.randomBytes(n), (b) => String(b % 10)).join('');

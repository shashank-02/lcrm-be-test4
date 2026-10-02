import nodemailer, { type Transporter } from 'nodemailer';
import { bool, env, isProd, isTest } from '../config/env';
import { logger } from '../config/logger';

/**
 * Email delivery. Credentials come exclusively from server environment variables and are never returned by any API.
 *
 * Driver resolution:
 *   MAIL_DRIVER=smtp  → SMTP relay (Brevo, Gmail / Google Workspace App Password, Outlook 365, SES, Mailtrap…)
 *   MAIL_DRIVER=log   → development only; the message body is printed to the server log (never in production)
 *   MAIL_DRIVER=auto  → smtp when SMTP_HOST or SMTP_SERVICE is set, otherwise log
 *
 * Message bodies and one-time codes are never written to logs when NODE_ENV=production; delivery logs contain only a
 * masked recipient, the message kind and the relay's message id.
 */
export type MailKind = 'otp' | 'test' | 'credentials' | 'password_reset' | 'generic';
export interface MailMessage { to: string; subject: string; text: string; html?: string; kind?: MailKind }

let transporter: Transporter | null = null;
let lastVerify: { ok: boolean; at: Date; error?: string } | null = null;
let verifying: Promise<{ ok: boolean; error?: string }> | null = null;
/** Test hook: messages "sent" while the log driver is active (test environment only). */
export const mailOutbox: MailMessage[] = [];

export function mailDriver(): 'smtp' | 'log' {
  if (env.MAIL_DRIVER === 'smtp') return 'smtp';
  if (env.MAIL_DRIVER === 'log') return 'log';
  return env.SMTP_HOST || env.SMTP_SERVICE ? 'smtp' : 'log';
}
export const mailConfigured = () => mailDriver() === 'smtp';

/** Parses MAIL_FROM ("Name <addr>" or "addr") into its parts; SMTP_FROM_EMAIL / SMTP_FROM_NAME win when set. */
export function sender(): { name: string; email: string } {
  const legacy = env.MAIL_FROM?.match(/^\s*(?:"?([^"<]*)"?\s*)?<?([^<>\s]+@[^<>\s]+)>?\s*$/);
  const email = env.SMTP_FROM_EMAIL || legacy?.[2] || env.SMTP_USER || 'no-reply@example.com';
  const name = env.SMTP_FROM_NAME !== 'Lead CRM' ? env.SMTP_FROM_NAME : (legacy?.[1]?.trim() || env.SMTP_FROM_NAME);
  return { name, email };
}
export const mailFrom = () => { const s = sender(); return `"${s.name.replace(/"/g, '')}" <${s.email}>`; };
export const maskEmail = (e: string) => e.replace(/^(.{1,2})[^@]*(@.*)$/, (_, a, b) => `${a}${'*'.repeat(4)}${b}`);
const maskHost = (h: string) => { const parts = h.split('.'); return parts.length > 2 ? `${parts[0].slice(0, 4)}****.${parts.slice(-2).join('.')}` : `${h.slice(0, 3)}****`; };

function smtp(): Transporter {
  if (transporter) return transporter;
  if (!env.SMTP_USER || !env.SMTP_PASS) throw new Error('SMTP_USER and SMTP_PASS are required for email delivery');
  if (!env.SMTP_HOST && !env.SMTP_SERVICE) throw new Error('Set SMTP_HOST (e.g. smtp-relay.brevo.com) or SMTP_SERVICE (e.g. gmail)');
  const secure = bool(env.SMTP_SECURE, env.SMTP_PORT === 465);
  transporter = nodemailer.createTransport({
    ...(env.SMTP_SERVICE ? { service: env.SMTP_SERVICE } : { host: env.SMTP_HOST, port: env.SMTP_PORT, secure, requireTLS: !secure && env.SMTP_PORT === 587 }),
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    tls: { minVersion: 'TLSv1.2' },
  });
  return transporter;
}

/** Sends a message. Throws a descriptive error when the relay rejects it so callers can surface it. */
export async function sendMail(msg: MailMessage): Promise<{ delivered: boolean; messageId?: string }> {
  const kind = msg.kind ?? 'generic';
  if (mailDriver() === 'smtp') {
    try {
      const info = await smtp().sendMail({ from: mailFrom(), to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
      logger.info({ to: maskEmail(msg.to), kind, messageId: info.messageId }, 'mail sent');
      return { delivered: true, messageId: info.messageId };
    } catch (err) {
      const e = err as Error & { code?: string; responseCode?: number; response?: string };
      logger.error({ code: e.code, responseCode: e.responseCode, response: e.response, host: env.SMTP_HOST ?? env.SMTP_SERVICE, to: maskEmail(msg.to), kind }, 'mail send failed');
      throw new Error(describeSmtpError(e));
    }
  }
  if (isTest) mailOutbox.push(msg);
  else if (isProd) logger.error({ to: maskEmail(msg.to), kind }, '[mail] NOT delivered — email delivery is not configured (MAIL_DRIVER=log is not allowed in production). Set MAIL_DRIVER=smtp and the SMTP_* variables.');
  else logger.warn({ to: msg.to, kind, subject: msg.subject, text: msg.text }, '[mail:log] NOT delivered — development log driver (configure SMTP_* to send real email)');
  return { delivered: false };
}

function describeSmtpError(e: Error & { code?: string; responseCode?: number; response?: string }): string {
  if (e.code === 'EAUTH' || e.responseCode === 535) return 'The mail server rejected the SMTP username/password. Brevo: use your login email + an SMTP key. Gmail/Google Workspace: use a 16-character App Password (2-step verification required), not the account password.';
  if (e.code === 'EENVELOPE' || e.responseCode === 550 || e.responseCode === 553) return `The mail server rejected the sender or recipient (${e.response ?? e.message}). SMTP_FROM_EMAIL must be a sender address verified with your provider.`;
  if (e.code === 'ESOCKET' || e.code === 'ECONNECTION' || e.code === 'ETIMEDOUT' || e.code === 'ECONNREFUSED' || e.code === 'EDNS') return `Could not connect to the mail server (${env.SMTP_HOST ?? env.SMTP_SERVICE}:${env.SMTP_PORT}). Check SMTP_HOST/SMTP_PORT, SMTP_SECURE (false for 587, true for 465) and that outbound SMTP is allowed from your host.`;
  return `Email delivery failed: ${e.response ?? e.message}`;
}

/** Verifies the transport (de-duplicated when called concurrently); the result is cached for /organisation/mail-status. */
export async function verifyMailTransport(): Promise<{ ok: boolean; error?: string }> {
  if (mailDriver() !== 'smtp') { lastVerify = { ok: false, at: new Date(), error: isProd ? 'Email delivery is not configured. Set MAIL_DRIVER=smtp with SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM_EMAIL in the API environment.' : 'Email delivery is not configured (development log driver). Set the SMTP_* variables to send real email.' }; return { ok: false, error: lastVerify.error }; }
  if (verifying) return verifying;
  verifying = (async () => {
    try { await smtp().verify(); lastVerify = { ok: true, at: new Date() }; return { ok: true }; }
    catch (err) { const msg = describeSmtpError(err as never); logger.error({ reason: msg }, 'SMTP verification failed'); lastVerify = { ok: false, at: new Date(), error: msg }; return { ok: false, error: msg }; }
    finally { verifying = null; }
  })();
  return verifying;
}

/** Masked configuration for the Settings → Email Configuration panel. Never includes the password or raw credentials. */
export function mailStatus() {
  const s = sender();
  const configured = mailConfigured();
  return {
    provider: configured ? 'SMTP' : 'Not configured', driver: mailDriver(), configured,
    host: configured ? (env.SMTP_SERVICE ? `service: ${env.SMTP_SERVICE}` : maskHost(env.SMTP_HOST ?? '')) : null,
    port: env.SMTP_PORT, secure: bool(env.SMTP_SECURE, env.SMTP_PORT === 465),
    username: env.SMTP_USER ? maskEmail(env.SMTP_USER) : null,
    senderEmail: maskEmail(s.email), senderName: s.name,
    connected: configured && lastVerify?.ok === true,
    status: !configured ? 'Not configured' : lastVerify == null ? 'Not verified yet' : lastVerify.ok ? 'Connected' : 'Not connected',
    lastVerify: lastVerify ? { ok: lastVerify.ok, at: lastVerify.at, error: lastVerify.error ?? null } : null,
    productionWarning: isProd && !configured ? 'Two-factor codes and account emails cannot be delivered until SMTP is configured.' : null,
  };
}

// ---------- message templates ----------
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const shell = (orgName: string, inner: string) => `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e3e7ec;border-radius:10px;color:#14213d">${inner}<p style="margin:20px 0 0;font-size:12px;color:#8a96ab">— ${escapeHtml(orgName)}</p></div>`;

export function otpEmail(orgName: string, name: string, code: string, ttlMinutes: number): MailMessage & { to?: string } {
  return {
    kind: 'otp', subject: `Your ${orgName} sign-in code`,
    text: `Hi ${name},\n\nYour one-time sign-in code is ${code}. It expires in ${ttlMinutes} minutes.\n\nIf you did not try to sign in, contact your administrator immediately.\n\n— ${orgName}`,
    html: shell(orgName, `<p style="margin:0 0 12px;color:#55627a">Hi ${escapeHtml(name)},</p><p style="margin:0 0 8px">Your one-time sign-in code for <strong>${escapeHtml(orgName)}</strong>:</p><p style="font-size:32px;letter-spacing:8px;font-weight:700;color:#185fa5;margin:8px 0 16px">${code}</p><p style="margin:0;color:#55627a">It expires in <strong>${ttlMinutes} minutes</strong>. Never share this code — our team will never ask for it.</p><p style="margin:12px 0 0;font-size:12px;color:#8a96ab">If you did not try to sign in, contact your administrator.</p>`),
  } as MailMessage;
}
export function testEmail(orgName: string, name: string): MailMessage {
  return { kind: 'test', to: '', subject: `${orgName}: test email from Lead CRM`, text: `Hi ${name},\n\nThis is a test message from Lead CRM. If you can read this, SMTP delivery is working and two-factor codes will arrive the same way.\n\n— ${orgName}`, html: shell(orgName, `<p>Hi ${escapeHtml(name)},</p><p style="color:#55627a">This is a test message from <strong>${escapeHtml(orgName)}</strong> Lead CRM. If you can read this, SMTP delivery is working and sign-in codes will arrive the same way.</p>`) };
}
/** Sent when an administrator creates an account or resets a password. The credential is included because the product uses admin-issued passwords. */
export function credentialsEmail(orgName: string, name: string, identifier: string, password: string, appUrl: string, reset: boolean): MailMessage {
  const title = reset ? 'Your password has been reset' : `Welcome to ${orgName}`;
  return {
    kind: reset ? 'password_reset' : 'credentials', to: '', subject: `${orgName}: ${title}`,
    text: `Hi ${name},\n\n${reset ? 'An administrator has reset your Lead CRM password.' : `An account has been created for you in ${orgName} Lead CRM.`}\n\nSign in: ${appUrl}\nUsername: ${identifier}\nPassword: ${password}\n\nKeep this password private. If you did not expect this email, contact your administrator.\n\n— ${orgName}`,
    html: shell(orgName, `<p>Hi ${escapeHtml(name)},</p><p style="color:#55627a">${reset ? 'An administrator has reset your Lead CRM password.' : `An account has been created for you in <strong>${escapeHtml(orgName)}</strong> Lead CRM.`}</p><table style="font-size:14px;border-collapse:collapse;margin:12px 0"><tr><td style="padding:4px 12px 4px 0;color:#55627a">Sign in</td><td><a href="${escapeHtml(appUrl)}">${escapeHtml(appUrl)}</a></td></tr><tr><td style="padding:4px 12px 4px 0;color:#55627a">Username</td><td><strong>${escapeHtml(identifier)}</strong></td></tr><tr><td style="padding:4px 12px 4px 0;color:#55627a">Password</td><td><code style="font-size:15px;background:#f1f3f6;padding:2px 6px;border-radius:4px">${escapeHtml(password)}</code></td></tr></table><p style="margin:0;font-size:12px;color:#8a96ab">Keep this password private. If you did not expect this email, contact your administrator.</p>`),
  };
}

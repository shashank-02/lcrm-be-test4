import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  LOG_LEVEL: z.string().default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  /** Public URL of the web app, used in account emails (defaults to the first CORS origin) */
  APP_URL: z.string().optional(),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  MONGODB_URI: z.string().default('mongodb://localhost:27017/lead_crm'),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./storage'),
  AWS_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  SEED_ORG_NAME: z.string().default('My Company'),
  SEED_ADMIN_NAME: z.string().default('System Admin'),
  SEED_ADMIN_EMAIL: z.string().default('admin@example.com'),
  SEED_ADMIN_PHONE: z.string().default('9999999999'),
  SEED_ADMIN_PASSWORD: z.string().default('Admin@12345'),
  /** 64 hex chars (32 bytes) for AES-256-GCM field encryption. Generate: openssl rand -hex 32 */
  FIELD_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
  /** Optional shared header value the SPA sends; blocks casual third-party clients */
  APP_CLIENT_KEY: z.string().optional(),
  /** smtp (production) | log (development only: codes go to the server log) | auto (smtp when SMTP_HOST/SMTP_SERVICE is set). */
  MAIL_DRIVER: z.enum(['smtp', 'log', 'auto']).default('auto'),
  /** Nodemailer well-known service name (gmail, outlook365, brevo, sendgrid…) — alternative to SMTP_HOST/PORT */
  SMTP_SERVICE: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.string().default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** Sender address; must be verified with the provider. Defaults to SMTP_USER. (MAIL_FROM "Name <addr>" is still accepted.) */
  SMTP_FROM_EMAIL: z.string().optional(),
  SMTP_FROM_NAME: z.string().default('Lead CRM'),
  MAIL_FROM: z.string().optional(),
  SESSION_INACTIVITY_MINUTES: z.coerce.number().default(30),
  OTP_TTL_MINUTES: z.coerce.number().default(5),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),
  LOGIN_MAX_FAILURES: z.coerce.number().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().default(15),
  SCHEDULER_ENABLED: z.enum(['true', 'false']).default('true'),
  SCHEDULER_INTERVAL_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().default(300),
  MAX_IMPORT_ROWS: z.coerce.number().default(50_000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const bool = (v: string | undefined, d = false) => (v == null || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()));
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

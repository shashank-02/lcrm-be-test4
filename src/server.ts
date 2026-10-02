import http from 'node:http';
import { env } from './config/env';
import { logger } from './config/logger';
import { connectDb, disconnectDb } from './config/db';
import { createApp } from './app';
import { startScheduler, stopScheduler } from './services/scheduler.service';
import { mailStatus, verifyMailTransport } from './services/mail.service';

async function main() {
  await connectDb();
  const app = createApp();
  startScheduler();
  verifyMailTransport().then((r) => { const st = mailStatus(); if (r.ok) logger.info({ provider: st.provider, host: st.host, port: st.port, username: st.username, sender: `${st.senderName} <${st.senderEmail}>` }, 'SMTP connected — 2FA, credential and test emails will be delivered'); else if (env.NODE_ENV === 'production') logger.error({ reason: r.error }, 'EMAIL DELIVERY NOT WORKING: set MAIL_DRIVER=smtp and SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM_EMAIL. 2FA sign-ins are refused until this is fixed.'); else logger.warn({ reason: r.error }, 'Email delivery not configured: codes are written to this log (development only)'); });
  const server = http.createServer(app);
  server.keepAliveTimeout = 65_000;
  server.listen(env.PORT, () => logger.info(`API listening on :${env.PORT} (${env.NODE_ENV})`));

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    stopScheduler();
    server.close(async () => { await disconnectDb(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'Unhandled rejection'));
}

main().catch((err) => { logger.error({ err }, 'Failed to start'); process.exit(1); });

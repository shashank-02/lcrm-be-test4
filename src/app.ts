import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { env, isTest } from './config/env';
import { logger } from './config/logger';
import { requireAuth, requireClientKey, sanitizeInput } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { authRouter } from './modules/auth/auth.routes';
import { usersRouter } from './modules/users/users.routes';
import { teamsRouter } from './modules/users/teams.routes';
import { permissionsRouter } from './modules/users/permissions.routes';
import { organisationRouter } from './modules/users/organisation.routes';
import { configRouter } from './modules/config/config.routes';
import { leadsRouter } from './modules/leads/leads.routes';
import { subEntitiesRouter } from './modules/leads/subentities.routes';
import { filesRouter, leadFilesRouter } from './modules/files/files.routes';
import { importsRouter } from './modules/imports/imports.routes';
import { reportsRouter } from './modules/reports/reports.routes';
import { sessionsReportRouter } from './modules/reports/sessions.report';
import { bootstrapRouter } from './modules/bootstrap.routes';
import { notificationsRouter, topupRouter } from './modules/notifications/notifications.routes';
import { documentsRouter, documentViewHandlers } from './modules/documents/documents.routes';
import { trainingRouter, trainingViewHandlers } from './modules/training/training.routes';
import { memberProfileRouter, profileRouter } from './modules/profile/profile.routes';
import { publicRouter } from './modules/public/public.routes';
import { auditRouter, fbEventsRouter, prioritizationRouter, viewGroupsRouter } from './modules/admin/admin.routes';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // App Runner / ALB terminate TLS
  app.disable('x-powered-by');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, hsts: { maxAge: 15_552_000, includeSubDomains: true }, referrerPolicy: { policy: 'no-referrer' }, contentSecurityPolicy: false }));
  app.use((_req, res, next) => { res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'); res.setHeader('Cache-Control', 'no-store'); next(); });
  const origins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  app.use(cors({ origin: origins.includes('*') ? true : origins, credentials: true, exposedHeaders: ['Content-Disposition', 'Content-Length'] }));
  app.use(compression());
  app.use((req, _res, next) => { req.requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID(); next(); });
  if (!isTest) app.use(pinoHttp({ logger, genReqId: (req) => req.requestId as string, autoLogging: { ignore: (req) => req.url === '/health' } }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(sanitizeInput);
  app.use(rateLimit({ windowMs: env.RATE_LIMIT_WINDOW_MS, limit: isTest ? 100_000 : env.RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false }));

  app.get('/health', (_req, res) => res.json({ status: 'ok', db: mongoose.connection.readyState === 1 ? 'up' : 'down', uptime: process.uptime(), version: process.env.npm_package_version ?? '1.0.0' }));

  const api = express.Router();
  api.use(requireClientKey);
  api.use('/public', publicRouter);
  api.use('/auth', authRouter);
  api.use('/files', filesRouter); // has its own auth (token in query for local uploads)
  // Signed view-token streams for <iframe>/<video>: they authenticate with ?token= and must sit before requireAuth.
  api.get('/documents/:id/view', ...documentViewHandlers);
  api.get('/training/:id/view', ...trainingViewHandlers);
  api.use(requireAuth);
  api.use('/bootstrap', bootstrapRouter);
  api.use('/me/profile', profileRouter);
  api.use('/users', memberProfileRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/topup-reminders', topupRouter);
  api.use('/documents', documentsRouter);
  api.use('/training', trainingRouter);
  api.use('/audit-logs', auditRouter);
  api.use('/config/view-groups', viewGroupsRouter);
  api.use('/config/prioritization', prioritizationRouter);
  api.use('/config/fb-events', fbEventsRouter);
  api.use('/organisation', organisationRouter);
  api.use('/users', usersRouter);
  api.use('/teams', teamsRouter);
  api.use('/permission-templates', permissionsRouter);
  api.use('/config', configRouter);
  api.use('/leads/:leadId/files', leadFilesRouter);
  api.use('/leads/:leadId', subEntitiesRouter);
  api.use('/leads', leadsRouter);
  api.use('/imports', importsRouter);
  api.use('/reports/login-sessions', sessionsReportRouter);
  api.use('/reports', reportsRouter);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

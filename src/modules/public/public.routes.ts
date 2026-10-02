import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler, ok } from '../../common/http';
import { notFound } from '../../common/errors';
import { Organisation, User } from '../../models';
import { storage } from '../../services/storage.service';
import { isTest } from '../../config/env';

/** Unauthenticated, read-only endpoints needed before login (branding) or by <img> tags (avatars). */
export const publicRouter = Router();
publicRouter.use(rateLimit({ windowMs: 60_000, limit: isTest ? 100_000 : 240, standardHeaders: true, legacyHeaders: false }));

publicRouter.get('/branding', asyncHandler(async (_req, res) => {
  const org = await Organisation.findOne({ isActive: true }).sort({ createdAt: 1 }).select('name branding.primaryColor branding.logoKey updatedAt').lean();
  res.setHeader('Cache-Control', 'public, max-age=60');
  ok(res, { name: org?.name ?? 'Lead CRM', primaryColor: org?.branding?.primaryColor ?? '#185FA5', logoUrl: org?.branding?.logoKey ? `/api/v1/public/branding/logo?v=${org.updatedAt?.getTime() ?? 0}` : null });
}));

publicRouter.get('/branding/logo', asyncHandler(async (_req, res) => {
  const org = await Organisation.findOne({ isActive: true }).sort({ createdAt: 1 }).select('branding.logoKey branding.logoMime').lean();
  if (!org?.branding?.logoKey) throw notFound('Logo');
  const buf = await storage().getObject(org.branding.logoKey);
  res.setHeader('Content-Type', org.branding.logoMime || 'image/png'); res.setHeader('Cache-Control', 'public, max-age=3600'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox"); // SVG logos cannot run scripts
  res.send(buf);
}));

/** Avatar keys are random UUIDs — unguessable — so serving them without auth is acceptable for <img>. */
publicRouter.get('/avatar/:key', asyncHandler(async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  if (!/\/avatars\//.test(key)) throw notFound('Avatar');
  const u = await User.findOne({ avatarKey: key }).select('_id').lean(); if (!u) throw notFound('Avatar');
  const buf = await storage().getObject(key);
  const ext = key.split('.').pop()?.toLowerCase();
  res.setHeader('Content-Type', ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'); res.setHeader('Cache-Control', 'public, max-age=86400, immutable'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(buf);
}));

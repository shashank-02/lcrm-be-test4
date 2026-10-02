import { Router } from 'express';
import { z } from 'zod';
import { DASHBOARD_WIDGETS, LEAD_TABS, QUICK_ACTIONS, ROLES, defaultDashboard, defaultLeadTabs, defaultQuickActions, normalizeLayout, type LayoutItem, type Role } from '../../common/uiconfig';
import { asyncHandler, ok } from '../../common/http';
import { notFound } from '../../common/errors';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/auth';
import multer from 'multer';
import path from 'node:path';
import { AppError, badRequest } from '../../common/errors';
import { mailStatus, sendMail, testEmail, verifyMailTransport } from '../../services/mail.service';
import { Organisation } from '../../models';
import { buildStorageKey, storage } from '../../services/storage.service';
import { audit } from '../../services/audit.service';

export const organisationRouter = Router();

const layoutItem = z.object({ key: z.string().min(1).max(80), label: z.string().max(60).default(''), visible: z.boolean(), order: z.number().int().min(0).max(999) });
const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  timezone: z.string().min(1).optional(),
  currency: z.string().length(3).optional(),
  branding: z.object({ logoUrl: z.string().url().or(z.literal('')).optional(), primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).optional(),
  settings: z
    .object({
      defaultRowsPerPage: z.number().int().refine((n) => [25, 50, 100, 200].includes(n)).optional(),
      workingHours: z.object({ start: z.string(), end: z.string() }).optional(),
      workingDays: z.array(z.number().int().min(0).max(6)).optional(),
      defaultFollowUpHours: z.number().int().min(1).max(720).optional(),
      duplicatePhoneCheck: z.boolean().optional(),
      showLeadStageBar: z.boolean().optional(),
      topUpReminderMonths: z.number().int().min(1).max(36).optional(),
      twoFactorDefault: z.boolean().optional(),
      files: z.object({ allowedTypes: z.array(z.string().regex(/^[a-z0-9]{1,6}$/)).optional(), maxSizeMb: z.number().int().min(1).max(500).optional() }).optional(),
      training: z.object({ maxVideoSizeMb: z.number().int().min(10).max(2000).optional() }).optional(),
      leadColumns: z.array(z.object({ key: z.string().min(1).max(80), label: z.string().max(80), visible: z.boolean(), order: z.number().int() })).max(60).optional(),
      columnGroups: z.array(z.object({ name: z.string().min(1).max(60), columns: z.array(z.string().max(80)), order: z.number().int() })).max(20).optional(),
      leadTabs: z.array(layoutItem).max(40).optional(),
      dashboards: z.record(z.enum(ROLES as [Role, ...Role[]]), z.array(layoutItem).max(40)).optional(),
      quickActions: z.array(layoutItem.extend({ roles: z.array(z.enum(ROLES as [Role, ...Role[]])).default([]) })).max(20).optional(),
    })
    .optional(),
});
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const LOGO_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp' };

organisationRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const org = await Organisation.findById(req.user!.orgId);
    if (!org) throw notFound('Organisation');
    ok(res, org.toJSON());
  }),
);

organisationRouter.patch(
  '/',
  requirePermission('admin.settings'),
  validate({ body: updateSchema }),
  asyncHandler(async (req, res) => {
    const org = await Organisation.findById(req.user!.orgId);
    if (!org) throw notFound('Organisation');
    const before = org.toJSON();
    // Merge nested settings so a partial PATCH never wipes sibling keys.
    const { settings, branding, ...rest } = req.body;
    org.set(rest);
    if (branding) org.set('branding', { ...org.toObject().branding, ...branding });
    if (settings) {
      const cur = org.toObject().settings as Record<string, unknown>;
      const next: Record<string, unknown> = { ...cur, ...settings, files: { ...(cur.files as object), ...(settings.files ?? {}) }, training: { ...(cur.training as object), ...(settings.training ?? {}) }, workingHours: { ...(cur.workingHours as object), ...(settings.workingHours ?? {}) } };
      const leadTabs = settings.leadTabs as LayoutItem[] | undefined;
      if (leadTabs) next.leadTabs = normalizeLayout(leadTabs, [...LEAD_TABS, ...leadTabs.filter((t) => t.key.startsWith('tab:'))], defaultLeadTabs());
      const dashboards = settings.dashboards as Partial<Record<Role, LayoutItem[]>> | undefined;
      if (dashboards) next.dashboards = { ...((cur.dashboards as object) ?? {}), ...Object.fromEntries(Object.entries(dashboards).map(([role, items]) => [role, normalizeLayout(items as LayoutItem[], DASHBOARD_WIDGETS, defaultDashboard(role as Role))])) };
      const quick = settings.quickActions as (LayoutItem & { roles: Role[] })[] | undefined;
      if (quick) next.quickActions = normalizeLayout(quick, QUICK_ACTIONS, defaultQuickActions()).map((i) => ({ ...i, roles: quick.find((q) => q.key === i.key)?.roles ?? [] }));
      org.set('settings', next);
      org.markModified('settings.dashboards');
    }
    await org.save();
    audit(req.user!, { action: 'organisation.update', entity: 'Organisation', entityId: org._id, summary: 'Updated organisation settings', before: before.settings, after: org.toJSON().settings, ip: req.ip });
    ok(res, org.toJSON());
  }),
);

/** Company logo for the login page (PNG / JPG / SVG / WEBP, ≤ 2 MB). Served publicly via /public/branding/logo. */
organisationRouter.post('/logo', requirePermission('admin.settings'), logoUpload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Choose a logo image');
  const ext = path.extname(req.file.originalname).slice(1).toLowerCase();
  if (!LOGO_MIME[ext]) throw badRequest('Logo must be PNG, JPG, SVG or WEBP');
  if (ext === 'svg' && /<script|on\w+=|javascript:/i.test(req.file.buffer.toString('utf8'))) throw badRequest('SVG contains scripts and was rejected');
  const org = await Organisation.findById(req.user!.orgId); if (!org) throw notFound('Organisation');
  const key = buildStorageKey(req.user!.orgId, 'branding', `logo.${ext}`);
  await storage().putObject(key, req.file.buffer, LOGO_MIME[ext]);
  const old = org.branding?.logoKey;
  org.set('branding', { ...org.toObject().branding, logoKey: key, logoMime: LOGO_MIME[ext], logoUrl: `/api/v1/public/branding/logo` });
  await org.save();
  if (old) storage().deleteObject(old).catch(() => undefined);
  audit(req.user!, { action: 'organisation.logo', entity: 'Organisation', entityId: org._id, summary: 'Updated company logo', ip: req.ip });
  ok(res, org.toJSON());
}));
organisationRouter.delete('/logo', requirePermission('admin.settings'), asyncHandler(async (req, res) => {
  const org = await Organisation.findById(req.user!.orgId); if (!org) throw notFound('Organisation');
  if (org.branding?.logoKey) storage().deleteObject(org.branding.logoKey).catch(() => undefined);
  org.set('branding', { ...org.toObject().branding, logoKey: '', logoMime: '', logoUrl: '' }); await org.save();
  ok(res, org.toJSON());
}));

// ---------- Email delivery (2FA) diagnostics ----------
/** Shows which mail driver is active and the last verification result, so a misconfigured SMTP is visible in the UI. */
organisationRouter.get('/mail-status', requirePermission('admin.settings'), validate({ query: z.object({ verify: z.string().optional() }) }), asyncHandler(async (req, res) => {
  if (req.query.verify === 'true' || req.query.verify === '1') await verifyMailTransport(); // live connection check for the Settings panel
  ok(res, mailStatus());
}));

/** Verifies the SMTP connection and sends a test email to the signed-in admin (or a given address). */
organisationRouter.post('/mail-test', requirePermission('admin.settings'), validate({ body: z.object({ to: z.string().email().optional() }) }), asyncHandler(async (req, res) => {
  const org = await Organisation.findById(req.user!.orgId).select('name').lean();
  const verify = await verifyMailTransport();
  if (!verify.ok) throw new AppError(503, 'MAIL_NOT_CONFIGURED', verify.error ?? 'Email delivery is not configured');
  try {
    const to = req.body.to ?? req.user!.email;
    const result = await sendMail({ ...testEmail(org?.name ?? 'Lead CRM', req.user!.name), to });
    audit(req.user!, { action: 'organisation.mail_test', entity: 'Organisation', entityId: org?._id ?? req.user!.orgId, summary: `Sent test email to ${to}`, ip: req.ip });
    ok(res, { sent: true, to, messageId: result.messageId ?? null, status: mailStatus() });
  } catch (err) { throw new AppError(502, 'MAIL_SEND_FAILED', (err as Error).message); }
}));

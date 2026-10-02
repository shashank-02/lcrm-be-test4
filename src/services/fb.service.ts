import { FbConversionEvent, Lead } from '../models';
import { decryptField, sha256 } from './crypto.service';
import { logger } from '../config/logger';

/**
 * Meta Conversions API adapter. Configuration lives in Project Administration → Automations.
 * Firing is best-effort and never blocks the lead operation.
 */
export async function fireFbEvents(orgId: unknown, trigger: 'lead_created' | 'stage_changed' | 'status_changed' | 'lead_won', leadId: unknown, ctx: { stageId?: unknown; statusId?: unknown } = {}) {
  const rules = await FbConversionEvent.find({ orgId, isActive: true, trigger }).lean();
  if (!rules.length) return;
  const lead = await Lead.findById(leadId).select('phone email sourceId city createdAt').lean();
  if (!lead) return;
  for (const r of rules) {
    if (r.stageId && String(r.stageId) !== String(ctx.stageId)) continue;
    if (r.statusId && String(r.statusId) !== String(ctx.statusId)) continue;
    if (r.sourceIds.length && !r.sourceIds.some((s) => String(s) === String(lead.sourceId))) continue;
    const token = decryptField(r.accessTokenEnc);
    if (!r.pixelId || !token) { await FbConversionEvent.updateOne({ _id: r._id }, { $set: { lastError: 'Pixel ID or access token missing' } }); continue; }
    const payload = {
      data: [{ event_name: r.eventName, event_time: Math.floor(Date.now() / 1000), action_source: 'system_generated', event_id: `${leadId}-${trigger}-${Date.now()}`,
        user_data: { ph: [sha256(lead.phone.replace(/\D/g, ''))], ...(lead.email ? { em: [sha256(lead.email.toLowerCase())] } : {}), ...(lead.city ? { ct: [sha256(lead.city.toLowerCase())] } : {}) } }],
      ...(r.testEventCode ? { test_event_code: r.testEventCode } : {}),
    };
    try {
      const res = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(r.pixelId)}/events?access_token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`Meta API ${res.status}`);
      await FbConversionEvent.updateOne({ _id: r._id }, { $set: { lastFiredAt: new Date(), lastError: '' }, $inc: { firedCount: 1 } });
    } catch (err) {
      logger.warn({ err, rule: r.name }, 'FB conversion event failed');
      await FbConversionEvent.updateOne({ _id: r._id }, { $set: { lastError: (err as Error).message } });
    }
  }
}

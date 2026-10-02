/**
 * Renders {{placeholders}} in message templates and builds deep links.
 * Supported placeholders: {{name}} {{phone}} {{email}} {{city}} {{stage}} {{status}} {{source}}
 * {{owner.name}} {{owner.phone}} {{custom.<key>}} {{nextFollowUp}} and any top-level lead field.
 */
export interface RenderContext {
  lead: Record<string, unknown> & { customFields?: Record<string, unknown> };
  owner?: { name?: string; phone?: string; email?: string } | null;
  stage?: string;
  status?: string;
  source?: string;
}

function lookup(ctx: RenderContext, pathStr: string): string {
  const parts = pathStr.trim().split('.');
  if (parts[0] === 'owner') return String((ctx.owner as Record<string, unknown> | null | undefined)?.[parts[1]] ?? '');
  if (parts[0] === 'custom') return String(ctx.lead.customFields?.[parts[1]] ?? '');
  if (parts[0] === 'stage') return ctx.stage ?? '';
  if (parts[0] === 'status') return ctx.status ?? '';
  if (parts[0] === 'source') return ctx.source ?? '';
  const v = ctx.lead[parts[0]];
  if (v instanceof Date) return v.toISOString();
  return v == null ? '' : String(v);
}

export function renderTemplate(body: string, ctx: RenderContext): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => lookup(ctx, key));
}

export const digitsOnly = (phone: string) => phone.replace(/\D/g, '');

/** Normalises Indian numbers to E.164-ish digits for wa.me (adds 91 to 10-digit numbers). */
export function whatsappNumber(phone: string, defaultCountryCode = '91') {
  const d = digitsOnly(phone);
  if (d.length === 10) return `${defaultCountryCode}${d}`;
  if (d.length === 11 && d.startsWith('0')) return `${defaultCountryCode}${d.slice(1)}`;
  return d;
}

export function whatsappLink(phone: string, text: string) {
  return `https://wa.me/${whatsappNumber(phone)}?text=${encodeURIComponent(text)}`;
}
export function mailtoLink(email: string, subject: string, body: string) {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
export const telLink = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;

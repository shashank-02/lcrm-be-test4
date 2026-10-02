import { Types } from 'mongoose';
import type { AuthUser } from '../../common/types';
import { FieldDefinition, ImportJob, Lead, Source, Stage, Status, Team, User } from '../../models';
import { logActivities } from '../../services/activity.service';
import { applyAssignmentRules } from '../../services/assignment.service';
import { ensureTopUpReminder } from '../../services/topup.service';
import { logger } from '../../config/logger';

export const LEAD_IMPORT_TARGETS = [
  { key: 'phone', label: 'Phone (required)', type: 'phone' }, { key: 'name', label: 'Name', type: 'text' },
  { key: 'email', label: 'Email', type: 'email' }, { key: 'altPhone', label: 'Alternate phone', type: 'phone' },
  { key: 'city', label: 'City', type: 'text' }, { key: 'state', label: 'State', type: 'text' }, { key: 'country', label: 'Country', type: 'text' },
  { key: 'language', label: 'Language', type: 'text' }, { key: 'remarks', label: 'Remarks', type: 'text' },
  { key: 'nextFollowUpAt', label: 'Next follow-up', type: 'datetime' }, { key: 'createdAt', label: 'Lead created at', type: 'datetime' },
  { key: 'stage', label: 'Stage (by name)', type: 'lookup' }, { key: 'status', label: 'Status (by name)', type: 'lookup' },
  { key: 'source', label: 'Source (by name; created if missing)', type: 'lookup' }, { key: 'owner', label: 'Owner (email / username / phone)', type: 'lookup' },
  { key: 'tags', label: 'Tags (comma separated)', type: 'text' },
];

const CHUNK = 250;
const normalisePhone = (p: string) => p.replace(/[\s\-().]/g, '').replace(/^\+?91(?=\d{10}$)/, '');

/**
 * Runs an import job: maps CSV rows -> lead documents, validates, bulk-writes in chunks,
 * records per-row errors, then applies assignment rules to unassigned created leads.
 */
export async function runImport(jobId: Types.ObjectId, records: Record<string, string>[], actor: AuthUser) {
  const job = await ImportJob.findById(jobId);
  if (!job) return;
  job.status = 'processing'; job.startedAt = new Date(); await job.save();
  const orgId = job.orgId;
  const mapping = job.mapping as Record<string, string>;
  const defaults = job.defaults ?? ({} as NonNullable<typeof job.defaults>);

  try {
    const [stages, statuses, sources, users, fields, teams] = await Promise.all([
      Stage.find({ orgId }).lean(), Status.find({ orgId }).lean(), Source.find({ orgId }).lean(),
      User.find({ orgId, isActive: true }).select('email username phone teamId').lean(),
      FieldDefinition.find({ orgId, isActive: true }).lean(), Team.find({ orgId }).select('managerId').lean(),
    ]);
    const byName = <T extends { name: string; _id: Types.ObjectId }>(arr: T[]) => new Map(arr.map((x) => [x.name.toLowerCase(), x]));
    const stageMap = byName(stages), statusMap = byName(statuses), sourceMap = byName(sources);
    const userMap = new Map<string, (typeof users)[number]>();
    users.forEach((u) => { userMap.set(u.email, u); userMap.set(u.username, u); userMap.set(u.phone, u); });
    const teamManager = new Map(teams.map((t) => [String(t._id), t.managerId ?? null]));
    const fieldMap = new Map(fields.map((f) => [f.key, f]));
    const defaultStage = defaults.stageId ?? stages.sort((a, b) => a.order - b.order)[0]?._id ?? null;

    let created = 0, updated = 0, errored = 0;
    const errors: { row: number; message: string; data: Record<string, string> }[] = [];
    const createdIds: Types.ObjectId[] = [];

    for (let start = 0; start < records.length; start += CHUNK) {
      const chunk = records.slice(start, start + CHUNK);
      const docs: { row: number; doc: Record<string, unknown>; data: Record<string, string> }[] = [];
      const seenPhones = new Set<string>();

      for (let i = 0; i < chunk.length; i++) {
        const rowNo = start + i + 2; // 1-based + header
        const data = chunk[i];
        try {
          const doc: Record<string, unknown> = { orgId, createdById: actor.id, importJobId: job._id, customFields: {}, tags: [] };
          for (const [col, target] of Object.entries(mapping)) {
            if (!target) continue;
            const raw = (data[col] ?? '').trim();
            if (raw === '') continue;
            if (target.startsWith('custom.')) {
              const def = fieldMap.get(target.slice(7)); if (!def) continue;
              (doc.customFields as Record<string, unknown>)[def.key] = coerce(def.type, raw, def.options);
            } else if (target === 'stage') { const s = stageMap.get(raw.toLowerCase()); if (!s) throw new Error(`Unknown stage "${raw}"`); doc.stageId = s._id; }
            else if (target === 'status') { const s = statusMap.get(raw.toLowerCase()); if (!s) throw new Error(`Unknown status "${raw}"`); doc.statusId = s._id; }
            else if (target === 'source') {
              let s = sourceMap.get(raw.toLowerCase());
              if (!s) { const createdSrc = await Source.create({ orgId, name: raw }); s = createdSrc.toObject() as never; sourceMap.set(raw.toLowerCase(), s!); }
              doc.sourceId = s!._id;
            } else if (target === 'owner') { const u = userMap.get(raw.toLowerCase()); if (!u) throw new Error(`Unknown owner "${raw}"`); doc.ownerId = u._id; doc.teamId = u.teamId ?? null; doc.managerId = u.teamId ? teamManager.get(String(u.teamId)) ?? null : null; }
            else if (target === 'nextFollowUpAt' || target === 'createdAt') { const d = new Date(raw); if (Number.isNaN(d.getTime())) throw new Error(`Invalid date in "${col}"`); doc[target] = d; }
            else if (target === 'phone' || target === 'altPhone') doc[target] = normalisePhone(raw);
            else if (target === 'email') doc.email = raw.toLowerCase();
            else if (target === 'tags') doc.tags = raw.split(',').map((t) => t.trim()).filter(Boolean);
            else doc[target] = raw;
          }
          const phone = String(doc.phone ?? '');
          if (!/^\+?\d{8,15}$/.test(phone)) throw new Error(`Invalid phone "${phone || '(empty)'}"`);
          if (seenPhones.has(phone)) throw new Error(`Duplicate phone ${phone} within file`);
          seenPhones.add(phone);
          if (!doc.stageId) doc.stageId = defaultStage;
          if (!doc.statusId && defaults.statusId) doc.statusId = defaults.statusId;
          if (!doc.sourceId && defaults.sourceId) doc.sourceId = defaults.sourceId;
          if (!doc.ownerId && defaults.ownerId) {
            const u = users.find((x) => String(x._id) === String(defaults.ownerId));
            if (u) { doc.ownerId = u._id; doc.teamId = u.teamId ?? null; doc.managerId = u.teamId ? teamManager.get(String(u.teamId)) ?? null : null; }
          }
          if (!doc.teamId && defaults.teamId) { doc.teamId = defaults.teamId; doc.managerId = teamManager.get(String(defaults.teamId)) ?? null; }
          if (doc.ownerId) doc.assignedAt = new Date();
          for (const f of fields) if (f.required && (doc.customFields as Record<string, unknown>)[f.key] == null) throw new Error(`Missing required field "${f.label}"`);
          docs.push({ row: rowNo, doc, data });
        } catch (e) {
          errored++; if (errors.length < 1000) errors.push({ row: rowNo, message: (e as Error).message, data });
        }
      }

      if (docs.length) {
        if (job.importType === 'upsert') {
          const ops = docs.map(({ doc }) => {
            const { customFields, orgId: o, phone, createdById, importJobId, tags, ...rest } = doc as Record<string, unknown> & { customFields: Record<string, unknown> };
            void o;
            const set: Record<string, unknown> = { ...rest, importJobId };
            for (const [k, v] of Object.entries(customFields)) set[`customFields.${k}`] = v;
            if ((tags as string[]).length) set.tags = tags;
            return { updateOne: { filter: { orgId, phone, isDeleted: false }, update: { $set: set, $setOnInsert: { createdById, phone, orgId } }, upsert: true } };
          });
          const r = await Lead.bulkWrite(ops as never, { ordered: false });
          created += r.upsertedCount; updated += r.matchedCount;
          const ids = Object.values(r.upsertedIds ?? {}).map((x) => new Types.ObjectId(String(x)));
          createdIds.push(...ids);
        } else {
          try {
            const inserted = await Lead.insertMany(docs.map((d) => d.doc), { ordered: false, rawResult: true } as never) as unknown as { insertedIds: Record<number, Types.ObjectId> };
            const ids = Object.values(inserted.insertedIds ?? {});
            created += ids.length; createdIds.push(...ids);
          } catch (e) {
            const err = e as { insertedDocs?: { _id: Types.ObjectId }[]; writeErrors?: { index: number; errmsg: string }[]; result?: { insertedIds?: Record<number, Types.ObjectId> } };
            const okIds = (err.insertedDocs ?? []).map((d) => d._id);
            created += okIds.length; createdIds.push(...okIds);
            for (const we of err.writeErrors ?? []) {
              errored++;
              const d = docs[we.index];
              const msg = /E11000/.test(we.errmsg) ? `Phone ${d?.doc.phone} already exists (use "Update existing" mode)` : we.errmsg;
              if (errors.length < 1000) errors.push({ row: d?.row ?? 0, message: msg, data: d?.data ?? {} });
            }
          }
        }
      }
      job.totals = { rows: records.length, processed: Math.min(records.length, start + chunk.length), created, updated, errored };
      job.rowErrors = errors as never;
      await job.save();
    }

    if (createdIds.length) {
      await logActivities(createdIds.map((id) => ({ orgId, leadId: id, userId: actor.id, type: 'imported' as const, description: `Imported from ${job.fileName}`, payload: { jobId: job._id } })));
      if (defaults.applyAssignmentRules) await applyAssignmentRules(orgId, createdIds);
      const wonIds = new Set(stages.filter((s) => s.isWon).map((s) => String(s._id)));
      if (wonIds.size) { const won = await Lead.find({ _id: { $in: createdIds }, stageId: { $in: Array.from(wonIds) } }).select('_id').lean(); for (const w of won) await ensureTopUpReminder(orgId, w._id); }
    }
    job.status = 'completed';
  } catch (err) {
    logger.error({ err, jobId }, 'Import failed');
    job.status = 'failed'; job.failureReason = (err as Error).message;
  }
  job.finishedAt = new Date();
  await job.save();
}

function coerce(type: string, raw: string, options: string[]) {
  switch (type) {
    case 'number': case 'currency': case 'percent': { const n = Number(raw.replace(/[,₹$%\s]/g, '')); if (Number.isNaN(n)) throw new Error(`"${raw}" is not a number`); return n; }
    case 'boolean': return ['true', 'yes', '1', 'y'].includes(raw.toLowerCase());
    case 'date': case 'datetime': { const d = new Date(raw); if (Number.isNaN(d.getTime())) throw new Error(`"${raw}" is not a date`); return d; }
    case 'select': { const m = options.find((o) => o.toLowerCase() === raw.toLowerCase()); if (!m) throw new Error(`"${raw}" is not a valid option`); return m; }
    case 'multiselect': return raw.split(',').map((s) => s.trim()).filter(Boolean);
    default: return raw;
  }
}

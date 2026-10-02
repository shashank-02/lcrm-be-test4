import mongoose from 'mongoose';
import { logger } from './logger';

/**
 * One-off index migrations that `autoIndex` cannot express. Safe to run on every start-up.
 *
 * - leads: drop any legacy `$text` index. Its default `language_override: 'language'` turned the lead's own `language`
 *   field into a text-search language, so saving a lead whose language was e.g. "Hindi" failed with
 *   "Plan executor error during update :: language override unsupported" (surfacing as a Quick Note error even though
 *   the note itself had been saved).
 */
export async function migrateIndexes(): Promise<string[]> {
  const applied: string[] = [];
  const db = mongoose.connection.db;
  if (!db) return applied;
  try {
    const exists = (await db.listCollections({ name: 'leads' }).toArray()).length > 0;
    if (!exists) return applied;
    const indexes = await db.collection('leads').indexes();
    for (const idx of indexes) {
      const isText = Object.values(idx.key ?? {}).includes('text') || idx.textIndexVersion != null;
      if (isText && idx.name) { await db.collection('leads').dropIndex(idx.name); applied.push(`leads.dropIndex(${idx.name})`); }
    }
  } catch (err) { logger.warn({ err }, 'index migration skipped'); }
  if (applied.length) logger.info({ applied }, 'index migrations applied');
  return applied;
}

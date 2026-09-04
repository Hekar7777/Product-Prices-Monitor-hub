import type { Db } from '../db/index.js';
import { assertNoError } from './supabaseHelpers.js';

/**
 * Key/value store backing the Settings page.
 *
 * Values are stored as text and coerced by `SettingsService`, which owns the
 * schema and validation.
 */
export class SettingsRepository {
  constructor(private readonly db: Db) {}

  async getAll(): Promise<Record<string, string>> {
    const { data, error } = await this.db.client.from('settings').select('key, value');
    assertNoError(error, 'settings.getAll');

    const out: Record<string, string> = {};
    for (const row of (data ?? []) as Array<{ key: string; value: string }>) {
      out[row.key] = row.value;
    }
    return out;
  }

  async get(key: string): Promise<string | null> {
    const { data, error } = await this.db.client
      .from('settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();

    assertNoError(error, 'settings.get');
    return (data as { value: string } | null)?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const { error } = await this.db.client
      .from('settings')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });

    assertNoError(error, 'settings.set');
  }

  async setMany(values: Record<string, string>): Promise<void> {
    const now = new Date().toISOString();
    const rows = Object.entries(values).map(([key, value]) => ({
      key,
      value,
      updated_at: now,
    }));
    if (rows.length === 0) return;

    const { error } = await this.db.client
      .from('settings')
      .upsert(rows, { onConflict: 'key' });

    assertNoError(error, 'settings.setMany');
  }

  /** Writes a value only when the key does not exist yet - used for seeding. */
  async setIfAbsent(key: string, value: string): Promise<void> {
    const existing = await this.get(key);
    if (existing !== null) return;
    await this.set(key, value);
  }

  async updatedAt(): Promise<string | null> {
    const { data, error } = await this.db.client
      .from('settings')
      .select('updated_at')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    assertNoError(error, 'settings.updatedAt');
    return (data as { updated_at: string } | null)?.updated_at ?? null;
  }
}

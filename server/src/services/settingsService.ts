import { z } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../errors.js';
import { logger } from '../logger.js';
import type { SettingsRepository } from '../repositories/settingsRepository.js';

/**
 * Runtime settings.
 *
 * Deliberately absent: target price, price thresholds, minimum discount. This
 * application notifies on *every* change from the last observed price, so there
 * is nothing for a user to tune about alert conditions.
 */
export const settingsSchema = z.object({
  /** How often each product is re-checked. */
  monitorIntervalMinutes: z.number().int().min(1).max(1440),
  /** Global kill switch for scheduled checks. */
  monitoringEnabled: z.boolean(),
  /** Upper bound on checks running at the same time. */
  maxConcurrentChecks: z.number().int().min(1).max(20),
  /** Per-attempt request timeout. */
  requestTimeoutMs: z.number().int().min(1_000).max(180_000),
  /** Total fetch attempts per strategy before a check is marked failed. */
  fetchMaxRetries: z.number().int().min(1).max(10),
  /** Whether in-app notifications are created on a price change. */
  notifyInApp: z.boolean(),
  /** How long the check audit trail is kept. */
  checkLogRetentionDays: z.number().int().min(1).max(365),
});

export type AppSettings = z.infer<typeof settingsSchema>;

export const settingsUpdateSchema = settingsSchema.partial().strict();
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

type SettingKey = keyof AppSettings;

const BOOLEAN_KEYS: readonly SettingKey[] = ['monitoringEnabled', 'notifyInApp'];

export type SettingsListener = (settings: AppSettings, changed: SettingKey[]) => void;

/**
 * Settings are cached in memory after `init()` and refreshed on every write,
 * so `get()`/`getAll()` stay synchronous for callers (the scheduler, the
 * price monitor) that read settings on every check without wanting to await
 * a network round trip each time.
 */
export class SettingsService {
  private cache: AppSettings;
  private readonly listeners = new Set<SettingsListener>();
  private readonly log = logger.child({ component: 'settings' });

  private constructor(
    private readonly repo: SettingsRepository,
    private readonly defaults: AppSettings,
    initialCache: AppSettings,
  ) {
    this.cache = initialCache;
  }

  /**
   * Seeds any never-set keys from `defaults` and loads the current values.
   * Must be awaited before the service is used - construction alone does not
   * touch the database.
   */
  static async create(
    repo: SettingsRepository,
    defaults: AppSettings = defaultSettings(),
  ): Promise<SettingsService> {
    for (const [key, value] of Object.entries(defaults)) {
      await repo.setIfAbsent(key, serialise(value));
    }

    const service = new SettingsService(repo, defaults, defaults);
    service.cache = await service.readFromStore();
    return service;
  }

  private async readFromStore(): Promise<AppSettings> {
    const raw = await this.repo.getAll();
    const merged: Record<string, unknown> = { ...this.defaults };

    for (const key of Object.keys(this.defaults) as SettingKey[]) {
      const stored = raw[key];
      if (stored === undefined) continue;
      merged[key] = BOOLEAN_KEYS.includes(key) ? stored === 'true' : coerceNumber(stored);
    }

    const parsed = settingsSchema.safeParse(merged);
    if (parsed.success) return parsed.data;

    // A corrupt or out-of-range stored value must not stop the app from
    // booting; fall back to defaults and say so loudly.
    this.log.warn('Stored settings were invalid; falling back to defaults', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
    return { ...this.defaults };
  }

  getAll(): AppSettings {
    return { ...this.cache };
  }

  get<K extends SettingKey>(key: K): AppSettings[K] {
    return this.cache[key];
  }

  /** Applies a validated partial update and notifies listeners. */
  async update(patch: unknown): Promise<AppSettings> {
    const parsed = settingsUpdateSchema.safeParse(patch);
    if (!parsed.success) {
      throw AppError.badRequest(
        'Invalid settings payload.',
        parsed.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      );
    }

    const entries = Object.entries(parsed.data) as [SettingKey, AppSettings[SettingKey]][];
    const changed: SettingKey[] = [];
    const toWrite: Record<string, string> = {};

    for (const [key, value] of entries) {
      if (value === undefined) continue;
      if (this.cache[key] === value) continue;
      changed.push(key);
      toWrite[key] = serialise(value);
    }

    if (changed.length === 0) return this.getAll();

    await this.repo.setMany(toWrite);
    this.cache = await this.readFromStore();

    this.log.info('Settings updated', {
      changed,
      settings: this.cache,
    });

    for (const listener of this.listeners) {
      try {
        listener(this.getAll(), changed);
      } catch (err) {
        this.log.error('Settings listener threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return this.getAll();
  }

  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-reads from storage; useful after an out-of-band write. */
  async refresh(): Promise<AppSettings> {
    this.cache = await this.readFromStore();
    return this.getAll();
  }

  async updatedAt(): Promise<string | null> {
    return this.repo.updatedAt();
  }
}

function serialise(value: unknown): string {
  return typeof value === 'boolean' ? String(value) : String(value);
}

function coerceNumber(value: string): number | string {
  const num = Number(value);
  return Number.isFinite(num) ? num : value;
}

/** Settings defaults, seeded from environment variables. */
export function defaultSettings(): AppSettings {
  return {
    monitorIntervalMinutes: env.defaults.monitorIntervalMinutes,
    monitoringEnabled: env.defaults.monitoringEnabled,
    maxConcurrentChecks: env.defaults.maxConcurrentChecks,
    requestTimeoutMs: env.defaults.requestTimeoutMs,
    fetchMaxRetries: env.defaults.fetchMaxRetries,
    notifyInApp: env.defaults.notifyInApp,
    checkLogRetentionDays: 14,
  };
}

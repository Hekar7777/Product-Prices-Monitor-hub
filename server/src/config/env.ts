import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Root of the `server` package (works from both `src/` and `dist/`). */
export const SERVER_ROOT = path.resolve(here, '..', '..');

/** Root of the monorepo. */
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

// Load .env from the repo root first, then allow a server-local .env to win.
dotenv.config({ path: path.join(REPO_ROOT, '.env') });
dotenv.config({ path: path.join(SERVER_ROOT, '.env'), override: true });

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/** Resolve a possibly-relative path against the server package root. */
function resolvePath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(SERVER_ROOT, value);
}

export type FetchStrategy = 'auto' | 'http' | 'playwright';

function fetchStrategy(): FetchStrategy {
  const v = str('FETCH_STRATEGY', 'auto').toLowerCase();
  return v === 'http' || v === 'playwright' ? v : 'auto';
}

const nodeEnv = str('NODE_ENV', 'development');

/**
 * Process-level configuration. Values here are fixed for the lifetime of the
 * process. Anything a user can change at runtime lives in the `settings` table
 * instead (see SettingsService) - the values below only seed it on first boot.
 */
export const env = {
  nodeEnv,
  isTest: nodeEnv === 'test',
  isProduction: nodeEnv === 'production',

  port: int('PORT', 4000),
  host: str('HOST', '127.0.0.1'),
  corsOrigins: str('CORS_ORIGIN', 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  /**
   * Supabase project credentials. The service role key is server-only and
   * must never be sent to the frontend - it bypasses Row Level Security.
   * Both are required; `db/supabase.ts` throws a clear error at startup if
   * either is missing rather than failing confusingly on the first query.
   */
  supabaseUrl: process.env.SUPABASE_URL?.trim() || null,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null,

  /**
   * Shared secret the price-check cron job must present via the
   * `x-cron-secret` header to trigger POST /api/cron/check-prices.
   */
  cronSecret: process.env.CRON_SECRET?.trim() || null,

  logLevel: str('LOG_LEVEL', 'info'),
  logFormat: str('LOG_FORMAT', 'pretty') === 'json' ? ('json' as const) : ('pretty' as const),
  logFile: process.env.LOG_FILE?.trim() ? resolvePath(str('LOG_FILE', './logs/app.log')) : null,

  /** Seeds for the runtime settings table. */
  defaults: {
    monitorIntervalMinutes: int('MONITOR_INTERVAL_MINUTES', 15),
    monitoringEnabled: bool('MONITORING_ENABLED', true),
    maxConcurrentChecks: int('MAX_CONCURRENT_CHECKS', 3),
    requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 30_000),
    fetchMaxRetries: int('FETCH_MAX_RETRIES', 3),
    notifyInApp: bool('NOTIFY_IN_APP', true),
  },

  fetchStrategy: fetchStrategy(),
  playwrightHeadless: bool('PLAYWRIGHT_HEADLESS', true),

  /**
   * Web Push (VAPID) credentials, used by the Web Push notification channel.
   * The private key is server-only and must never be sent to the frontend -
   * only `vapidPublicKey` is exposed, via `GET /api/push/vapid-public-key`.
   * Unset means the channel is disabled (`WebPushNotificationProvider.isEnabled()`
   * returns false rather than throwing).
   */
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY?.trim() || null,
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY?.trim() || null,
  /** Contact URI Web Push requires in the VAPID JWT, e.g. `mailto:you@example.com`. */
  vapidSubject: str('VAPID_SUBJECT', 'mailto:admin@example.com'),
} as const;

export type Env = typeof env;

import type { Express } from 'express';
import { createApp } from '../../src/app/createApp.js';
import { createContainer, type AppContainer } from '../../src/app/container.js';
import type { SchedulerOptions } from '../../src/scheduler/scheduler.js';
import { defaultSettings, type AppSettings } from '../../src/services/settingsService.js';
import { FakeFlipkartFetcher } from './fakeFetcher.js';
import { createFakeSupabaseDb } from './fakeSupabase.js';

/**
 * Builds a fully wired application around an in-memory fake Supabase client
 * and the fake Flipkart fetcher. Every test file gets its own fresh fake
 * database, so files are isolated and can run in parallel exactly as they
 * could with the previous in-memory SQLite setup.
 */
export interface TestHarness {
  container: AppContainer;
  fetcher: FakeFlipkartFetcher;
  app: Express;
  dispose: () => Promise<void>;
}

export interface HarnessOptions {
  settings?: Partial<AppSettings>;
  schedulerOptions?: SchedulerOptions;
}

export async function createHarness(options: HarnessOptions = {}): Promise<TestHarness> {
  const fetcher = new FakeFlipkartFetcher();
  const db = createFakeSupabaseDb();

  const container = await createContainer({
    db,
    fetcher,
    settingsDefaults: { ...defaultSettings(), ...options.settings },
    schedulerOptions: options.schedulerOptions,
  });

  const app = createApp(container);

  return {
    container,
    fetcher,
    app,
    dispose: () => container.shutdown(),
  };
}

/** Counts rows in a table - handy for asserting nothing was written. */
export async function countRows(container: AppContainer, table: string): Promise<number> {
  const { count } = await container.db.client.from(table).select('*', { count: 'exact', head: true });
  return count ?? 0;
}

/**
 * Rewinds a product's `last_attempted_at` so the scheduler considers it due
 * without the test having to wait for real time to pass.
 */
export async function makeDue(
  container: AppContainer,
  productId: number,
  minutesAgo = 60,
): Promise<void> {
  const when = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  await container.db.client
    .from('products')
    .update({ last_attempted_at: when, last_checked_at: when })
    .eq('id', productId);
}

/** Backdates a price history row, used to test chart range filtering. */
export async function backdateHistory(
  container: AppContainer,
  historyId: number,
  daysAgo: number,
): Promise<void> {
  const when = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  await container.db.client.from('price_history').update({ timestamp: when }).eq('id', historyId);
}

import { createDatabase } from '../db/index.js';
import type { Db } from '../db/index.js';
import { createFlipkartFetcher } from '../fetcher/index.js';
import type { FlipkartProductFetcher } from '../fetcher/types.js';
import { InAppNotificationProvider } from '../notifications/inAppProvider.js';
import { NotificationService } from '../notifications/notificationService.js';
import type { NotificationProvider } from '../notifications/types.js';
import { WebPushNotificationProvider } from '../notifications/webPushProvider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { MonitoringScheduler, type SchedulerOptions } from '../scheduler/scheduler.js';
import { PriceMonitorService } from '../services/priceMonitorService.js';
import { ProductService } from '../services/productService.js';
import { SettingsService, type AppSettings } from '../services/settingsService.js';

/**
 * Composition root.
 *
 * Every dependency is constructed here and injected downwards, which is what
 * lets the test suite build a fully wired application around a fake
 * `FlipkartProductFetcher` and a fake/injected database client.
 *
 * `createContainer()` is now async: `SettingsService.create()` reads/seeds
 * settings from Supabase before anything else can safely start, so there is
 * no synchronous path through this file anymore.
 */
export interface AppContainer {
  db: Db;
  repositories: Repositories;
  settings: SettingsService;
  notifications: NotificationService;
  monitor: PriceMonitorService;
  products: ProductService;
  scheduler: MonitoringScheduler;
  fetcher: FlipkartProductFetcher;
  shutdown(): Promise<void>;
}

export interface ContainerOptions {
  /** Pre-opened database handle (tests inject a fake Supabase-shaped client). */
  db?: Db;
  /** Replace the Flipkart extractor - tests inject a deterministic fake. */
  fetcher?: FlipkartProductFetcher;
  /** Override seeded settings defaults. */
  settingsDefaults?: AppSettings;
  /** Extra notification providers alongside the built-in ones. */
  notificationProviders?: NotificationProvider[];
  schedulerOptions?: SchedulerOptions;
}

export async function createContainer(options: ContainerOptions = {}): Promise<AppContainer> {
  const db = options.db ?? createDatabase();
  const repositories = createRepositories(db);

  const settings = await SettingsService.create(repositories.settings, options.settingsDefaults);

  const fetcher =
    options.fetcher ??
    createFlipkartFetcher({
      timeoutMs: settings.get('requestTimeoutMs'),
      maxAttempts: settings.get('fetchMaxRetries'),
    });

  const notifications = new NotificationService(repositories.notifications, [
    new InAppNotificationProvider(settings),
    new WebPushNotificationProvider(repositories.pushSubscriptions),
    ...(options.notificationProviders ?? []),
  ]);

  const monitor = new PriceMonitorService({
    db,
    products: repositories.products,
    priceHistory: repositories.priceHistory,
    priceChanges: repositories.priceChanges,
    checkLogs: repositories.checkLogs,
    fetcher,
    notifications,
    settings,
  });

  const products = new ProductService({
    db,
    products: repositories.products,
    priceHistory: repositories.priceHistory,
    priceChanges: repositories.priceChanges,
    checkLogs: repositories.checkLogs,
    notifications: repositories.notifications,
    fetcher,
    settings,
  });

  const scheduler = new MonitoringScheduler(
    {
      products: repositories.products,
      checkLogs: repositories.checkLogs,
      monitor,
      settings,
    },
    options.schedulerOptions ?? {},
  );

  let closed = false;

  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;

    await scheduler.stop();
    await fetcher.close?.();
  };

  return {
    db,
    repositories,
    settings,
    notifications,
    monitor,
    products,
    scheduler,
    fetcher,
    shutdown,
  };
}

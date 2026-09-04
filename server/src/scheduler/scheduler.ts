import type { Product } from '../domain/types.js';
import { logger, serialiseError } from '../logger.js';
import type { CheckLogRepository } from '../repositories/checkLogRepository.js';
import type { ProductRepository } from '../repositories/productRepository.js';
import type { CheckResult, PriceMonitorService } from '../services/priceMonitorService.js';
import type { SettingsService } from '../services/settingsService.js';

/**
 * Price-check runner.
 *
 * This process no longer self-schedules. There is deliberately no internal
 * timer/interval here: on a serverless-friendly deployment (Vercel + GitHub
 * Actions cron, see `.github/workflows/check-prices.yml`) nothing keeps a
 * Node process alive between requests, so the "wake up periodically" job
 * moved outside the app entirely. `POST /api/cron/check-prices` (protected by
 * a shared secret) is what now drives `runTick()`, on whatever cadence the
 * external cron trigger uses.
 *
 * Everything below `runTick()` - due-product selection, concurrency capping,
 * per-product failure isolation - is unchanged from the previous
 * always-on-timer design; only the thing that calls `runTick()` moved.
 *
 * Safety properties:
 *   - Ticks never overlap. If a tick is still running when another is
 *     requested, the new one is skipped and logged.
 *   - A product is never checked twice at the same time. This filters
 *     products already in flight, and `PriceMonitorService` enforces the same
 *     invariant for manual API-triggered checks.
 *   - Concurrency is capped by the `maxConcurrentChecks` setting.
 *   - A failure in one product's check never aborts the tick.
 */

export interface TickSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Products the scheduler considered due at the start of the tick. */
  due: number;
  /** Products actually checked in this tick. */
  checked: number;
  baseline: number;
  unchanged: number;
  changed: number;
  failed: number;
  skipped: number;
  notifications: number;
}

export interface SchedulerStatus {
  /**
   * Always `true` while the process is up - retained for API/frontend
   * compatibility. There is no internal timer to be "armed" or "stopped"
   * anymore; ticks only ever run when something calls `runTick()`.
   */
  running: boolean;
  /** The `monitoringEnabled` setting - a global pause honoured by the cron endpoint. */
  monitoringEnabled: boolean;
  intervalMinutes: number;
  maxConcurrentChecks: number;
  tickInProgress: boolean;
  activeChecks: number;
  activeProductIds: number[];
  lastTickStartedAt: string | null;
  lastTickFinishedAt: string | null;
  lastTick: TickSummary | null;
  totalTicks: number;
  totalChecks: number;
}

export interface SchedulerDeps {
  products: ProductRepository;
  checkLogs: CheckLogRepository;
  monitor: PriceMonitorService;
  settings: SettingsService;
}

export interface SchedulerOptions {
  /** Maximum products pulled into a single tick. */
  batchSize?: number;
}

export class MonitoringScheduler {
  private tickInProgress = false;
  private abortController: AbortController | null = null;
  private currentTick: Promise<TickSummary | null> | null = null;

  private lastTickStartedAt: string | null = null;
  private lastTickFinishedAt: string | null = null;
  private lastTick: TickSummary | null = null;
  private totalTicks = 0;
  private totalChecks = 0;
  private lastPruneAt = 0;

  private readonly log = logger.child({ component: 'scheduler' });
  private readonly batchSize: number;

  constructor(
    private readonly deps: SchedulerDeps,
    options: SchedulerOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 200;
  }

  /**
   * Waits for any tick currently in flight to settle. There is no timer to
   * clear - kept as a no-op-ish drain so `container.shutdown()` did not need
   * to change its call site.
   */
  async stop(): Promise<void> {
    this.abortController?.abort();

    if (this.currentTick) {
      try {
        await this.currentTick;
      } catch {
        // A failing tick during shutdown is not interesting.
      }
    }
  }

  /**
   * Runs one monitoring pass. Exposed so tests (and an operator, via the API)
   * can drive the scheduler deterministically instead of waiting on timers.
   *
   * @returns the tick summary, or null when the tick was skipped.
   */
  async runTick(): Promise<TickSummary | null> {
    if (this.tickInProgress) {
      this.log.warn('Previous tick is still running; skipping this one', {
        event: 'scheduler.tick.skipped',
        activeChecks: this.deps.monitor.runningCount(),
      });
      return null;
    }

    const settings = this.deps.settings.getAll();

    if (!settings.monitoringEnabled) {
      this.log.debug('Monitoring is disabled globally; nothing to do', {
        event: 'scheduler.tick.disabled',
      });
      return null;
    }

    this.tickInProgress = true;
    this.abortController = new AbortController();

    const tick = this.executeTick(settings.monitorIntervalMinutes, settings.maxConcurrentChecks);
    this.currentTick = tick;

    try {
      return await tick;
    } finally {
      this.tickInProgress = false;
      this.currentTick = null;
      this.abortController = null;
    }
  }

  private async executeTick(
    intervalMinutes: number,
    maxConcurrent: number,
  ): Promise<TickSummary> {
    const startedAt = new Date();
    this.lastTickStartedAt = startedAt.toISOString();
    this.totalTicks += 1;

    const dueProducts = await this.deps.products.findDue(intervalMinutes, this.batchSize);

    // Drop anything already in flight (e.g. a manual check the user just fired)
    // so the scheduler neither duplicates work nor burns a concurrency slot.
    const queue = dueProducts.filter((product) => !this.deps.monitor.isChecking(product.id));
    const alreadyRunning = dueProducts.length - queue.length;

    const summary: TickSummary = {
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      durationMs: 0,
      due: dueProducts.length,
      checked: 0,
      baseline: 0,
      unchanged: 0,
      changed: 0,
      failed: 0,
      skipped: alreadyRunning,
      notifications: 0,
    };

    if (dueProducts.length === 0) {
      this.log.debug('No products are due for a check', { event: 'scheduler.tick.empty' });
    } else {
      this.log.info('Scheduler tick started', {
        event: 'scheduler.tick.started',
        due: dueProducts.length,
        queued: queue.length,
        alreadyRunning,
        maxConcurrent,
        intervalMinutes,
      });
    }

    const concurrency = Math.max(1, Math.min(maxConcurrent, queue.length || 1));
    const pending = [...queue];

    const worker = async (): Promise<void> => {
      while (pending.length > 0) {
        if (this.abortController?.signal.aborted) return;
        const product = pending.shift();
        if (!product) return;
        await this.checkOne(product, summary);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    const finishedAt = new Date();
    summary.finishedAt = finishedAt.toISOString();
    summary.durationMs = finishedAt.getTime() - startedAt.getTime();

    this.lastTickFinishedAt = summary.finishedAt;
    this.lastTick = summary;

    if (summary.checked > 0 || summary.skipped > 0) {
      this.log.info('Scheduler tick finished', {
        event: 'scheduler.tick.finished',
        ...summary,
      });
    }

    await this.maybePruneCheckLogs();

    return summary;
  }

  private async checkOne(product: Product, summary: TickSummary): Promise<void> {
    try {
      const signal = this.abortController?.signal;
      const result: CheckResult = await this.deps.monitor.checkProduct(product.id, {
        trigger: 'scheduler',
        ...(signal ? { signal } : {}),
      });

      summary.checked += 1;
      this.totalChecks += 1;
      summary.notifications += result.notifications.length;

      switch (result.kind) {
        case 'baseline':
          summary.baseline += 1;
          break;
        case 'unchanged':
          summary.unchanged += 1;
          break;
        case 'changed':
          summary.changed += 1;
          break;
        case 'failed':
          summary.failed += 1;
          break;
        case 'skipped':
          summary.skipped += 1;
          summary.checked -= 1;
          this.totalChecks -= 1;
          break;
      }
    } catch (err) {
      // A product deleted mid-tick, or any unexpected fault, is contained here
      // so the rest of the batch still runs.
      summary.failed += 1;
      this.log.error('Unexpected error while checking a product', {
        event: 'scheduler.error',
        productId: product.id,
        productName: product.productName,
        ...serialiseError(err),
      });
    }
  }

  /** Keeps the audit trail bounded. Runs at most once an hour. */
  private async maybePruneCheckLogs(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPruneAt < 3_600_000) return;
    this.lastPruneAt = now;

    try {
      const days = this.deps.settings.get('checkLogRetentionDays');
      const cutoff = new Date(now - days * 86_400_000).toISOString();
      const removed = await this.deps.checkLogs.pruneOlderThan(cutoff);
      if (removed > 0) {
        this.log.info('Pruned old check logs', { removed, retentionDays: days });
      }
    } catch (err) {
      this.log.warn('Failed to prune check logs', { ...serialiseError(err) });
    }
  }

  status(): SchedulerStatus {
    const settings = this.deps.settings.getAll();
    return {
      running: true,
      monitoringEnabled: settings.monitoringEnabled,
      intervalMinutes: settings.monitorIntervalMinutes,
      maxConcurrentChecks: settings.maxConcurrentChecks,
      tickInProgress: this.tickInProgress,
      activeChecks: this.deps.monitor.runningCount(),
      activeProductIds: this.deps.monitor.runningProductIds(),
      lastTickStartedAt: this.lastTickStartedAt,
      lastTickFinishedAt: this.lastTickFinishedAt,
      lastTick: this.lastTick,
      totalTicks: this.totalTicks,
      totalChecks: this.totalChecks,
    };
  }
}

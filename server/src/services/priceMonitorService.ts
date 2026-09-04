import type { Db } from '../db/index.js';
import { computePriceDelta, isValidPrice, pricesDiffer, roundMoney } from '../domain/money.js';
import type {
  AppNotification,
  CheckLogEntry,
  CheckOutcome,
  CheckTrigger,
  PriceChange,
  PriceHistoryEntry,
  Product,
} from '../domain/types.js';
import { AppError, FetchError, type FetchErrorCode } from '../errors.js';
import type { FetchedProduct, FlipkartProductFetcher } from '../fetcher/types.js';
import { logger, serialiseError } from '../logger.js';
import type { NotificationService } from '../notifications/notificationService.js';
import type { CheckLogRepository } from '../repositories/checkLogRepository.js';
import type { PriceChangeRepository } from '../repositories/priceChangeRepository.js';
import type { PriceHistoryRepository } from '../repositories/priceHistoryRepository.js';
import type { ProductPatch, ProductRepository } from '../repositories/productRepository.js';
import type { SettingsService } from './settingsService.js';

/**
 * The price comparison engine - the single place where the application's one
 * business rule lives:
 *
 *   If the freshly observed price differs from the last successfully observed
 *   price, record a change and notify. Otherwise do nothing.
 *
 * There is no target price, no threshold and no minimum discount anywhere in
 * this file, by design.
 *
 * Failure isolation is the other half of the contract: a failed fetch (network
 * error, timeout, CAPTCHA, missing price, parse failure) updates only the
 * attempt bookkeeping. `current_price` and `last_checked_at` are never touched,
 * and no notification is produced.
 */

export type CheckResultKind = CheckOutcome | 'failed' | 'skipped';

export interface CheckResult {
  kind: CheckResultKind;
  /** Product state after the check. Null only when the product disappeared. */
  product: Product | null;
  change: PriceChange | null;
  historyEntry: PriceHistoryEntry | null;
  notifications: AppNotification[];
  log: CheckLogEntry | null;
  errorCode: FetchErrorCode | null;
  errorMessage: string | null;
  /** Populated when `kind` is `skipped`. */
  skipReason?: 'already_running';
}

export interface CheckOptions {
  trigger?: CheckTrigger;
  signal?: AbortSignal;
}

export interface PriceMonitorDeps {
  db: Db;
  products: ProductRepository;
  priceHistory: PriceHistoryRepository;
  priceChanges: PriceChangeRepository;
  checkLogs: CheckLogRepository;
  fetcher: FlipkartProductFetcher;
  notifications: NotificationService;
  settings: SettingsService;
}

export class PriceMonitorService {
  private readonly log = logger.child({ component: 'monitor' });

  /**
   * Per-product in-flight guard. Both the scheduler and manual API triggers go
   * through `checkProduct`, so a single map here prevents any two overlapping
   * checks for the same product regardless of where they came from.
   */
  private readonly inFlight = new Map<number, Promise<CheckResult>>();

  constructor(private readonly deps: PriceMonitorDeps) {}

  isChecking(productId: number): boolean {
    return this.inFlight.has(productId);
  }

  runningCount(): number {
    return this.inFlight.size;
  }

  runningProductIds(): number[] {
    return [...this.inFlight.keys()];
  }

  /**
   * Checks one product.
   *
   * If a check for the same product is already running, this returns a
   * `skipped` result immediately instead of starting a second one.
   */
  async checkProduct(productId: number, options: CheckOptions = {}): Promise<CheckResult> {
    const trigger: CheckTrigger = options.trigger ?? 'scheduler';

    if (this.inFlight.has(productId)) {
      return this.recordSkip(productId, trigger);
    }

    const run = this.runCheck(productId, trigger, options.signal).finally(() => {
      this.inFlight.delete(productId);
    });

    this.inFlight.set(productId, run);
    return run;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private async recordSkip(productId: number, trigger: CheckTrigger): Promise<CheckResult> {
    const now = new Date().toISOString();
    this.log.warn('Skipped check because one is already running for this product', {
      event: 'product.check.skipped',
      productId,
      trigger,
    });

    const log = await this.deps.checkLogs.create({
      productId,
      status: 'skipped',
      outcome: null,
      price: null,
      errorCode: null,
      errorMessage: 'A check for this product was already in progress.',
      attempts: 0,
      durationMs: 0,
      strategy: null,
      triggerSource: trigger,
      startedAt: now,
      finishedAt: now,
    });

    return {
      kind: 'skipped',
      product: await this.deps.products.findById(productId),
      change: null,
      historyEntry: null,
      notifications: [],
      log,
      errorCode: null,
      errorMessage: null,
      skipReason: 'already_running',
    };
  }

  private async runCheck(
    productId: number,
    trigger: CheckTrigger,
    signal?: AbortSignal,
  ): Promise<CheckResult> {
    const product = await this.deps.products.findById(productId);
    if (!product) throw AppError.notFound(`Product ${productId} does not exist.`);

    const startedAt = new Date();
    const settings = this.deps.settings.getAll();

    this.log.info('Product check started', {
      event: 'product.check.started',
      productId: product.id,
      productName: product.productName,
      url: product.url,
      trigger,
      knownPrice: product.currentPrice,
    });

    let fetched: FetchedProduct;
    let strategy: string | null = null;
    let attempts = 1;

    try {
      const result = await this.deps.fetcher.fetchProduct(product.url, {
        timeoutMs: settings.requestTimeoutMs,
        maxRetries: settings.fetchMaxRetries,
        ...(signal ? { signal } : {}),
      });
      fetched = result.product;
      strategy = result.meta.strategy;
      attempts = result.meta.attempts;
    } catch (err) {
      return await this.handleFailure(product, err, { startedAt, trigger, strategy, attempts });
    }

    // Defence in depth: a fetcher must never hand back an unusable price, but
    // if one ever did, treat it as a failed check rather than a price change.
    if (!isValidPrice(fetched.price)) {
      return await this.handleFailure(
        product,
        new FetchError('PRICE_NOT_FOUND', 'The extractor returned no usable price.', {
          url: product.url,
          ...(strategy ? { strategy } : {}),
        }),
        { startedAt, trigger, strategy, attempts },
      );
    }

    return await this.handleSuccess(product, fetched, { startedAt, trigger, strategy, attempts });
  }

  /**
   * A failed check records the attempt and nothing else.
   *
   * Specifically: `current_price`, `previous_price`, `lowest_price`,
   * `highest_price` and `last_checked_at` are all left exactly as they were, and
   * no price_history / price_changes / notifications rows are written.
   */
  private async handleFailure(
    product: Product,
    err: unknown,
    ctx: { startedAt: Date; trigger: CheckTrigger; strategy: string | null; attempts: number },
  ): Promise<CheckResult> {
    const error = err instanceof FetchError ? err : FetchError.from(err, 'UNKNOWN', product.url);
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - ctx.startedAt.getTime();

    // Classified failures are anticipated outcomes (a CAPTCHA page, a timeout,
    // a removed product), so they are reported concisely. Only a truly
    // unexpected error gets the full stack trace.
    const unexpected = error.code === 'UNKNOWN';
    const extractionFields = {
      event: 'extraction.error',
      productId: product.id,
      url: product.url,
      code: error.code,
      strategy: error.strategy ?? ctx.strategy,
      attempts: ctx.attempts,
      reason: error.message,
    };

    if (unexpected) {
      this.log.error('Extraction failed unexpectedly', {
        ...extractionFields,
        ...serialiseError(error),
      });
    } else {
      this.log.warn('Extraction failed', extractionFields);
    }

    const updated = await this.deps.db.transaction(async () => {
      const next = await this.deps.products.update(product.id, {
        // Only attempt bookkeeping changes. The price is deliberately untouched.
        lastAttemptedAt: finishedAt.toISOString(),
        lastStatus: 'failed',
        lastErrorCode: error.code,
        lastErrorMessage: error.message.slice(0, 500),
        consecutiveFailures: product.consecutiveFailures + 1,
      });

      const log = await this.deps.checkLogs.create({
        productId: product.id,
        status: 'failed',
        outcome: null,
        price: null,
        errorCode: error.code,
        errorMessage: error.message,
        attempts: ctx.attempts,
        durationMs,
        strategy: error.strategy ?? ctx.strategy,
        triggerSource: ctx.trigger,
        startedAt: ctx.startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      });

      return { next, log };
    });

    this.log.warn('Product check failed; retaining the last known price', {
      event: 'product.check.failed',
      productId: product.id,
      productName: product.productName,
      code: error.code,
      retainedPrice: product.currentPrice,
      consecutiveFailures: (updated.next ?? product).consecutiveFailures,
      durationMs,
      trigger: ctx.trigger,
    });

    return {
      kind: 'failed',
      product: updated.next,
      change: null,
      historyEntry: null,
      notifications: [],
      log: updated.log,
      errorCode: error.code,
      errorMessage: error.message,
    };
  }

  private async handleSuccess(
    product: Product,
    fetched: FetchedProduct,
    ctx: { startedAt: Date; trigger: CheckTrigger; strategy: string | null; attempts: number },
  ): Promise<CheckResult> {
    const finishedAt = new Date();
    const observedAt = finishedAt.toISOString();
    const durationMs = finishedAt.getTime() - ctx.startedAt.getTime();
    const newPrice = roundMoney(fetched.price);
    const lastKnownPrice = product.currentPrice;
    const currency = fetched.currency || product.currency || 'INR';

    // Metadata worth refreshing on every successful read.
    const metadata: ProductPatch = {
      productName: fetched.productName || product.productName,
      currency,
      mrp: fetched.mrp ?? product.mrp,
      availability: fetched.availability ?? product.availability,
      seller: fetched.seller ?? product.seller,
      ...(fetched.imageUrl ? { imageUrl: fetched.imageUrl } : {}),
    };

    const bookkeeping: ProductPatch = {
      lastCheckedAt: observedAt,
      lastAttemptedAt: observedAt,
      lastStatus: 'ok',
      lastErrorCode: null,
      lastErrorMessage: null,
      consecutiveFailures: 0,
    };

    // ---- Case 1: no baseline yet -----------------------------------------
    if (lastKnownPrice === null || !isValidPrice(lastKnownPrice)) {
      const outcome = await this.deps.db.transaction(async () => {
        const historyEntry = await this.deps.priceHistory.create({
          productId: product.id,
          price: newPrice,
          currency,
          mrp: fetched.mrp,
          availability: fetched.availability,
          seller: fetched.seller,
          sourceUrl: fetched.url,
          isBaseline: true,
          timestamp: observedAt,
        });

        const next = await this.deps.products.update(product.id, {
          ...metadata,
          ...bookkeeping,
          currentPrice: newPrice,
          previousPrice: null,
          lowestPrice: minPrice(product.lowestPrice, newPrice),
          highestPrice: maxPrice(product.highestPrice, newPrice),
        });

        const log = await this.deps.checkLogs.create({
          productId: product.id,
          status: 'success',
          outcome: 'baseline',
          price: newPrice,
          errorCode: null,
          errorMessage: null,
          attempts: ctx.attempts,
          durationMs,
          strategy: ctx.strategy,
          triggerSource: ctx.trigger,
          startedAt: ctx.startedAt.toISOString(),
          finishedAt: observedAt,
        });

        return { historyEntry, next, log };
      });

      // A baseline is not a change, so no notification is produced.
      this.log.info('Baseline price recorded', {
        event: 'product.check.succeeded',
        outcome: 'baseline',
        productId: product.id,
        productName: product.productName,
        price: newPrice,
        durationMs,
        trigger: ctx.trigger,
      });

      return {
        kind: 'baseline',
        product: outcome.next,
        change: null,
        historyEntry: outcome.historyEntry,
        notifications: [],
        log: outcome.log,
        errorCode: null,
        errorMessage: null,
      };
    }

    // ---- Case 2: price unchanged ----------------------------------------
    if (!pricesDiffer(lastKnownPrice, newPrice)) {
      const outcome = await this.deps.db.transaction(async () => {
        // No price_history row: history records movement, not every tick.
        const next = await this.deps.products.update(product.id, { ...metadata, ...bookkeeping });

        const log = await this.deps.checkLogs.create({
          productId: product.id,
          status: 'success',
          outcome: 'unchanged',
          price: newPrice,
          errorCode: null,
          errorMessage: null,
          attempts: ctx.attempts,
          durationMs,
          strategy: ctx.strategy,
          triggerSource: ctx.trigger,
          startedAt: ctx.startedAt.toISOString(),
          finishedAt: observedAt,
        });

        return { next, log };
      });

      this.log.info('Price unchanged', {
        event: 'price.unchanged',
        productId: product.id,
        productName: product.productName,
        price: newPrice,
        durationMs,
        trigger: ctx.trigger,
      });

      return {
        kind: 'unchanged',
        product: outcome.next,
        change: null,
        historyEntry: null,
        notifications: [],
        log: outcome.log,
        errorCode: null,
        errorMessage: null,
      };
    }

    // ---- Case 3: the price changed --------------------------------------
    const delta = computePriceDelta(lastKnownPrice, newPrice);

    const outcome = await this.deps.db.transaction(async () => {
      const historyEntry = await this.deps.priceHistory.create({
        productId: product.id,
        price: newPrice,
        currency,
        mrp: fetched.mrp,
        availability: fetched.availability,
        seller: fetched.seller,
        sourceUrl: fetched.url,
        isBaseline: false,
        timestamp: observedAt,
      });

      const change = await this.deps.priceChanges.create({
        productId: product.id,
        priceHistoryId: historyEntry.id,
        oldPrice: delta.oldPrice,
        newPrice: delta.newPrice,
        absoluteChange: delta.absoluteChange,
        percentageChange: delta.percentageChange,
        direction: delta.direction,
        currency,
        detectedAt: observedAt,
      });

      const next = await this.deps.products.update(product.id, {
        ...metadata,
        ...bookkeeping,
        previousPrice: delta.oldPrice,
        currentPrice: delta.newPrice,
        lowestPrice: minPrice(product.lowestPrice, newPrice),
        highestPrice: maxPrice(product.highestPrice, newPrice),
        lastPriceChangeAt: observedAt,
        priceChangeCount: product.priceChangeCount + 1,
      });

      const log = await this.deps.checkLogs.create({
        productId: product.id,
        status: 'success',
        outcome: 'changed',
        price: newPrice,
        errorCode: null,
        errorMessage: null,
        attempts: ctx.attempts,
        durationMs,
        strategy: ctx.strategy,
        triggerSource: ctx.trigger,
        startedAt: ctx.startedAt.toISOString(),
        finishedAt: observedAt,
      });

      return { historyEntry, change, next, log };
    });

    this.log.info('Price changed', {
      event: 'price.changed',
      productId: product.id,
      productName: product.productName,
      oldPrice: delta.oldPrice,
      newPrice: delta.newPrice,
      absoluteChange: delta.absoluteChange,
      percentageChange: delta.percentageChange,
      direction: delta.direction,
      durationMs,
      trigger: ctx.trigger,
    });

    // Notifications are dispatched outside the transaction: a provider being
    // slow or broken must not hold a database write open, and a delivery
    // failure must not roll back a genuine, recorded price change.
    const notifications = await this.deps.notifications.notifyPriceChange({
      product: outcome.next ?? product,
      change: outcome.change,
    });

    this.log.info('Product check succeeded', {
      event: 'product.check.succeeded',
      outcome: 'changed',
      productId: product.id,
      notificationsCreated: notifications.length,
      trigger: ctx.trigger,
    });

    return {
      kind: 'changed',
      product: outcome.next,
      change: outcome.change,
      historyEntry: outcome.historyEntry,
      notifications,
      log: outcome.log,
      errorCode: null,
      errorMessage: null,
    };
  }
}

function minPrice(existing: number | null, candidate: number): number {
  return existing === null || !isValidPrice(existing) ? candidate : Math.min(existing, candidate);
}

function maxPrice(existing: number | null, candidate: number): number {
  return existing === null || !isValidPrice(existing) ? candidate : Math.max(existing, candidate);
}

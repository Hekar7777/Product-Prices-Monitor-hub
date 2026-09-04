import type { Db } from '../db/index.js';
import { computePriceDelta, roundMoney } from '../domain/money.js';
import type {
  PriceChange,
  PriceDirection,
  PriceHistoryEntry,
  Product,
  ProductStats,
} from '../domain/types.js';
import { AppError, FetchError, describeFetchError } from '../errors.js';
import type { FlipkartProductFetcher } from '../fetcher/types.js';
import { parseFlipkartUrl } from '../fetcher/url.js';
import { logger } from '../logger.js';
import type { CheckLogRepository } from '../repositories/checkLogRepository.js';
import type { NotificationRepository } from '../repositories/notificationRepository.js';
import type { PriceChangeRepository } from '../repositories/priceChangeRepository.js';
import type { PriceHistoryRepository } from '../repositories/priceHistoryRepository.js';
import type { ListProductsOptions, ProductRepository } from '../repositories/productRepository.js';
import type { SettingsService } from './settingsService.js';

/** Chart/table time windows offered on the product detail page. */
export const HISTORY_RANGES = ['24h', '7d', '30d', '3m', 'all'] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];

const RANGE_DAYS: Record<HistoryRange, number | null> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  '3m': 90,
  all: null,
};

/** One row of the historical price table, with the delta already computed. */
export interface PriceHistoryPoint {
  id: number;
  price: number;
  timestamp: string;
  currency: string;
  availability: string | null;
  seller: string | null;
  isBaseline: boolean;
  /** Null for the first observation in the series. */
  change: {
    absoluteChange: number;
    percentageChange: number;
    direction: PriceDirection;
    signedChange: number;
  } | null;
}

/** A dashboard row: product plus its most recent change. */
export interface ProductWithChange {
  product: Product;
  latestChange: PriceChange | null;
}

export interface ProductDetail {
  product: Product;
  stats: ProductStats;
  latestChange: PriceChange | null;
}

export interface DashboardOverview {
  totalProducts: number;
  monitoredProducts: number;
  pausedProducts: number;
  changesLast24h: number;
  failedChecksLast24h: number;
  unreadNotifications: number;
  productsWithErrors: number;
  checksInProgress: number;
}

export interface ProductServiceDeps {
  db: Db;
  products: ProductRepository;
  priceHistory: PriceHistoryRepository;
  priceChanges: PriceChangeRepository;
  checkLogs: CheckLogRepository;
  notifications: NotificationRepository;
  fetcher: FlipkartProductFetcher;
  settings: SettingsService;
}

export class ProductService {
  private readonly log = logger.child({ component: 'products' });

  constructor(private readonly deps: ProductServiceDeps) {}

  /**
   * Adds a Flipkart product.
   *
   * The price read here becomes the baseline. A baseline is explicitly *not* a
   * price change, so no notification is produced for it.
   *
   * @throws AppError 400 for a non-Flipkart URL, 409 when already tracked,
   *         422 when the product page could not be read.
   */
  async addProduct(rawUrl: string): Promise<Product> {
    const info = this.parseUrlOrThrow(rawUrl);

    const existing = await this.deps.products.findByCanonicalKey(info.canonicalKey);
    if (existing) {
      throw AppError.conflict('That product is already being monitored.', {
        productId: existing.id,
        productName: existing.productName,
      });
    }

    const settings = this.deps.settings.getAll();
    const startedAt = new Date();

    this.log.info('Adding product', {
      event: 'product.add.started',
      url: info.normalisedUrl,
      canonicalKey: info.canonicalKey,
    });

    let fetched;
    let strategy: string | null = null;
    let attempts = 1;

    try {
      const result = await this.deps.fetcher.fetchProduct(info.normalisedUrl, {
        timeoutMs: settings.requestTimeoutMs,
        maxRetries: settings.fetchMaxRetries,
      });
      fetched = result.product;
      strategy = result.meta.strategy;
      attempts = result.meta.attempts;
    } catch (err) {
      const error = err instanceof FetchError ? err : FetchError.from(err, 'UNKNOWN', rawUrl);
      const finishedAt = new Date();

      // Record the failed attempt even though no product row exists yet, so the
      // failure is visible in the logs view rather than vanishing.
      await this.deps.checkLogs.create({
        productId: null,
        status: 'failed',
        outcome: null,
        price: null,
        errorCode: error.code,
        errorMessage: `${error.message} (${info.normalisedUrl})`,
        attempts,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        strategy: error.strategy ?? strategy,
        triggerSource: 'initial',
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      });

      this.log.error('Could not add product', {
        event: 'product.add.failed',
        url: info.normalisedUrl,
        code: error.code,
        message: error.message,
      });

      if (error.code === 'INVALID_URL') {
        throw AppError.badRequest(error.message);
      }
      throw AppError.unprocessable(
        `Could not read that product page. ${describeFetchError(error.code)}`,
        { code: error.code, detail: error.message },
      );
    }

    const finishedAt = new Date();
    const observedAt = finishedAt.toISOString();

    const product = await this.deps.db.transaction(async () => {
      const created = await this.deps.products.create({
        url: info.normalisedUrl,
        canonicalKey: info.canonicalKey,
        productName: fetched.productName,
        imageUrl: fetched.imageUrl,
        currency: fetched.currency || 'INR',
        price: fetched.price,
        mrp: fetched.mrp,
        availability: fetched.availability,
        seller: fetched.seller,
        observedAt,
      });

      await this.deps.priceHistory.create({
        productId: created.id,
        price: fetched.price,
        currency: created.currency,
        mrp: fetched.mrp,
        availability: fetched.availability,
        seller: fetched.seller,
        sourceUrl: fetched.url,
        isBaseline: true,
        timestamp: observedAt,
      });

      await this.deps.checkLogs.create({
        productId: created.id,
        status: 'success',
        outcome: 'baseline',
        price: fetched.price,
        errorCode: null,
        errorMessage: null,
        attempts,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        strategy,
        triggerSource: 'initial',
        startedAt: startedAt.toISOString(),
        finishedAt: observedAt,
      });

      return created;
    });

    this.log.info('Product added with baseline price', {
      event: 'product.add.succeeded',
      productId: product.id,
      productName: product.productName,
      baselinePrice: product.currentPrice,
      strategy,
    });

    return product;
  }

  private parseUrlOrThrow(rawUrl: string) {
    try {
      return parseFlipkartUrl(rawUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid URL.';
      throw AppError.badRequest(message);
    }
  }

  // -----------------------------------------------------------------------
  // Reads
  // -----------------------------------------------------------------------

  async list(options: ListProductsOptions = {}): Promise<ProductWithChange[]> {
    const products = await this.deps.products.list(options);
    const latest = await this.deps.priceChanges.latestForProducts(products.map((p) => p.id));
    return products.map((product) => ({
      product,
      latestChange: latest.get(product.id) ?? null,
    }));
  }

  async getById(id: number): Promise<Product> {
    const product = await this.deps.products.findById(id);
    if (!product) throw AppError.notFound(`Product ${id} was not found.`);
    return product;
  }

  async getDetail(id: number): Promise<ProductDetail> {
    const product = await this.getById(id);
    return {
      product,
      stats: await this.getStats(product),
      latestChange: await this.deps.priceChanges.latestByProduct(id),
    };
  }

  async getStats(product: Product): Promise<ProductStats> {
    const aggregate = await this.deps.priceHistory.aggregate(product.id);
    return {
      currentPrice: product.currentPrice,
      previousPrice: product.previousPrice,
      // Prefer the product's running extremes, falling back to the history
      // aggregate for products created before a column existed.
      lowestPrice: product.lowestPrice ?? aggregate.lowest,
      highestPrice: product.highestPrice ?? aggregate.highest,
      averagePrice: aggregate.average,
      totalPriceChanges: await this.deps.priceChanges.countByProduct(product.id),
      totalObservations: aggregate.observations,
      lastPriceChange: await this.deps.priceChanges.latestByProduct(product.id),
      lastCheckedAt: product.lastCheckedAt,
      lastPriceChangeAt: product.lastPriceChangeAt,
      firstTrackedAt: product.createdAt,
    };
  }

  /**
   * Price series for the chart and the history table.
   *
   * The stored series contains the baseline plus every change. To make a range
   * like "last 24 hours" render correctly, the most recent observation *before*
   * the window is prepended as the window's opening price.
   */
  async getHistory(id: number, range: HistoryRange = 'all'): Promise<PriceHistoryPoint[]> {
    const product = await this.getById(id);
    const days = RANGE_DAYS[range];

    let entries: PriceHistoryEntry[];

    if (days === null) {
      entries = await this.deps.priceHistory.listByProduct(product.id, { order: 'asc' });
    } else {
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const inWindow = await this.deps.priceHistory.listByProduct(product.id, {
        since,
        order: 'asc',
      });

      // Carry the last price from before the window so the chart starts at the
      // price that was actually in effect when the window opened.
      const priorAll = await this.deps.priceHistory.listByProduct(product.id, { order: 'desc' });
      const prior = priorAll.find((entry) => entry.timestamp < since) ?? null;
      entries = prior ? [prior, ...inWindow] : inWindow;
    }

    return entries.map((entry, index) => {
      const previous = index > 0 ? entries[index - 1] : undefined;
      if (!previous) {
        return toPoint(entry, null);
      }
      const delta = computePriceDelta(previous.price, entry.price);
      return toPoint(entry, {
        absoluteChange: delta.absoluteChange,
        percentageChange: delta.percentageChange,
        direction: delta.direction,
        signedChange: delta.signedChange,
      });
    });
  }

  async getChanges(id: number, limit = 100): Promise<PriceChange[]> {
    await this.getById(id);
    return this.deps.priceChanges.list({ productId: id, limit });
  }

  async overview(checksInProgress = 0): Promise<DashboardOverview> {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const total = await this.deps.products.count();
    const monitored = await this.deps.products.count({ monitoringEnabled: true });
    const allProducts = await this.deps.products.list();
    const withErrors = allProducts.filter((p) => p.lastStatus === 'failed').length;

    return {
      totalProducts: total,
      monitoredProducts: monitored,
      pausedProducts: total - monitored,
      changesLast24h: await this.deps.priceChanges.countSince(since),
      failedChecksLast24h: await this.deps.checkLogs.countByStatus('failed', since),
      unreadNotifications: await this.deps.notifications.unreadCount(),
      productsWithErrors: withErrors,
      checksInProgress,
    };
  }

  // -----------------------------------------------------------------------
  // Mutations
  // -----------------------------------------------------------------------

  async setMonitoring(id: number, enabled: boolean): Promise<Product> {
    const product = await this.getById(id);
    const updated = await this.deps.products.setMonitoring(product.id, enabled);
    if (!updated) throw AppError.notFound(`Product ${id} was not found.`);

    this.log.info(enabled ? 'Monitoring resumed' : 'Monitoring paused', {
      event: enabled ? 'product.monitoring.resumed' : 'product.monitoring.paused',
      productId: id,
      productName: updated.productName,
    });

    return updated;
  }

  async remove(id: number): Promise<void> {
    const product = await this.getById(id);
    const deleted = await this.deps.products.delete(product.id);
    if (!deleted) throw AppError.notFound(`Product ${id} was not found.`);

    this.log.info('Product removed', {
      event: 'product.removed',
      productId: id,
      productName: product.productName,
    });
  }
}

function toPoint(
  entry: PriceHistoryEntry,
  change: PriceHistoryPoint['change'],
): PriceHistoryPoint {
  return {
    id: entry.id,
    price: roundMoney(entry.price),
    timestamp: entry.timestamp,
    currency: entry.currency,
    availability: entry.availability,
    seller: entry.seller,
    isBaseline: entry.isBaseline,
    change,
  };
}

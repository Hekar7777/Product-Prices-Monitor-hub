import { FetchError, isRetryableFetchError, type FetchErrorCode } from '../errors.js';
import { logger } from '../logger.js';
import { parseFlipkartUrl } from './url.js';
import type { FetchOptions, FetchResult, FlipkartProductFetcher } from './types.js';

/**
 * Adds retries and strategy escalation on top of one or more concrete fetchers.
 *
 * Behaviour:
 *   - Retries only genuinely transient failures (timeouts, network blips, 5xx),
 *     with exponential backoff and jitter.
 *   - Escalates to the next fetcher when the page loaded but the price was not
 *     readable - that is the signal that a real browser is needed.
 *   - Never retries CAPTCHA. A verification page is a deliberate signal from
 *     Flipkart, and repeatedly hammering it would be an attempt to work around
 *     a protection mechanism.
 *   - Always throws a `FetchError`, so callers have a single error taxonomy.
 */

/** Failures where a heavier fetcher (a browser) may legitimately do better. */
const ESCALATABLE: ReadonlySet<FetchErrorCode> = new Set<FetchErrorCode>([
  'PRICE_NOT_FOUND',
  'PARSE_ERROR',
  'HTTP_ERROR',
]);

export interface ResilientFetcherOptions {
  /** Fetchers tried in order. The first one is the primary. */
  fetchers: FlipkartProductFetcher[];
  /** Total attempts per fetcher, including the first. Minimum 1. */
  maxAttempts?: number;
  defaultTimeoutMs?: number;
  /** Base backoff delay. Set to 0 in tests to keep them fast. */
  backoffBaseMs?: number;
  backoffCapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export class ResilientFlipkartFetcher implements FlipkartProductFetcher {
  readonly name: string;

  private readonly fetchers: FlipkartProductFetcher[];
  private readonly maxAttempts: number;
  private readonly defaultTimeoutMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log = logger.child({ component: 'fetcher' });

  constructor(options: ResilientFetcherOptions) {
    if (options.fetchers.length === 0) {
      throw new Error('ResilientFlipkartFetcher requires at least one fetcher');
    }
    this.fetchers = options.fetchers;
    this.name = options.fetchers.map((f) => f.name).join('+');
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.backoffBaseMs = options.backoffBaseMs ?? 750;
    this.backoffCapMs = options.backoffCapMs ?? 5_000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async fetchProduct(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    // Validate once, up front: an invalid URL is never worth retrying.
    const { normalisedUrl } = parseFlipkartUrl(url);

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxAttempts = Math.max(1, options.maxRetries ?? this.maxAttempts);

    let totalAttempts = 0;
    let lastError: FetchError = new FetchError('UNKNOWN', 'No fetch attempt was made.', {
      url: normalisedUrl,
    });

    for (let f = 0; f < this.fetchers.length; f += 1) {
      const fetcher = this.fetchers[f]!;
      const isLastFetcher = f === this.fetchers.length - 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (options.signal?.aborted) {
          throw new FetchError('TIMEOUT', 'Check aborted.', { url: normalisedUrl });
        }

        totalAttempts += 1;

        try {
          const result = await fetcher.fetchProduct(normalisedUrl, { ...options, timeoutMs });
          return {
            product: result.product,
            meta: { ...result.meta, attempts: totalAttempts },
          };
        } catch (err) {
          const error = FetchError.from(err, 'UNKNOWN', normalisedUrl);
          lastError = error;

          const canRetry = isRetryableFetchError(error.code) && attempt < maxAttempts;

          this.log.warn('Product fetch attempt failed', {
            url: normalisedUrl,
            strategy: fetcher.name,
            code: error.code,
            attempt,
            maxAttempts,
            willRetry: canRetry,
            message: error.message,
          });

          if (!canRetry) break;

          await this.sleep(this.backoffFor(attempt));
        }
      }

      const shouldEscalate = !isLastFetcher && ESCALATABLE.has(lastError.code);
      if (!shouldEscalate) break;

      this.log.info('Escalating to the next extraction strategy', {
        url: normalisedUrl,
        from: fetcher.name,
        to: this.fetchers[f + 1]?.name,
        reason: lastError.code,
      });
    }

    throw lastError;
  }

  /** Exponential backoff with full jitter, capped. */
  private backoffFor(attempt: number): number {
    if (this.backoffBaseMs <= 0) return 0;
    const exponential = Math.min(this.backoffCapMs, this.backoffBaseMs * 2 ** (attempt - 1));
    return Math.floor(exponential / 2 + Math.random() * (exponential / 2));
  }

  async close(): Promise<void> {
    for (const fetcher of this.fetchers) {
      try {
        await fetcher.close?.();
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

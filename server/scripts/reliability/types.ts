import type { FetchErrorCode } from '../../src/errors.js';

/**
 * Broader buckets the raw `FetchErrorCode` taxonomy is rolled up into for
 * this report. The production error taxonomy (`src/errors.ts`) is more
 * granular and is preserved verbatim in `fetchErrorCode` on every record;
 * this bucketing exists only to answer the specific breakdown categories
 * that were asked for (HTTP 403 vs. 429 vs. other HTTP errors vs.
 * timeout/network vs. CAPTCHA vs. page-loaded-but-no-price vs. everything
 * else), since several distinct `FetchErrorCode`s can share an HTTP status
 * and several distinct statuses can share a code.
 */
export type ReliabilityCategory =
  | 'SUCCESS'
  | 'HTTP_403_BLOCKED'
  | 'HTTP_429_RATE_LIMITED'
  | 'HTTP_OTHER_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'CAPTCHA_CHALLENGE'
  | 'PRODUCT_REMOVED'
  | 'PRODUCT_UNAVAILABLE'
  | 'PRICE_NOT_FOUND'
  | 'BROWSER_ERROR'
  | 'OTHER_FAILURE';

/** One captured retry/escalation attempt, read from the fetcher's own logs. */
export interface AttemptLogEntry {
  strategy: string;
  attempt: number;
  code: string;
  httpStatus: number | null;
  willRetry: boolean;
  message: string;
}

/** The full result of one `fetchProduct()` call against one URL. */
export interface CheckRecord {
  timestamp: string;
  round: number;
  url: string;
  label: string;

  outcome: 'success' | 'failure';
  category: ReliabilityCategory;

  /** Present on failure. The exact code the production fetcher threw. */
  fetchErrorCode: FetchErrorCode | null;
  /** HTTP status of the attempt that produced the final result, if known. */
  httpStatus: number | null;
  /** e.g. `http`, `playwright`, or `http+playwright` when escalation happened. */
  strategyChain: string;
  /** Which strategy actually produced/failed the final attempt. */
  finalStrategy: string | null;
  /** Which HTML parser found the price, on success (json-ld, dom, etc.). */
  extractedBy: string | null;
  /** Total attempts the resilient fetcher made, across retries and escalation. */
  attempts: number;
  /** Wall-clock time for the whole `fetchProduct()` call, including retries. */
  durationMs: number;
  /** Short failure message, or null on success. */
  errorMessage: string | null;
  /**
   * Price read on success. Recorded ONLY for this diagnostic's own report -
   * this tool never calls any product/price-history/notification code path,
   * so it is structurally impossible for it to record a price change or
   * touch application data.
   */
  price: number | null;

  /** Per-attempt detail captured from the fetcher's structured logs. */
  attemptLog: AttemptLogEntry[];
}

export interface RunConfig {
  strategy: string;
  timeoutMs: number;
  maxAttempts: number;
  headless: boolean;
  concurrency: number;
  perCheckDelayMs: number;
  intervalMinutes: number;
}

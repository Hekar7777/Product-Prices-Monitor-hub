/**
 * The public contract of the Flipkart extraction layer.
 *
 * Everything outside `src/fetcher/` depends only on this file. No scraping
 * detail (HTML, selectors, browsers) leaks past this boundary, which is what
 * allows the extractor to be swapped or stubbed - the tests use an in-memory
 * fake implementing the same interface.
 */

/** Structured product data handed to the rest of the application. */
export interface FetchedProduct {
  productName: string;
  /** Current selling price. Always a finite number greater than zero. */
  price: number;
  /** Maximum retail price / struck-through price, when the page shows one. */
  mrp: number | null;
  imageUrl: string | null;
  availability: string | null;
  seller: string | null;
  currency: string;
  /** The URL the data was read from (normalised). */
  url: string;
}

/** Diagnostics about how a fetch was performed - logged, never shown as data. */
export interface FetchMeta {
  /** Which concrete fetcher produced the result, e.g. `http` or `playwright`. */
  strategy: string;
  /** Total attempts consumed, including the successful one. */
  attempts: number;
  durationMs: number;
  httpStatus: number | null;
  /** Which parser located the price, e.g. `json-ld`, `initial-state`, `dom`. */
  extractedBy?: string;
}

export interface FetchResult {
  product: FetchedProduct;
  meta: FetchMeta;
}

export interface FetchOptions {
  /** Hard ceiling for a single attempt. */
  timeoutMs?: number;
  /** Attempts for retryable failures. 1 means "no retry". */
  maxRetries?: number;
  /** Allows the scheduler to abandon in-flight work on shutdown. */
  signal?: AbortSignal;
}

/**
 * Reads a Flipkart product page and returns structured data.
 *
 * Implementations must throw a `FetchError` (see `src/errors.ts`) for every
 * failure mode, and must never return a partially-populated product: if the
 * selling price could not be read, that is an error, not a result.
 */
export interface FlipkartProductFetcher {
  readonly name: string;
  fetchProduct(url: string, options?: FetchOptions): Promise<FetchResult>;
  /** Releases any long-lived resources (browser processes, sockets). */
  close?(): Promise<void>;
}

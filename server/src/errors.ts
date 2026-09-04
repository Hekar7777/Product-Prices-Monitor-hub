/**
 * Error taxonomy.
 *
 * Every failure mode that can occur while reading a Flipkart page maps to one
 * of `FetchErrorCode`. The monitoring pipeline never treats any of them as a
 * price change - the last known good price is always retained.
 */
export const FETCH_ERROR_CODES = [
  /** The supplied URL is not a Flipkart product URL. */
  'INVALID_URL',
  /** DNS/socket level failure, connection reset, offline. */
  'NETWORK_ERROR',
  /** The request exceeded the configured timeout. */
  'TIMEOUT',
  /** Non-success HTTP status that is not a 404. */
  'HTTP_ERROR',
  /** 404 / "page not found" - the product was most likely removed. */
  'PRODUCT_REMOVED',
  /** Flipkart served an anti-bot / CAPTCHA interstitial. */
  'CAPTCHA',
  /** The page demands a signed-in session. */
  'LOGIN_REQUIRED',
  /** Page loaded and parsed, but it is out of stock / not purchasable. */
  'PRODUCT_UNAVAILABLE',
  /** Page loaded but no selling price could be located. */
  'PRICE_NOT_FOUND',
  /** Page loaded but its structure no longer matches any known shape. */
  'PARSE_ERROR',
  /** Playwright is not installed, or its browser binary is missing. */
  'BROWSER_UNAVAILABLE',
  /** The browser crashed or the page/context was closed unexpectedly. */
  'BROWSER_ERROR',
  /** Anything not classified above. */
  'UNKNOWN',
] as const;

export type FetchErrorCode = (typeof FETCH_ERROR_CODES)[number];

/**
 * Codes worth retrying: transient infrastructure problems. Codes such as
 * PRODUCT_REMOVED or INVALID_URL will not improve on a retry, and CAPTCHA is
 * deliberately not retried because hammering the page would be an attempt to
 * work around an anti-bot control.
 */
const RETRYABLE: ReadonlySet<FetchErrorCode> = new Set<FetchErrorCode>([
  'NETWORK_ERROR',
  'TIMEOUT',
  'HTTP_ERROR',
  'PRICE_NOT_FOUND',
  'PARSE_ERROR',
  'BROWSER_ERROR',
  'UNKNOWN',
]);

export function isRetryableFetchError(code: FetchErrorCode): boolean {
  return RETRYABLE.has(code);
}

/** Human-readable, user-facing explanation for each failure mode. */
const MESSAGES: Record<FetchErrorCode, string> = {
  INVALID_URL: 'That does not look like a Flipkart product URL.',
  NETWORK_ERROR: 'Could not reach Flipkart (network error).',
  TIMEOUT: 'Flipkart did not respond in time.',
  HTTP_ERROR: 'Flipkart returned an unexpected HTTP response.',
  PRODUCT_REMOVED: 'This product no longer exists on Flipkart.',
  CAPTCHA: 'Flipkart served a bot-verification page, so the price could not be read.',
  LOGIN_REQUIRED: 'Flipkart requires a signed-in session for this page.',
  PRODUCT_UNAVAILABLE: 'The product is currently unavailable, so no selling price is listed.',
  PRICE_NOT_FOUND: 'The page loaded but no selling price could be found.',
  PARSE_ERROR: 'The page structure was not recognised, so the price could not be extracted.',
  BROWSER_UNAVAILABLE:
    'The Playwright browser is not installed. Run `npm run playwright:install` to enable browser-based extraction.',
  BROWSER_ERROR: 'The headless browser failed while loading the page.',
  UNKNOWN: 'An unexpected error occurred while reading the product page.',
};

export function describeFetchError(code: FetchErrorCode): string {
  return MESSAGES[code];
}

export interface FetchErrorOptions {
  url?: string;
  status?: number;
  strategy?: string;
  cause?: unknown;
  details?: Record<string, unknown>;
}

/** A failure while fetching or parsing a product page. */
export class FetchError extends Error {
  readonly code: FetchErrorCode;
  readonly url?: string;
  readonly status?: number;
  readonly strategy?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: FetchErrorCode, message?: string, options: FetchErrorOptions = {}) {
    super(message ?? MESSAGES[code], options.cause ? { cause: options.cause } : undefined);
    this.name = 'FetchError';
    this.code = code;
    if (options.url !== undefined) this.url = options.url;
    if (options.status !== undefined) this.status = options.status;
    if (options.strategy !== undefined) this.strategy = options.strategy;
    if (options.details !== undefined) this.details = options.details;
  }

  get retryable(): boolean {
    return isRetryableFetchError(this.code);
  }

  static from(err: unknown, fallback: FetchErrorCode = 'UNKNOWN', url?: string): FetchError {
    if (err instanceof FetchError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new FetchError(fallback, message, { cause: err, ...(url ? { url } : {}) });
  }
}

/** An error that maps directly onto an HTTP response from our own API. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }

  static notFound(message = 'Resource not found'): AppError {
    return new AppError(404, 'NOT_FOUND', message);
  }

  static conflict(message: string, details?: unknown): AppError {
    return new AppError(409, 'CONFLICT', message, details);
  }

  static unprocessable(message: string, details?: unknown): AppError {
    return new AppError(422, 'UNPROCESSABLE', message, details);
  }

  static internal(message = 'Internal server error'): AppError {
    return new AppError(500, 'INTERNAL_ERROR', message);
  }
}

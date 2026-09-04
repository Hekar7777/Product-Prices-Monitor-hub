import type { FetchErrorCode } from '../../src/errors.js';
import type { ReliabilityCategory } from './types.js';

/**
 * Buckets a fetch outcome into one of the report's categories.
 *
 * `status` takes priority over `code` for 403/429 specifically, because the
 * production taxonomy maps a 403 onto the same `CAPTCHA` code it uses for a
 * content-detected challenge page served with HTTP 200 (see
 * `classifyHttpStatus` in `src/fetcher/httpFetcher.ts` and the `BLOCK_PHRASES`
 * check in `src/fetcher/parse.ts`) - this report keeps "blocked at the HTTP
 * layer" and "served a challenge page" visibly distinct, since they call for
 * different mitigations.
 */
export function classifyOutcome(
  code: FetchErrorCode | null,
  status: number | null,
): ReliabilityCategory {
  if (code === null) return 'SUCCESS';
  if (status === 403) return 'HTTP_403_BLOCKED';
  if (status === 429) return 'HTTP_429_RATE_LIMITED';

  switch (code) {
    case 'CAPTCHA':
      return 'CAPTCHA_CHALLENGE';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'NETWORK_ERROR':
      return 'NETWORK_ERROR';
    case 'PRODUCT_REMOVED':
      return 'PRODUCT_REMOVED';
    case 'PRODUCT_UNAVAILABLE':
      return 'PRODUCT_UNAVAILABLE';
    case 'PRICE_NOT_FOUND':
    case 'PARSE_ERROR':
      return 'PRICE_NOT_FOUND';
    case 'HTTP_ERROR':
    case 'LOGIN_REQUIRED':
      return 'HTTP_OTHER_ERROR';
    case 'BROWSER_UNAVAILABLE':
    case 'BROWSER_ERROR':
      return 'BROWSER_ERROR';
    default:
      return 'OTHER_FAILURE';
  }
}

/** Human-readable label for each category, used in the printed report. */
export const CATEGORY_LABELS: Record<ReliabilityCategory, string> = {
  SUCCESS: 'Successful price extraction',
  HTTP_403_BLOCKED: 'HTTP 403 (blocked)',
  HTTP_429_RATE_LIMITED: 'HTTP 429 (rate limited)',
  HTTP_OTHER_ERROR: 'Other HTTP error (401/5xx/etc.)',
  TIMEOUT: 'Timeout',
  NETWORK_ERROR: 'Network error',
  CAPTCHA_CHALLENGE: 'CAPTCHA / bot-challenge page',
  PRODUCT_REMOVED: 'Product removed / page not found',
  PRODUCT_UNAVAILABLE: 'Product unavailable (out of stock)',
  PRICE_NOT_FOUND: 'Page loaded, price not extracted',
  BROWSER_ERROR: 'Browser unavailable / crashed',
  OTHER_FAILURE: 'Other / unclassified failure',
};

/** Display order for the report - successes first, then roughly by severity. */
export const CATEGORY_ORDER: ReliabilityCategory[] = [
  'SUCCESS',
  'HTTP_403_BLOCKED',
  'HTTP_429_RATE_LIMITED',
  'CAPTCHA_CHALLENGE',
  'TIMEOUT',
  'NETWORK_ERROR',
  'HTTP_OTHER_ERROR',
  'PRICE_NOT_FOUND',
  'PRODUCT_UNAVAILABLE',
  'PRODUCT_REMOVED',
  'BROWSER_ERROR',
  'OTHER_FAILURE',
];

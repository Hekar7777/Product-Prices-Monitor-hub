import { env, type FetchStrategy } from '../config/env.js';
import { logger } from '../logger.js';
import { HttpFlipkartFetcher } from './httpFetcher.js';
import { PlaywrightFlipkartFetcher } from './playwrightFetcher.js';
import { ResilientFlipkartFetcher } from './resilientFetcher.js';
import type { FlipkartProductFetcher } from './types.js';

export type {
  FetchedProduct,
  FetchMeta,
  FetchOptions,
  FetchResult,
  FlipkartProductFetcher,
} from './types.js';
export { HttpFlipkartFetcher } from './httpFetcher.js';
export { PlaywrightFlipkartFetcher } from './playwrightFetcher.js';
export { ResilientFlipkartFetcher } from './resilientFetcher.js';
export { parseFlipkartHtml, parsePriceText } from './parse.js';
export { parseFlipkartUrl, isFlipkartProductUrl, absoluteImageUrl } from './url.js';
export type { FlipkartUrlInfo } from './url.js';

export interface CreateFetcherOptions {
  strategy?: FetchStrategy;
  timeoutMs?: number;
  maxAttempts?: number;
  headless?: boolean;
}

/**
 * Builds the fetcher the application uses.
 *
 * - `http`       - HTTP only. Fastest, no browser needed.
 * - `playwright` - browser only. Slowest, highest fidelity.
 * - `auto`       - HTTP first, escalating to a browser when the price is not in
 *                  the server-rendered HTML. This is the default.
 */
export function createFlipkartFetcher(
  options: CreateFetcherOptions = {},
): FlipkartProductFetcher {
  const strategy = options.strategy ?? env.fetchStrategy;
  const timeoutMs = options.timeoutMs ?? env.defaults.requestTimeoutMs;
  const maxAttempts = options.maxAttempts ?? env.defaults.fetchMaxRetries;
  const headless = options.headless ?? env.playwrightHeadless;

  const http = () => new HttpFlipkartFetcher({ defaultTimeoutMs: timeoutMs });
  const browser = () =>
    new PlaywrightFlipkartFetcher({ headless, defaultTimeoutMs: timeoutMs });

  const fetchers: FlipkartProductFetcher[] =
    strategy === 'http' ? [http()] : strategy === 'playwright' ? [browser()] : [http(), browser()];

  logger.info('Flipkart fetcher configured', {
    component: 'fetcher',
    strategy,
    chain: fetchers.map((f) => f.name).join(' -> '),
    timeoutMs,
    maxAttempts,
  });

  return new ResilientFlipkartFetcher({
    fetchers,
    maxAttempts,
    defaultTimeoutMs: timeoutMs,
  });
}

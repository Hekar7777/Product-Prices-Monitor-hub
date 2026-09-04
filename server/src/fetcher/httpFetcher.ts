import { FetchError, type FetchErrorCode } from '../errors.js';
import { logger, serialiseError } from '../logger.js';
import { parseFlipkartHtml } from './parse.js';
import { parseFlipkartUrl } from './url.js';
import type { FetchOptions, FetchResult, FlipkartProductFetcher } from './types.js';

/**
 * Plain-HTTP Flipkart fetcher.
 *
 * Fast and cheap, and sufficient whenever Flipkart server-renders the price
 * into the HTML. When the page needs JavaScript to show a price, this fetcher
 * reports PRICE_NOT_FOUND and the composite fetcher escalates to Playwright.
 *
 * This fetcher sends ordinary browser headers so Flipkart returns its normal
 * HTML document. It performs no anti-bot evasion: if Flipkart responds with a
 * verification page or a 403, that is surfaced as an error and the check fails.
 */

/** Minimal `fetch` shape, so tests can inject a stub. */
export type FetchImpl = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'follow' },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Upgrade-Insecure-Requests': '1',
};

/** Maps an HTTP status onto our error taxonomy. */
export function classifyHttpStatus(status: number): FetchErrorCode | null {
  if (status >= 200 && status < 300) return null;
  if (status === 404 || status === 410) return 'PRODUCT_REMOVED';
  if (status === 401) return 'LOGIN_REQUIRED';
  // A hard 403 from Flipkart means the request was refused by a protection
  // layer. We report it rather than trying to get around it.
  if (status === 403) return 'CAPTCHA';
  return 'HTTP_ERROR';
}

/** Maps a thrown `fetch` rejection onto our error taxonomy. */
function classifyThrown(err: unknown, timedOut: boolean): FetchErrorCode {
  if (timedOut) return 'TIMEOUT';
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'TIMEOUT';
    const cause = (err as { cause?: { code?: string } }).cause;
    const code = cause?.code ?? '';
    if (
      ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH'].includes(code)
    ) {
      return 'NETWORK_ERROR';
    }
    if (err.name === 'TypeError') return 'NETWORK_ERROR';
  }
  return 'UNKNOWN';
}

export interface HttpFetcherDeps {
  fetchImpl?: FetchImpl;
  defaultTimeoutMs?: number;
}

export class HttpFlipkartFetcher implements FlipkartProductFetcher {
  readonly name = 'http';

  private readonly fetchImpl: FetchImpl;
  private readonly defaultTimeoutMs: number;
  private readonly log = logger.child({ component: 'fetcher.http' });

  constructor(deps: HttpFetcherDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
    this.defaultTimeoutMs = deps.defaultTimeoutMs ?? 30_000;
  }

  async fetchProduct(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    const { normalisedUrl } = parseFlipkartUrl(url);
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const startedAt = Date.now();

    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    // Propagate an external abort (scheduler shutdown) into this request.
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    let status: number | null = null;

    try {
      const response = await this.fetchImpl(normalisedUrl, {
        headers: DEFAULT_HEADERS,
        signal: controller.signal,
        redirect: 'follow',
      });

      status = response.status;

      const statusError = classifyHttpStatus(response.status);
      if (statusError) {
        throw new FetchError(statusError, `Flipkart responded with HTTP ${response.status}.`, {
          url: normalisedUrl,
          status: response.status,
          strategy: this.name,
        });
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType && !/html|text|json/i.test(contentType)) {
        throw new FetchError(
          'PARSE_ERROR',
          `Expected an HTML document but received "${contentType}".`,
          { url: normalisedUrl, status: response.status, strategy: this.name },
        );
      }

      const html = await response.text();
      const { product, extractedBy } = parseFlipkartHtml({
        html,
        url: normalisedUrl,
        httpStatus: response.status,
        strategy: this.name,
      });

      const durationMs = Date.now() - startedAt;
      this.log.debug('Fetched product over HTTP', {
        url: normalisedUrl,
        status: response.status,
        extractedBy,
        durationMs,
      });

      return {
        product,
        meta: {
          strategy: this.name,
          attempts: 1,
          durationMs,
          httpStatus: response.status,
          extractedBy,
        },
      };
    } catch (err) {
      if (err instanceof FetchError) throw err;

      const code = classifyThrown(err, timedOut);
      const message =
        code === 'TIMEOUT'
          ? `Flipkart did not respond within ${timeoutMs}ms.`
          : err instanceof Error
            ? err.message
            : String(err);

      this.log.debug('HTTP fetch failed', {
        url: normalisedUrl,
        code,
        ...serialiseError(err),
      });

      throw new FetchError(code, message, {
        url: normalisedUrl,
        strategy: this.name,
        cause: err,
        ...(status !== null ? { status } : {}),
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

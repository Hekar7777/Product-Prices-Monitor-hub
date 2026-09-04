import { FetchError } from '../errors.js';
import { logger, serialiseError } from '../logger.js';
import { parseFlipkartHtml } from './parse.js';
import { parseFlipkartUrl } from './url.js';
import type { FetchOptions, FetchResult, FlipkartProductFetcher } from './types.js';

/**
 * Browser-based Flipkart fetcher.
 *
 * Flipkart renders parts of a product page client-side, so a real browser is
 * sometimes the only way to see the selling price. One Chromium instance is
 * shared across checks; each check gets its own isolated browser context.
 *
 * Like the HTTP fetcher, this performs no anti-bot evasion. It loads the public
 * page the way a browser would, and a verification page is reported as a
 * failure rather than worked around.
 */

// Minimal structural types for the bits of Playwright we use. Declaring them
// locally keeps this module importable even when Playwright is absent.
interface PwRequest {
  resourceType(): string;
}
interface PwRoute {
  request(): PwRequest;
  abort(): Promise<void>;
  continue(): Promise<void>;
}
interface PwResponse {
  status(): number;
}
interface PwPage {
  setDefaultTimeout(timeout: number): void;
  route(pattern: string, handler: (route: PwRoute) => void | Promise<void>): Promise<void>;
  goto(
    url: string,
    options?: { waitUntil?: string; timeout?: number },
  ): Promise<PwResponse | null>;
  waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(options?: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
  isConnected(): boolean;
  on(event: string, handler: () => void): void;
}
interface PwChromium {
  launch(options?: Record<string, unknown>): Promise<PwBrowser>;
}

/** Selectors that indicate the price block has rendered. */
const PRICE_READY_SELECTORS = ['div.Nx9bqj', 'div[class*="_30jeq3"]', 'span.VU-ZEz', 'h1'];

/** Resource types we never need in order to read a price. */
const BLOCKED_RESOURCES = new Set(['image', 'media', 'font', 'stylesheet']);

export interface PlaywrightFetcherOptions {
  headless?: boolean;
  defaultTimeoutMs?: number;
  /** Injectable loader so tests can supply a fake Playwright. */
  loadPlaywright?: () => Promise<{ chromium: PwChromium }>;
}

export class PlaywrightFlipkartFetcher implements FlipkartProductFetcher {
  readonly name = 'playwright';

  private browser: PwBrowser | null = null;
  private launching: Promise<PwBrowser> | null = null;
  private readonly headless: boolean;
  private readonly defaultTimeoutMs: number;
  private readonly loadPlaywright: () => Promise<{ chromium: PwChromium }>;
  private readonly log = logger.child({ component: 'fetcher.playwright' });

  constructor(options: PlaywrightFetcherOptions = {}) {
    this.headless = options.headless ?? true;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.loadPlaywright =
      options.loadPlaywright ??
      (() => import('playwright') as unknown as Promise<{ chromium: PwChromium }>);
  }

  /** Launches Chromium on first use; subsequent calls reuse the instance. */
  private async getBrowser(): Promise<PwBrowser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;

    this.launching = (async () => {
      let chromium: PwChromium;
      try {
        ({ chromium } = await this.loadPlaywright());
      } catch (err) {
        throw new FetchError(
          'BROWSER_UNAVAILABLE',
          'Playwright is not installed. Run `npm install` and `npm run playwright:install`.',
          { strategy: this.name, cause: err },
        );
      }

      try {
        const browser = await chromium.launch({
          headless: this.headless,
          args: ['--disable-dev-shm-usage', '--no-sandbox'],
        });
        browser.on('disconnected', () => {
          this.browser = null;
          this.log.warn('Chromium disconnected; it will be relaunched on the next check');
        });
        this.browser = browser;
        this.log.info('Launched Chromium for product extraction', { headless: this.headless });
        return browser;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Playwright says "Executable doesn't exist" when browsers are missing.
        const missingBinary =
          /executable doesn'?t exist|please run the following command|browserType\.launch/i.test(
            message,
          );
        throw new FetchError(
          missingBinary ? 'BROWSER_UNAVAILABLE' : 'BROWSER_ERROR',
          missingBinary
            ? 'The Chromium binary is missing. Run `npm run playwright:install`.'
            : `Failed to launch Chromium: ${message}`,
          { strategy: this.name, cause: err },
        );
      } finally {
        this.launching = null;
      }
    })();

    return this.launching;
  }

  async fetchProduct(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    const { normalisedUrl } = parseFlipkartUrl(url);
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const startedAt = Date.now();

    const browser = await this.getBrowser();

    let context: PwContext | null = null;
    let page: PwPage | null = null;
    let httpStatus: number | null = null;

    try {
      context = await browser.newContext({
        locale: 'en-IN',
        viewport: { width: 1366, height: 900 },
        javaScriptEnabled: true,
      });
      page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);

      // Skip assets that cost bandwidth but carry no price information.
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        void (BLOCKED_RESOURCES.has(type) ? route.abort() : route.continue());
      });

      if (options.signal?.aborted) {
        throw new FetchError('TIMEOUT', 'Check aborted before the page was loaded.', {
          url: normalisedUrl,
          strategy: this.name,
        });
      }

      const response = await page.goto(normalisedUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
      httpStatus = response?.status() ?? null;

      if (httpStatus !== null) {
        if (httpStatus === 404 || httpStatus === 410) {
          throw new FetchError('PRODUCT_REMOVED', `Flipkart responded with HTTP ${httpStatus}.`, {
            url: normalisedUrl,
            status: httpStatus,
            strategy: this.name,
          });
        }
        if (httpStatus === 403) {
          throw new FetchError('CAPTCHA', 'Flipkart refused the request (HTTP 403).', {
            url: normalisedUrl,
            status: httpStatus,
            strategy: this.name,
          });
        }
        if (httpStatus >= 400) {
          throw new FetchError('HTTP_ERROR', `Flipkart responded with HTTP ${httpStatus}.`, {
            url: normalisedUrl,
            status: httpStatus,
            strategy: this.name,
          });
        }
      }

      // Give the price block a chance to hydrate. Not finding it is not fatal -
      // the parsers still get a shot at whatever did render.
      await this.waitForPriceBlock(page, timeoutMs);

      const html = await page.content();
      const { product, extractedBy } = parseFlipkartHtml({
        html,
        url: normalisedUrl,
        httpStatus,
        strategy: this.name,
      });

      const durationMs = Date.now() - startedAt;
      this.log.debug('Fetched product with Chromium', {
        url: normalisedUrl,
        httpStatus,
        extractedBy,
        durationMs,
      });

      return {
        product,
        meta: { strategy: this.name, attempts: 1, durationMs, httpStatus, extractedBy },
      };
    } catch (err) {
      if (err instanceof FetchError) throw err;

      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout|timed out/i.test(message);
      const isClosed = /target closed|browser has been closed|page has been closed|crashed/i.test(
        message,
      );

      this.log.debug('Chromium fetch failed', {
        url: normalisedUrl,
        ...serialiseError(err),
      });

      throw new FetchError(
        isTimeout ? 'TIMEOUT' : isClosed ? 'BROWSER_ERROR' : 'UNKNOWN',
        message,
        {
          url: normalisedUrl,
          strategy: this.name,
          cause: err,
          ...(httpStatus !== null ? { status: httpStatus } : {}),
        },
      );
    } finally {
      // Always tear the context down; a leaked context leaks a renderer process.
      await safeClose(() => page?.close());
      await safeClose(() => context?.close());
    }
  }

  private async waitForPriceBlock(page: PwPage, timeoutMs: number): Promise<void> {
    const budget = Math.max(1_000, Math.min(8_000, Math.floor(timeoutMs / 3)));
    for (const selector of PRICE_READY_SELECTORS) {
      try {
        await page.waitForSelector(selector, { timeout: budget, state: 'attached' });
        return;
      } catch {
        // Try the next known price container.
      }
    }
    this.log.debug('No known price container appeared; parsing whatever rendered');
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (!browser) return;
    await safeClose(() => browser.close());
    this.log.info('Closed Chromium');
  }
}

async function safeClose(fn: () => Promise<void> | undefined): Promise<void> {
  try {
    await fn();
  } catch {
    // Closing is best-effort; a failure here must not mask a real error.
  }
}

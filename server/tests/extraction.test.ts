import { describe, expect, it } from 'vitest';
import { FetchError, type FetchErrorCode } from '../src/errors.js';
import { parseFlipkartHtml, parsePriceText } from '../src/fetcher/parse.js';
import { HttpFlipkartFetcher, type FetchImpl } from '../src/fetcher/httpFetcher.js';
import { ResilientFlipkartFetcher } from '../src/fetcher/resilientFetcher.js';
import type { FetchResult, FlipkartProductFetcher } from '../src/fetcher/types.js';
import {
  captchaPage,
  domPage,
  garbagePage,
  initialStatePage,
  jsonLdPage,
  legacyDomPage,
  noPricePage,
  removedPage,
  soldOutPage,
} from './helpers/htmlFixtures.js';

const URL = 'https://www.flipkart.com/thing/p/itmabc123?pid=PID123';

function parse(html: string) {
  return parseFlipkartHtml({ html, url: URL, strategy: 'test' });
}

function expectFetchError(fn: () => unknown, code: FetchErrorCode): void {
  try {
    fn();
    throw new Error(`Expected a FetchError with code ${code}, but nothing was thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).code).toBe(code);
  }
}

describe('parsePriceText', () => {
  it('parses rupee amounts in the formats Flipkart uses', () => {
    expect(parsePriceText('₹69,999')).toBe(69999);
    expect(parsePriceText('₹1,29,900')).toBe(129900);
    expect(parsePriceText('₹999.50')).toBe(999.5);
    expect(parsePriceText('Rs. 52490')).toBe(52490);
    expect(parsePriceText('INR 4999')).toBe(4999);
    expect(parsePriceText('&#8377;7,499')).toBe(7499);
    expect(parsePriceText('69999')).toBe(69999);
    expect(parsePriceText(69999)).toBe(69999);
  });

  it('returns null when there is no usable amount', () => {
    for (const value of ['', 'Sold Out', 'Free', '—', null, undefined, {}, '₹0']) {
      expect(parsePriceText(value)).toBeNull();
    }
  });

  it('takes the first amount when several are present', () => {
    expect(parsePriceText('₹52,490 ₹79,900')).toBe(52490);
  });
});

describe('parseFlipkartHtml - successful extraction', () => {
  it('reads a schema.org JSON-LD product block', () => {
    const { product, extractedBy } = parse(jsonLdPage());

    expect(extractedBy).toBe('json-ld');
    expect(product.productName).toBe('Apple iPhone 16 (Black, 128 GB)');
    expect(product.price).toBe(69999);
    expect(product.mrp).toBe(79900);
    expect(product.availability).toBe('In Stock');
    expect(product.seller).toBe('SuperComNet');
    expect(product.currency).toBe('INR');
    expect(product.imageUrl).toContain('flixcart.com');
    expect(product.url).toBe(URL);
  });

  it('reads current Flipkart class-based markup', () => {
    const { product, extractedBy } = parse(domPage());

    expect(extractedBy).toBe('dom');
    expect(product.productName).toBe('Sony Bravia 139 cm (55 inch) 4K Ultra HD LED Smart TV');
    expect(product.price).toBe(52490);
    expect(product.mrp).toBe(79900);
    expect(product.seller).toBe('Sony Exclusive');
    // The {@width} template must be expanded into a usable URL.
    expect(product.imageUrl).toBe('https://rukminim2.flixcart.com/image/400/400/tv.jpeg');
  });

  it('reads the previous markup generation', () => {
    const { product } = parse(legacyDomPage());

    expect(product.productName).toBe('MacBook Air M2 (Midnight, 256 GB)');
    expect(product.price).toBe(129900);
    expect(product.mrp).toBe(149900);
  });

  it('reads a price that only exists in the hydration state', () => {
    const { product, extractedBy } = parse(initialStatePage(34999));

    expect(extractedBy).toBe('initial-state');
    expect(product.price).toBe(34999);
    expect(product.productName).toBe('OnePlus Nord CE4 (Dark Chrome, 256 GB)');
    expect(product.mrp).toBe(39999);
  });

  it('never invents data - the price always comes from the document', () => {
    expect(parse(domPage({ price: '₹11,111' })).product.price).toBe(11111);
    expect(parse(jsonLdPage({ price: 8888 })).product.price).toBe(8888);
  });

  it('ignores an MRP that is below the selling price', () => {
    const { product } = parse(domPage({ price: '₹52,490', mrp: '₹40,000' }));
    expect(product.price).toBe(52490);
    expect(product.mrp).toBeNull();
  });
});

describe('parseFlipkartHtml - failure classification', () => {
  it('reports a bot-verification page as CAPTCHA, not a missing price', () => {
    expectFetchError(() => parse(captchaPage()), 'CAPTCHA');
  });

  it('reports a removed product', () => {
    expectFetchError(() => parse(removedPage()), 'PRODUCT_REMOVED');
  });

  it('reports an out-of-stock product with no price', () => {
    expectFetchError(() => parse(soldOutPage()), 'PRODUCT_UNAVAILABLE');
  });

  it('reports a product page that rendered no price', () => {
    expectFetchError(() => parse(noPricePage()), 'PRICE_NOT_FOUND');
  });

  it('reports an unrecognisable document', () => {
    expectFetchError(() => parse(garbagePage()), 'PARSE_ERROR');
  });

  it('reports an empty document', () => {
    expectFetchError(() => parse(''), 'PARSE_ERROR');
  });
});

// ---------------------------------------------------------------------------
// HTTP fetcher, with `fetch` replaced by a stub
// ---------------------------------------------------------------------------

function stubFetch(
  status: number,
  body: string,
  contentType = 'text/html; charset=utf-8',
): FetchImpl {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  });
}

describe('HttpFlipkartFetcher', () => {
  it('returns structured data for a healthy response', async () => {
    const fetcher = new HttpFlipkartFetcher({ fetchImpl: stubFetch(200, jsonLdPage()) });
    const result = await fetcher.fetchProduct(URL);

    expect(result.product.price).toBe(69999);
    expect(result.meta.strategy).toBe('http');
    expect(result.meta.httpStatus).toBe(200);
  });

  it('maps HTTP statuses onto the error taxonomy', async () => {
    const cases: Array<[number, FetchErrorCode]> = [
      [404, 'PRODUCT_REMOVED'],
      [410, 'PRODUCT_REMOVED'],
      [401, 'LOGIN_REQUIRED'],
      [403, 'CAPTCHA'],
      [429, 'HTTP_ERROR'],
      [500, 'HTTP_ERROR'],
      [503, 'HTTP_ERROR'],
    ];

    for (const [status, expected] of cases) {
      const fetcher = new HttpFlipkartFetcher({ fetchImpl: stubFetch(status, 'nope') });
      await expect(fetcher.fetchProduct(URL)).rejects.toMatchObject({ code: expected });
    }
  });

  it('rejects a non-HTML response', async () => {
    const fetcher = new HttpFlipkartFetcher({
      fetchImpl: stubFetch(200, 'PNG…', 'image/png'),
    });
    await expect(fetcher.fetchProduct(URL)).rejects.toMatchObject({ code: 'PARSE_ERROR' });
  });

  it('classifies a socket failure as a network error', async () => {
    const fetchImpl: FetchImpl = async () => {
      const err = new TypeError('fetch failed');
      (err as unknown as { cause: { code: string } }).cause = { code: 'ECONNRESET' };
      throw err;
    };
    const fetcher = new HttpFlipkartFetcher({ fetchImpl });
    await expect(fetcher.fetchProduct(URL)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('classifies an aborted request as a timeout', async () => {
    const fetchImpl: FetchImpl = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };
    const fetcher = new HttpFlipkartFetcher({ fetchImpl });
    await expect(fetcher.fetchProduct(URL)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('validates the URL before making a request', async () => {
    let called = false;
    const fetchImpl: FetchImpl = async () => {
      called = true;
      throw new Error('should not be reached');
    };
    const fetcher = new HttpFlipkartFetcher({ fetchImpl });

    await expect(fetcher.fetchProduct('https://www.amazon.in/dp/x')).rejects.toMatchObject({
      code: 'INVALID_URL',
    });
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Retry / escalation wrapper
// ---------------------------------------------------------------------------

/** A scripted failure: a code, and optionally an HTTP status (for status-403 etc.). */
type ScriptedStep = FetchErrorCode | number | { code: FetchErrorCode; status?: number };

class ScriptedFetcher implements FlipkartProductFetcher {
  calls = 0;
  constructor(
    readonly name: string,
    private readonly script: Array<ScriptedStep>,
  ) {}

  async fetchProduct(url: string): Promise<FetchResult> {
    // Once the script runs out, the last step repeats.
    const step = this.script[Math.min(this.calls, this.script.length - 1)] ?? 'UNKNOWN';
    this.calls += 1;

    if (typeof step === 'number') {
      return {
        product: {
          productName: 'Scripted',
          price: step,
          mrp: null,
          imageUrl: null,
          availability: 'In Stock',
          seller: null,
          currency: 'INR',
          url,
        },
        meta: { strategy: this.name, attempts: 1, durationMs: 1, httpStatus: 200 },
      };
    }

    if (typeof step === 'object') {
      throw new FetchError(step.code, `scripted ${step.code}`, {
        strategy: this.name,
        ...(step.status === undefined ? {} : { status: step.status }),
      });
    }

    throw new FetchError(step, `scripted ${step}`, { strategy: this.name });
  }
}

function resilient(fetchers: FlipkartProductFetcher[], maxAttempts = 3) {
  return new ResilientFlipkartFetcher({
    fetchers,
    maxAttempts,
    backoffBaseMs: 0, // keep the suite fast
  });
}

describe('ResilientFlipkartFetcher', () => {
  it('retries a transient failure and reports the total attempts', async () => {
    const inner = new ScriptedFetcher('http', ['TIMEOUT', 'NETWORK_ERROR', 42000]);
    const result = await resilient([inner]).fetchProduct(URL);

    expect(result.product.price).toBe(42000);
    expect(inner.calls).toBe(3);
    expect(result.meta.attempts).toBe(3);
  });

  it('gives up after the attempt budget is exhausted', async () => {
    const inner = new ScriptedFetcher('http', ['TIMEOUT']);
    await expect(resilient([inner], 2).fetchProduct(URL)).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    expect(inner.calls).toBe(2);
  });

  it('does not retry a CAPTCHA - hammering a bot check is not attempted', async () => {
    const inner = new ScriptedFetcher('http', ['CAPTCHA']);
    await expect(resilient([inner]).fetchProduct(URL)).rejects.toMatchObject({ code: 'CAPTCHA' });
    expect(inner.calls).toBe(1);
  });

  it('does not escalate a CAPTCHA to the browser strategy either', async () => {
    const http = new ScriptedFetcher('http', ['CAPTCHA']);
    const browser = new ScriptedFetcher('playwright', [50000]);

    await expect(resilient([http, browser]).fetchProduct(URL)).rejects.toMatchObject({
      code: 'CAPTCHA',
    });
    expect(browser.calls).toBe(0);
  });

  it('escalates a TIMEOUT to the browser without retrying HTTP again', async () => {
    // A TIMEOUT already consumed the full per-attempt timeout, so when a
    // heavier strategy exists the remaining attempts are not wasted on the
    // same stack - the check moves straight to the browser.
    const http = new ScriptedFetcher('http', ['TIMEOUT']);
    const browser = new ScriptedFetcher('playwright', [64900]);

    const result = await resilient([http, browser]).fetchProduct(URL);

    expect(result.product.price).toBe(64900);
    expect(result.meta.strategy).toBe('playwright');
    expect(http.calls).toBe(1);
    expect(browser.calls).toBe(1);
    expect(result.meta.attempts).toBe(2);
  });

  it('escalates a hard HTTP 403 (status-level refusal) to the browser', async () => {
    // A 403 from classifyHttpStatus means the request was refused at the edge
    // before any body was read - a browser with a different stack may get
    // through, so it escalates exactly like a NETWORK_ERROR.
    const http = new ScriptedFetcher('http', [{ code: 'CAPTCHA', status: 403 }]);
    const browser = new ScriptedFetcher('playwright', [55990]);

    const result = await resilient([http, browser]).fetchProduct(URL);

    expect(result.product.price).toBe(55990);
    expect(result.meta.strategy).toBe('playwright');
    expect(http.calls).toBe(1);
    expect(browser.calls).toBe(1);
  });

  it('keeps a content-served CAPTCHA terminal even when it carries a 200', async () => {
    // A challenge page that was actually served (parser-detected) must never
    // be escalated to the browser, regardless of the response status it came
    // with.
    const http = new ScriptedFetcher('http', [{ code: 'CAPTCHA', status: 200 }]);
    const browser = new ScriptedFetcher('playwright', [50000]);

    await expect(resilient([http, browser]).fetchProduct(URL)).rejects.toMatchObject({
      code: 'CAPTCHA',
    });
    expect(browser.calls).toBe(0);
  });

  it('does not retry a removed product', async () => {
    const inner = new ScriptedFetcher('http', ['PRODUCT_REMOVED']);
    await expect(resilient([inner]).fetchProduct(URL)).rejects.toMatchObject({
      code: 'PRODUCT_REMOVED',
    });
    expect(inner.calls).toBe(1);
  });

  it('escalates to the browser when the price is not in the server-rendered HTML', async () => {
    const http = new ScriptedFetcher('http', ['PRICE_NOT_FOUND']);
    const browser = new ScriptedFetcher('playwright', [64900]);

    const result = await resilient([http, browser], 1).fetchProduct(URL);

    expect(result.product.price).toBe(64900);
    expect(result.meta.strategy).toBe('playwright');
    expect(http.calls).toBe(1);
    expect(browser.calls).toBe(1);
  });

  it('surfaces the last error when every strategy fails', async () => {
    const http = new ScriptedFetcher('http', ['PARSE_ERROR']);
    const browser = new ScriptedFetcher('playwright', ['BROWSER_UNAVAILABLE']);

    await expect(resilient([http, browser], 1).fetchProduct(URL)).rejects.toMatchObject({
      code: 'BROWSER_UNAVAILABLE',
    });
  });

  it('rejects an invalid URL without calling any fetcher', async () => {
    const inner = new ScriptedFetcher('http', [1000]);
    await expect(resilient([inner]).fetchProduct('https://example.com/x')).rejects.toMatchObject({
      code: 'INVALID_URL',
    });
    expect(inner.calls).toBe(0);
  });
});

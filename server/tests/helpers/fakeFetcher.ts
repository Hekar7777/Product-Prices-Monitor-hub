import { FetchError, type FetchErrorCode } from '../../src/errors.js';
import type {
  FetchOptions,
  FetchResult,
  FetchedProduct,
  FlipkartProductFetcher,
} from '../../src/fetcher/types.js';

/**
 * Deterministic stand-in for the real Flipkart extractor.
 *
 * Tests never touch flipkart.com. This implements the same
 * `FlipkartProductFetcher` interface the production fetchers do, which is the
 * whole point of keeping scraping behind that boundary.
 */
export class FakeFlipkartFetcher implements FlipkartProductFetcher {
  readonly name = 'fake';

  /** Price the next successful fetch will report. */
  price = 69999;
  productName = 'iPhone 16';
  mrp: number | null = 79900;
  imageUrl: string | null = 'https://rukminim2.flixcart.com/image/400/400/iphone.jpeg';
  availability: string | null = 'In Stock';
  seller: string | null = 'SuperComNet';
  currency = 'INR';

  /** When set, every fetch throws this error. */
  failure: FetchError | null = null;
  /** When set, only the next fetch fails. */
  private failureOnce: FetchError | null = null;

  /** Every URL that was requested, in order. */
  readonly calls: string[] = [];
  /** Number of concurrent in-flight fetches, and the peak observed. */
  concurrent = 0;
  peakConcurrent = 0;

  /**
   * Artificial latency. Without it the fake resolves synchronously, so fetches
   * can never actually overlap and concurrency cannot be observed.
   */
  delayMs = 0;

  /** Optional gate so a test can hold a fetch open and observe overlap. */
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;

  closed = false;

  setPrice(price: number): void {
    this.price = price;
  }

  /** Makes every subsequent fetch fail with the given code. */
  failAlways(code: FetchErrorCode, message = `simulated ${code}`): void {
    this.failure = new FetchError(code, message, { strategy: this.name });
  }

  /** Makes only the next fetch fail. */
  failOnce(code: FetchErrorCode, message = `simulated ${code}`): void {
    this.failureOnce = new FetchError(code, message, { strategy: this.name });
  }

  succeedAgain(): void {
    this.failure = null;
    this.failureOnce = null;
  }

  /**
   * Blocks all fetches until `release()` is called. Used to test that a second
   * check for the same product is refused while the first is still running.
   */
  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.openGate = resolve;
    });
  }

  release(): void {
    this.openGate?.();
    this.gate = null;
    this.openGate = null;
  }

  async fetchProduct(url: string, _options: FetchOptions = {}): Promise<FetchResult> {
    this.calls.push(url);
    this.concurrent += 1;
    this.peakConcurrent = Math.max(this.peakConcurrent, this.concurrent);

    try {
      if (this.gate) await this.gate;
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }

      const once = this.failureOnce;
      if (once) {
        this.failureOnce = null;
        throw once;
      }
      if (this.failure) throw this.failure;

      const product: FetchedProduct = {
        productName: this.productName,
        price: this.price,
        mrp: this.mrp,
        imageUrl: this.imageUrl,
        availability: this.availability,
        seller: this.seller,
        currency: this.currency,
        url,
      };

      return {
        product,
        meta: { strategy: this.name, attempts: 1, durationMs: 1, httpStatus: 200 },
      };
    } finally {
      this.concurrent -= 1;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A canonical Flipkart product URL used across the tests. */
export const TEST_URL =
  'https://www.flipkart.com/apple-iphone-16-black-128-gb/p/itm6ac6a86b6e1d2?pid=MOBH4DQF8KZ4YWNQ';

/** A second, distinct product URL. */
export const TEST_URL_2 =
  'https://www.flipkart.com/sony-bravia-139-cm-55-inch/p/itm9f8a1b2c3d4e5?pid=TVSGXYZ123ABC456';

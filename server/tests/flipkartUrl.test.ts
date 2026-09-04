import { describe, expect, it } from 'vitest';
import { FetchError } from '../src/errors.js';
import { absoluteImageUrl, isFlipkartProductUrl, parseFlipkartUrl } from '../src/fetcher/url.js';

describe('parseFlipkartUrl - valid input', () => {
  it('accepts a canonical product URL and extracts its identifiers', () => {
    const info = parseFlipkartUrl(
      'https://www.flipkart.com/apple-iphone-16-black-128-gb/p/itm6ac6a86b6e1d2?pid=MOBH4DQF8KZ4YWNQ&lid=LSTMOB123&marketplace=FLIPKART&srno=b_1_1',
    );

    expect(info.itemId).toBe('itm6ac6a86b6e1d2');
    expect(info.pid).toBe('MOBH4DQF8KZ4YWNQ');
    expect(info.lid).toBe('LSTMOB123');
    expect(info.canonicalKey).toBe('pid:MOBH4DQF8KZ4YWNQ');
  });

  it('strips tracking parameters but keeps pid and lid', () => {
    const info = parseFlipkartUrl(
      'https://www.flipkart.com/thing/p/itmabc123?pid=PIDXYZ&lid=LID1&otracker=search&ppt=None&iid=abc',
    );

    expect(info.normalisedUrl).toBe('https://www.flipkart.com/thing/p/itmabc123?pid=PIDXYZ&lid=LID1');
  });

  it('normalises the host and scheme', () => {
    for (const input of [
      'http://flipkart.com/thing/p/itmabc123',
      'https://m.flipkart.com/thing/p/itmabc123',
      'flipkart.com/thing/p/itmabc123',
      'https://www.flipkart.com/thing/p/itmabc123',
    ]) {
      expect(parseFlipkartUrl(input).normalisedUrl).toBe(
        'https://www.flipkart.com/thing/p/itmabc123',
      );
    }
  });

  it('falls back to the item id when there is no pid', () => {
    expect(parseFlipkartUrl('https://www.flipkart.com/thing/p/itmABC123').canonicalKey).toBe(
      'itm:itmabc123',
    );
  });

  it('treats two variants of the same item as different products', () => {
    const black = parseFlipkartUrl('https://www.flipkart.com/x/p/itmsame?pid=VARIANTBLACK');
    const white = parseFlipkartUrl('https://www.flipkart.com/x/p/itmsame?pid=VARIANTWHITE');

    // Different variants genuinely have different prices, so they must not
    // collapse into one monitored product.
    expect(black.canonicalKey).not.toBe(white.canonicalKey);
  });
});

describe('parseFlipkartUrl - invalid input', () => {
  const invalid: Array<[string, string]> = [
    ['empty string', ''],
    ['whitespace', '   '],
    ['not a URL', 'not a url at all'],
    ['wrong domain', 'https://www.amazon.in/dp/B0CHX1W1XY'],
    ['lookalike domain', 'https://flipkart.com.evil.example/thing/p/itmabc123'],
    ['flipkart home page', 'https://www.flipkart.com/'],
    ['search results', 'https://www.flipkart.com/search?q=iphone'],
    ['category listing', 'https://www.flipkart.com/mobiles/pr?sid=tyy,4io'],
    ['non-http scheme', 'ftp://www.flipkart.com/thing/p/itmabc123'],
  ];

  for (const [label, input] of invalid) {
    it(`rejects ${label}`, () => {
      expect(() => parseFlipkartUrl(input)).toThrow(FetchError);
      try {
        parseFlipkartUrl(input);
      } catch (err) {
        expect((err as FetchError).code).toBe('INVALID_URL');
      }
      expect(isFlipkartProductUrl(input)).toBe(false);
    });
  }
});

describe('absoluteImageUrl', () => {
  it('expands Flipkart size templates', () => {
    expect(absoluteImageUrl('https://rukminim2.flixcart.com/image/{@width}/{@height}/x.jpeg')).toBe(
      'https://rukminim2.flixcart.com/image/400/400/x.jpeg',
    );
  });

  it('resolves protocol-relative and root-relative URLs', () => {
    expect(absoluteImageUrl('//rukminim2.flixcart.com/a.jpg')).toBe(
      'https://rukminim2.flixcart.com/a.jpg',
    );
    expect(absoluteImageUrl('/images/a.jpg')).toBe('https://www.flipkart.com/images/a.jpg');
  });

  it('returns null for unusable values', () => {
    expect(absoluteImageUrl(null)).toBeNull();
    expect(absoluteImageUrl('')).toBeNull();
    expect(absoluteImageUrl('javascript:alert(1)')).toBeNull();
  });
});

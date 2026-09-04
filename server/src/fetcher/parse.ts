import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { FetchError } from '../errors.js';
import { isValidPrice, roundMoney } from '../domain/money.js';
import { absoluteImageUrl } from './url.js';
import type { FetchedProduct } from './types.js';

/**
 * HTML -> structured product data.
 *
 * Flipkart changes its markup regularly, so extraction is layered: several
 * independent parsers are tried in order of reliability and the first one that
 * yields a usable selling price wins. Nothing here is hard-coded to a specific
 * product; every value comes out of the supplied document.
 *
 * Parser order:
 *   1. `json-ld`        - schema.org Product block (most stable when present)
 *   2. `initial-state`  - the JSON state blob Flipkart embeds for hydration
 *   3. `dom`            - class-based selectors, current and previous markup
 *   4. `meta`           - Open Graph / meta tags
 *   5. `heuristic`      - first non-struck-through rupee amount in the document
 */

export interface ParseOutcome {
  product: FetchedProduct;
  /** Which parser produced the price. Logged for debugging markup drift. */
  extractedBy: string;
}

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

/** Matches a rupee amount such as `₹1,29,900` or `₹999.50`. */
const RUPEE_AMOUNT = /(?:₹|&#8377;|&#x20b9;|Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i;

/**
 * Parses a price out of arbitrary text.
 * Returns null when no plausible amount is present.
 */
export function parsePriceText(input: unknown): number | null {
  if (typeof input === 'number') return isValidPrice(input) ? roundMoney(input) : null;
  if (typeof input !== 'string') return null;

  const text = input.trim();
  if (!text) return null;

  const match = RUPEE_AMOUNT.exec(text);
  // Fall back to a bare number when there is no currency marker at all.
  const digits = match?.[1] ?? (/^[\d,]+(?:\.\d{1,2})?$/.test(text) ? text : null);
  if (!digits) return null;

  const value = Number.parseFloat(digits.replace(/,/g, ''));
  return isValidPrice(value) ? roundMoney(value) : null;
}

/** Collapses whitespace and strips zero-width characters. */
function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text : null;
}

/** Maps schema.org availability URLs onto short human-readable labels. */
function normaliseAvailability(value: unknown): string | null {
  const text = cleanText(typeof value === 'string' ? value : null);
  if (!text) return null;
  const token = text.replace(/^https?:\/\/schema\.org\//i, '').toLowerCase();
  if (token.includes('outofstock') || token.includes('soldout')) return 'Out of Stock';
  if (token.includes('instock')) return 'In Stock';
  if (token.includes('limitedavailability')) return 'Limited Availability';
  if (token.includes('preorder')) return 'Pre-order';
  if (token.includes('backorder')) return 'Backorder';
  if (token.includes('discontinued')) return 'Discontinued';
  return text.slice(0, 60);
}

/** Phrases that indicate the listing exists but cannot be bought right now. */
const UNAVAILABLE_PHRASES = [
  'sold out',
  'out of stock',
  'currently unavailable',
  'temporarily unavailable',
  'coming soon',
  'notify me when', // Flipkart's replacement for the buy button
];

/** Phrases that indicate an anti-bot / verification interstitial. */
const BLOCK_PHRASES = [
  'are you a human',
  'verify you are human',
  'unusual traffic',
  'access denied',
  'px-captcha',
  'please enable javascript and cookies',
  'checking your browser',
  'request unsuccessful. incapsula',
  'captcha',
];

/** Phrases that indicate the product page itself is gone. */
const REMOVED_PHRASES = [
  'unfortunately, the page you are looking for',
  'page not found',
  "we're sorry, this page is not available",
  'the page you were looking for could not be found',
  'this product is no longer available',
];

/**
 * Flipkart answers an unknown product id with HTTP 200 and its generic
 * storefront shell rather than a 404: site chrome renders, but there is no
 * product title and no price anywhere. Recognising that title lets us report
 * "this product does not exist" instead of a vague parse failure.
 */
const GENERIC_STOREFRONT_TITLES = [
  'buy products online at best price in india',
  'online shopping site for mobiles',
  'all categories | flipkart.com',
];

function containsAny(haystack: string, needles: readonly string[]): string | null {
  for (const needle of needles) {
    if (haystack.includes(needle)) return needle;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parser 1: schema.org JSON-LD
// ---------------------------------------------------------------------------

interface RawFields {
  productName?: string | null;
  price?: number | null;
  mrp?: number | null;
  imageUrl?: string | null;
  availability?: string | null;
  seller?: string | null;
  currency?: string | null;
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return cleanText(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item);
      if (found) return found;
    }
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return firstString(record.url ?? record.name ?? record.contentUrl ?? null);
  }
  return null;
}

/** Walks a JSON-LD document (including `@graph`) collecting Product nodes. */
function collectProductNodes(node: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 6) return;

  if (Array.isArray(node)) {
    for (const item of node) collectProductNodes(item, out, depth + 1);
    return;
  }

  const record = node as Record<string, unknown>;
  const type = record['@type'];
  const types = Array.isArray(type) ? type.map(String) : type ? [String(type)] : [];
  if (types.some((t) => t.toLowerCase() === 'product')) out.push(record);

  if (record['@graph']) collectProductNodes(record['@graph'], out, depth + 1);
  if (record.mainEntity) collectProductNodes(record.mainEntity, out, depth + 1);
  if (record.itemListElement) collectProductNodes(record.itemListElement, out, depth + 1);
}

function readOffer(offers: unknown): {
  price: number | null;
  mrp: number | null;
  availability: string | null;
  seller: string | null;
  currency: string | null;
} {
  const empty = { price: null, mrp: null, availability: null, seller: null, currency: null };
  if (!offers || typeof offers !== 'object') return empty;

  // `offers` may be a single Offer, an array of Offers, or an AggregateOffer.
  const list = Array.isArray(offers) ? offers : [offers];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const offer = entry as Record<string, unknown>;

    // AggregateOffer nests the real offers one level down.
    if (offer.offers) {
      const nested = readOffer(offer.offers);
      if (nested.price !== null) return nested;
    }

    const price =
      parsePriceText(offer.price) ??
      parsePriceText(offer.lowPrice) ??
      parsePriceText((offer.priceSpecification as Record<string, unknown> | undefined)?.price);

    if (price === null) continue;

    const sellerNode = offer.seller;
    const seller =
      typeof sellerNode === 'string'
        ? cleanText(sellerNode)
        : cleanText((sellerNode as Record<string, unknown> | undefined)?.name as string);

    return {
      price,
      mrp: parsePriceText(offer.highPrice) ?? null,
      availability: normaliseAvailability(offer.availability),
      seller,
      currency: cleanText(offer.priceCurrency) ?? null,
    };
  }

  return empty;
}

function extractFromJsonLd($: CheerioAPI): RawFields | null {
  const nodes: Record<string, unknown>[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text() || $(el).text();
    if (!raw?.trim()) return;
    try {
      collectProductNodes(JSON.parse(raw), nodes);
    } catch {
      // Flipkart occasionally emits invalid JSON-LD; skip that block.
    }
  });

  for (const node of nodes) {
    const offer = readOffer(node.offers);
    if (offer.price === null) continue;

    return {
      productName: firstString(node.name),
      price: offer.price,
      mrp: offer.mrp,
      imageUrl: absoluteImageUrl(firstString(node.image)),
      availability: offer.availability,
      seller: offer.seller,
      currency: offer.currency,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Parser 2: embedded hydration state
// ---------------------------------------------------------------------------

/** Extracts the first balanced JSON object appearing after `marker`. */
function jsonObjectAfter(html: string, marker: string): unknown | null {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;

  const start = html.indexOf('{', markerIndex + marker.length);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

/**
 * Breadth-first search for the first value stored under any of `keys`.
 * Bounded so a huge state blob cannot stall a check.
 */
function findByKeys(root: unknown, keys: readonly string[], budget = 200_000): unknown {
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  const queue: unknown[] = [root];
  let visited = 0;

  while (queue.length > 0 && visited < budget) {
    const node = queue.shift();
    visited += 1;
    if (!node || typeof node !== 'object') continue;

    if (Array.isArray(node)) {
      for (const item of node) queue.push(item);
      continue;
    }

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (wanted.has(key.toLowerCase()) && value !== null && value !== undefined) return value;
      if (value && typeof value === 'object') queue.push(value);
    }
  }

  return undefined;
}

/** Flipkart wraps amounts as `{ value: 69999, currency: 'INR' }`. */
function coerceAmount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string') return parsePriceText(value);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return parsePriceText(record.value ?? record.amount ?? record.price ?? null);
  }
  return null;
}

function extractFromInitialState(html: string): RawFields | null {
  const state =
    jsonObjectAfter(html, '__INITIAL_STATE__') ??
    jsonObjectAfter(html, '__PRELOADED_STATE__') ??
    jsonObjectAfter(html, 'window.__FK_STATE__');

  if (!state) return null;

  const price =
    coerceAmount(findByKeys(state, ['finalPrice'])) ??
    coerceAmount(findByKeys(state, ['sellingPrice'])) ??
    coerceAmount(findByKeys(state, ['offerPrice']));

  if (price === null) return null;

  const titles = findByKeys(state, ['titles']);
  const productName =
    cleanText((titles as Record<string, unknown> | undefined)?.title as string) ??
    cleanText(findByKeys(state, ['productTitle']) as string) ??
    null;

  const imageValue = findByKeys(state, ['imageUrl', 'imageUrls', 'image']);
  const imageUrl = absoluteImageUrl(
    firstString(imageValue) ??
      cleanText((imageValue as Record<string, unknown> | undefined)?.value as string),
  );

  return {
    productName,
    price,
    mrp: coerceAmount(findByKeys(state, ['mrp', 'strikeOffPrice', 'listPrice'])),
    imageUrl,
    availability: normaliseAvailability(findByKeys(state, ['availabilityStatus', 'availability'])),
    seller: cleanText(findByKeys(state, ['sellerName']) as string),
    currency: cleanText(findByKeys(state, ['currency']) as string),
  };
}

// ---------------------------------------------------------------------------
// Parser 3: DOM selectors
// ---------------------------------------------------------------------------

/**
 * Selectors covering Flipkart's current and previous markup generations.
 * Substring matchers (`[class*=...]`) survive the minor hash suffixes Flipkart
 * appends to its generated class names.
 */
const SELECTORS = {
  price: [
    'div.Nx9bqj.CxhGGd',
    'div.hl05eU div.Nx9bqj',
    'div._30jeq3._16Jk6d',
    'div[class*="_30jeq3"][class*="_16Jk6d"]',
    'div.Nx9bqj',
    'div[class*="_30jeq3"]',
    '[data-testid="selling-price"]',
  ],
  mrp: [
    'div.yRaY8j.A6\\+E6v',
    'div.yRaY8j',
    'div._3I9_wc._2p6lqe',
    'div[class*="_3I9_wc"]',
    '[data-testid="mrp"]',
  ],
  title: [
    'span.VU-ZEz',
    'h1 span.VU-ZEz',
    'span.B_NuCI',
    'h1._6EBuvT span',
    'h1[class*="_6EBuvT"]',
    'h1 span',
    'h1',
  ],
  image: [
    'img.DByuf4',
    'img._396cs4',
    'img._2r_T1I',
    'div._8id3KM img',
    'img[class*="DByuf4"]',
    'img[class*="_396cs4"]',
  ],
  seller: ['div#sellerName span span', '#sellerName span', 'div[id="sellerName"] span'],
} as const;

/** Classes known to hold the struck-through MRP rather than the sale price. */
const MRP_CLASS_HINTS = ['yRaY8j', '_3I9_wc', '_2p6lqe'];

function firstMatchingText($: CheerioAPI, selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    let text: string | null = null;
    try {
      text = cleanText($(selector).first().text());
    } catch {
      continue; // Malformed selector for this cheerio version - skip it.
    }
    if (text) return text;
  }
  return null;
}

function firstMatchingPrice($: CheerioAPI, selectors: readonly string[]): number | null {
  for (const selector of selectors) {
    let found: number | null = null;
    try {
      $(selector).each((_, el) => {
        if (found !== null) return false;
        const price = parsePriceText($(el).text());
        if (price !== null) {
          found = price;
          return false;
        }
        return undefined;
      });
    } catch {
      continue;
    }
    if (found !== null) return found;
  }
  return null;
}

function firstMatchingImage($: CheerioAPI): string | null {
  for (const selector of SELECTORS.image) {
    let src: string | null = null;
    try {
      $(selector).each((_, el) => {
        if (src) return false;
        const node = $(el);
        const candidate =
          node.attr('src') ??
          node.attr('data-src') ??
          node.attr('srcset')?.split(',')[0]?.trim().split(/\s+/)[0];
        const resolved = absoluteImageUrl(candidate ?? null);
        // Skip inline placeholders Flipkart uses before hydration.
        if (resolved && !resolved.startsWith('data:')) {
          src = resolved;
          return false;
        }
        return undefined;
      });
    } catch {
      continue;
    }
    if (src) return src;
  }
  return absoluteImageUrl($('meta[property="og:image"]').attr('content') ?? null);
}

function extractFromDom($: CheerioAPI): RawFields | null {
  const price = firstMatchingPrice($, SELECTORS.price);
  if (price === null) return null;

  const mrp = firstMatchingPrice($, SELECTORS.mrp);

  return {
    productName: firstMatchingText($, SELECTORS.title),
    price,
    // A "MRP" lower than the selling price is a mis-read; drop it.
    mrp: mrp !== null && mrp >= price ? mrp : null,
    imageUrl: firstMatchingImage($),
    availability: null,
    seller: firstMatchingText($, SELECTORS.seller),
    currency: null,
  };
}

// ---------------------------------------------------------------------------
// Parser 4: meta tags
// ---------------------------------------------------------------------------

function extractFromMeta($: CheerioAPI): RawFields | null {
  const price =
    parsePriceText($('meta[property="og:price:amount"]').attr('content')) ??
    parsePriceText($('meta[itemprop="price"]').attr('content')) ??
    parsePriceText($('meta[property="product:price:amount"]').attr('content'));

  if (price === null) return null;

  return {
    productName: cleanText($('meta[property="og:title"]').attr('content')),
    price,
    mrp: null,
    imageUrl: absoluteImageUrl($('meta[property="og:image"]').attr('content') ?? null),
    availability: normaliseAvailability($('meta[property="og:availability"]').attr('content')),
    seller: null,
    currency:
      cleanText($('meta[property="og:price:currency"]').attr('content')) ??
      cleanText($('meta[itemprop="priceCurrency"]').attr('content')),
  };
}

// ---------------------------------------------------------------------------
// Parser 5: heuristic sweep
// ---------------------------------------------------------------------------

/**
 * Last resort: the first rupee amount in document order that is not inside a
 * struck-through element or a known MRP container. On a product page this is
 * the selling price.
 */
function extractHeuristic($: CheerioAPI): RawFields | null {
  let price: number | null = null;

  $('div, span, strong, b').each((_, el) => {
    if (price !== null) return false;

    const node = $(el);
    // Only consider leaf-ish nodes so we do not read a whole price block.
    if (node.children().length > 1) return undefined;

    const className = node.attr('class') ?? '';
    if (MRP_CLASS_HINTS.some((hint) => className.includes(hint))) return undefined;
    if (node.closest('s, del, strike').length > 0) return undefined;

    const text = cleanText(node.text());
    if (!text || text.length > 24) return undefined;
    if (!/₹|&#8377;|Rs\.?/i.test(text)) return undefined;

    const candidate = parsePriceText(text);
    if (candidate !== null) {
      price = candidate;
      return false;
    }
    return undefined;
  });

  if (price === null) return null;

  return {
    productName: firstMatchingText($, SELECTORS.title),
    price,
    mrp: null,
    imageUrl: firstMatchingImage($),
    availability: null,
    seller: null,
    currency: null,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface ParseInput {
  html: string;
  /** Normalised URL, used for `sourceUrl` and error context. */
  url: string;
  httpStatus?: number | null;
  /** Where the HTML came from, for error reporting. */
  strategy?: string;
}

/**
 * Turns a Flipkart product page into structured data.
 *
 * @throws FetchError - CAPTCHA, PRODUCT_REMOVED, PRODUCT_UNAVAILABLE,
 *         PRICE_NOT_FOUND or PARSE_ERROR depending on what the page contained.
 */
export function parseFlipkartHtml({ html, url, strategy }: ParseInput): ParseOutcome {
  const context = { url, ...(strategy ? { strategy } : {}) };

  if (!html || html.trim().length === 0) {
    throw new FetchError('PARSE_ERROR', 'Flipkart returned an empty document.', context);
  }

  const lower = html.toLowerCase();

  // A verification page must never be mistaken for a missing price. We report
  // it and stop - working around bot protection is out of scope by design.
  const blockPhrase = containsAny(lower, BLOCK_PHRASES);
  if (blockPhrase && lower.length < 200_000) {
    throw new FetchError(
      'CAPTCHA',
      'Flipkart served a bot-verification page instead of the product.',
      { ...context, details: { matched: blockPhrase } },
    );
  }

  const $ = cheerio.load(html);
  const pageTitle = cleanText($('title').first().text())?.toLowerCase() ?? '';

  const removedPhrase = containsAny(lower, REMOVED_PHRASES) ?? containsAny(pageTitle, ['404']);
  if (removedPhrase) {
    throw new FetchError('PRODUCT_REMOVED', 'This product page no longer exists on Flipkart.', {
      ...context,
      details: { matched: removedPhrase },
    });
  }

  const parsers: Array<[string, () => RawFields | null]> = [
    ['json-ld', () => extractFromJsonLd($)],
    ['initial-state', () => extractFromInitialState(html)],
    ['dom', () => extractFromDom($)],
    ['meta', () => extractFromMeta($)],
    ['heuristic', () => extractHeuristic($)],
  ];

  let fields: RawFields | null = null;
  let extractedBy = 'none';

  for (const [name, run] of parsers) {
    let result: RawFields | null = null;
    try {
      result = run();
    } catch {
      // A single parser blowing up must not abort the whole extraction.
      result = null;
    }
    if (result && isValidPrice(result.price)) {
      fields = result;
      extractedBy = name;
      break;
    }
    // Remember a name/image even when the price was missing, so a later
    // parser that only found a price still produces a complete record.
    if (result && !fields) fields = { ...result, price: null };
  }

  const title =
    fields?.productName ??
    firstMatchingText($, SELECTORS.title) ??
    cleanText($('meta[property="og:title"]').attr('content'));

  if (!fields || !isValidPrice(fields.price)) {
    const unavailable = containsAny(lower, UNAVAILABLE_PHRASES);
    if (unavailable) {
      throw new FetchError(
        'PRODUCT_UNAVAILABLE',
        'The product is unavailable on Flipkart, so no selling price is listed.',
        { ...context, details: { matched: unavailable, productName: title ?? null } },
      );
    }
    if (title) {
      throw new FetchError(
        'PRICE_NOT_FOUND',
        'The product page loaded but no selling price could be located.',
        { ...context, details: { productName: title } },
      );
    }

    // No product title and no price, on a page carrying Flipkart's generic
    // storefront title: the product id does not resolve to a real listing.
    const genericTitle = containsAny(pageTitle, GENERIC_STOREFRONT_TITLES);
    if (genericTitle) {
      throw new FetchError(
        'PRODUCT_REMOVED',
        'Flipkart did not return a product for this URL. Check that the link is a live product page.',
        { ...context, details: { pageTitle } },
      );
    }

    throw new FetchError(
      'PARSE_ERROR',
      'The page did not look like a Flipkart product page (no title and no price).',
      context,
    );
  }

  if (!title) {
    throw new FetchError('PARSE_ERROR', 'Found a price but no product title.', {
      ...context,
      details: { extractedBy },
    });
  }

  const availability =
    fields.availability ?? (containsAny(lower, UNAVAILABLE_PHRASES) ? 'Out of Stock' : 'In Stock');

  const product: FetchedProduct = {
    productName: title,
    price: roundMoney(fields.price),
    mrp: fields.mrp !== null && fields.mrp !== undefined ? roundMoney(fields.mrp) : null,
    imageUrl: fields.imageUrl ?? firstMatchingImage($),
    availability,
    seller: fields.seller ?? firstMatchingText($, SELECTORS.seller),
    currency: fields.currency ?? 'INR',
    url,
  };

  return { product, extractedBy };
}

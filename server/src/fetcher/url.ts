import { FetchError } from '../errors.js';

/**
 * Flipkart URL handling: validation, normalisation and stable identity.
 */

/** Hosts we accept. Any `*.flipkart.com` subdomain is allowed. */
const FLIPKART_HOST = 'flipkart.com';

/** Product detail pages always contain a `/p/<itemId>` segment. */
const ITEM_ID_PATTERN = /\/p\/(it[a-z0-9]+)/i;

/** Query params worth keeping. Everything else is tracking noise. */
const MEANINGFUL_PARAMS = ['pid', 'lid'] as const;

export interface FlipkartUrlInfo {
  /** Cleaned URL used for all future fetches. */
  normalisedUrl: string;
  /** Flipkart item id, e.g. `itm6ac6a86b6e1d2`. */
  itemId: string;
  /** Listing/variant id from `?pid=`, when present. */
  pid: string | null;
  /** Seller listing id from `?lid=`, when present. */
  lid: string | null;
  /**
   * Stable identity for de-duplication. Prefers `pid` because a single item id
   * can have several variants (colour / storage) at different prices.
   */
  canonicalKey: string;
}

function isFlipkartHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === FLIPKART_HOST || host.endsWith(`.${FLIPKART_HOST}`);
}

/**
 * Validates and normalises a Flipkart product URL.
 *
 * @throws FetchError with code `INVALID_URL` when the input is not a Flipkart
 *         product detail page.
 */
export function parseFlipkartUrl(input: string): FlipkartUrlInfo {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) {
    throw new FetchError('INVALID_URL', 'A product URL is required.');
  }

  // Accept input pasted without a scheme, e.g. "flipkart.com/...".
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new FetchError('INVALID_URL', `"${raw}" is not a valid URL.`, { url: raw });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError('INVALID_URL', 'Only http(s) URLs are supported.', { url: raw });
  }

  if (!isFlipkartHost(url.hostname)) {
    throw new FetchError(
      'INVALID_URL',
      `Expected a flipkart.com URL but got "${url.hostname}".`,
      { url: raw },
    );
  }

  const itemMatch = ITEM_ID_PATTERN.exec(url.pathname);
  if (!itemMatch?.[1]) {
    throw new FetchError(
      'INVALID_URL',
      'That Flipkart link is not a product page. Open the product and copy the URL containing "/p/".',
      { url: raw },
    );
  }

  const itemId = itemMatch[1].toLowerCase();
  const pid = url.searchParams.get('pid')?.trim().toUpperCase() || null;
  const lid = url.searchParams.get('lid')?.trim() || null;

  // Rebuild the URL with a canonical host and only the params that matter.
  const clean = new URL(`https://www.flipkart.com${url.pathname}`);
  for (const key of MEANINGFUL_PARAMS) {
    const value = url.searchParams.get(key);
    if (value && value.trim()) clean.searchParams.set(key, value.trim());
  }

  return {
    normalisedUrl: clean.toString(),
    itemId,
    pid,
    lid,
    canonicalKey: pid ? `pid:${pid}` : `itm:${itemId}`,
  };
}

/** Non-throwing variant, handy for validation in the API layer. */
export function isFlipkartProductUrl(input: string): boolean {
  try {
    parseFlipkartUrl(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a possibly-relative or protocol-relative asset URL against Flipkart.
 * Also swaps Flipkart's `{@width}`/`{@height}` image templates for real sizes.
 */
export function absoluteImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  let src = value.trim();
  if (!src) return null;

  src = src.replace(/\{@width\}/gi, '400').replace(/\{@height\}/gi, '400');

  if (src.startsWith('//')) src = `https:${src}`;
  else if (src.startsWith('/')) src = `https://www.flipkart.com${src}`;

  try {
    const parsed = new URL(src);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

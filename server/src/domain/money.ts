/**
 * Money helpers.
 *
 * Prices are stored as REAL in SQLite, so every comparison and calculation
 * goes through this module. Comparing at "paise" (1/100) granularity means
 * floating-point representation can never fabricate a price change, which is
 * critical because a price change is the single trigger in this application.
 */

/** Smallest unit we care about: 1 paise. */
const UNIT = 100;

/** Round to 2 decimal places, avoiding the classic 1.005 float surprise. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * UNIT) / UNIT;
}

/** Convert a price to whole paise so it can be compared exactly. */
export function toPaise(value: number): number {
  return Math.round(roundMoney(value) * UNIT);
}

/**
 * True when two prices are genuinely different at paise granularity.
 * This is the authoritative "did the price change?" predicate.
 */
export function pricesDiffer(a: number, b: number): boolean {
  return toPaise(a) !== toPaise(b);
}

/** A price must be a finite, strictly positive number to be usable. */
export function isValidPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export type PriceDirection = 'up' | 'down';

export interface PriceDelta {
  oldPrice: number;
  newPrice: number;
  /** Magnitude of the change; always >= 0. Pair with `direction` for the sign. */
  absoluteChange: number;
  /** Magnitude of the change relative to `oldPrice`, in percent; always >= 0. */
  percentageChange: number;
  direction: PriceDirection;
  /** Signed delta (negative for a drop) - convenient for charts and UI. */
  signedChange: number;
  /** Signed percentage (negative for a drop). */
  signedPercentageChange: number;
}

/**
 * Computes the delta between two prices.
 *
 * Percentage is relative to the previous price, matching how shoppers read a
 * price move: 69,999 -> 67,999 is a 2.86% drop.
 */
export function computePriceDelta(oldPrice: number, newPrice: number): PriceDelta {
  const from = roundMoney(oldPrice);
  const to = roundMoney(newPrice);
  const signedChange = roundMoney(to - from);
  const absoluteChange = Math.abs(signedChange);
  // Guard against a zero baseline; a percentage of "infinity" is meaningless.
  const percentageChange = from > 0 ? roundPercent((absoluteChange / from) * 100) : 0;
  const direction: PriceDirection = signedChange < 0 ? 'down' : 'up';

  return {
    oldPrice: from,
    newPrice: to,
    absoluteChange,
    percentageChange,
    direction,
    signedChange,
    signedPercentageChange: direction === 'down' ? -percentageChange : percentageChange,
  };
}

/** Percentages are reported to 2 decimal places. */
export function roundPercent(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const inrWhole = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const inrFraction = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Formats a price for human-readable notification text, e.g. `₹69,999`.
 * Paise are only shown when they are non-zero.
 */
export function formatMoney(value: number, currency = 'INR'): string {
  const rounded = roundMoney(value);
  if (currency === 'INR') {
    return Number.isInteger(rounded) ? inrWhole.format(rounded) : inrFraction.format(rounded);
  }
  const formatter = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: Number.isInteger(rounded) ? 0 : 2,
  });
  return formatter.format(rounded);
}

import { describe, expect, it } from 'vitest';
import {
  computePriceDelta,
  formatMoney,
  isValidPrice,
  pricesDiffer,
  roundMoney,
  toPaise,
} from '../src/domain/money.js';

describe('pricesDiffer', () => {
  it('treats identical prices as unchanged', () => {
    expect(pricesDiffer(69999, 69999)).toBe(false);
    expect(pricesDiffer(0.01, 0.01)).toBe(false);
  });

  it('detects a difference of a single paise', () => {
    expect(pricesDiffer(100.0, 100.01)).toBe(true);
  });

  it('does not report a change for floating-point noise', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754. Comparing at paise
    // granularity is what stops that from becoming a phantom price change.
    expect(pricesDiffer(0.1 + 0.2, 0.3)).toBe(false);
    expect(pricesDiffer(1999.999999999, 2000)).toBe(false);
  });

  it('is symmetric', () => {
    expect(pricesDiffer(500, 450)).toBe(pricesDiffer(450, 500));
  });
});

describe('roundMoney / toPaise', () => {
  it('rounds to two decimal places', () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(69999)).toBe(69999);
    expect(roundMoney(1234.567)).toBe(1234.57);
  });

  it('converts to whole paise', () => {
    expect(toPaise(69999)).toBe(6999900);
    expect(toPaise(0.01)).toBe(1);
  });
});

describe('isValidPrice', () => {
  it('accepts positive finite numbers', () => {
    expect(isValidPrice(1)).toBe(true);
    expect(isValidPrice(69999.5)).toBe(true);
  });

  it('rejects zero, negatives and non-numbers', () => {
    for (const value of [0, -1, NaN, Infinity, null, undefined, '69999', {}]) {
      expect(isValidPrice(value)).toBe(false);
    }
  });
});

describe('computePriceDelta', () => {
  it('computes a drop using the spec example (69,999 -> 67,999)', () => {
    const delta = computePriceDelta(69999, 67999);

    expect(delta.direction).toBe('down');
    expect(delta.absoluteChange).toBe(2000);
    expect(delta.percentageChange).toBe(2.86);
    expect(delta.signedChange).toBe(-2000);
    expect(delta.signedPercentageChange).toBe(-2.86);
  });

  it('computes an increase using the spec example (67,999 -> 70,999)', () => {
    const delta = computePriceDelta(67999, 70999);

    expect(delta.direction).toBe('up');
    expect(delta.absoluteChange).toBe(3000);
    expect(delta.percentageChange).toBe(4.41);
    expect(delta.signedChange).toBe(3000);
    expect(delta.signedPercentageChange).toBe(4.41);
  });

  it('bases the percentage on the previous price', () => {
    // 1000 -> 500 is a 50% drop; 500 -> 1000 is a 100% increase.
    expect(computePriceDelta(1000, 500).percentageChange).toBe(50);
    expect(computePriceDelta(500, 1000).percentageChange).toBe(100);
  });

  it('reports magnitudes, never negative numbers', () => {
    const delta = computePriceDelta(2000, 1000);
    expect(delta.absoluteChange).toBeGreaterThan(0);
    expect(delta.percentageChange).toBeGreaterThan(0);
  });

  it('rounds the percentage to two decimals', () => {
    // 1/3 of 3 -> 33.333...%
    expect(computePriceDelta(3, 2).percentageChange).toBe(33.33);
  });

  it('handles paise-level changes', () => {
    const delta = computePriceDelta(100, 100.5);
    expect(delta.direction).toBe('up');
    expect(delta.absoluteChange).toBe(0.5);
    expect(delta.percentageChange).toBe(0.5);
  });
});

describe('formatMoney', () => {
  it('formats rupees with Indian digit grouping and no decimals', () => {
    expect(formatMoney(69999)).toBe('₹69,999');
    expect(formatMoney(129900)).toBe('₹1,29,900');
    expect(formatMoney(2000)).toBe('₹2,000');
  });

  it('shows paise only when they are non-zero', () => {
    expect(formatMoney(100.5)).toBe('₹100.50');
  });
});

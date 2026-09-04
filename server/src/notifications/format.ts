import { formatMoney } from '../domain/money.js';
import type { NotificationPayload, NotificationType } from '../domain/types.js';
import type { NotificationMessage, PriceChangeEvent } from './types.js';

/**
 * Renders a price change into a notification.
 *
 * Every genuine change produces a message. There is no threshold, no target
 * price and no minimum discount - a one-rupee move is reported exactly like a
 * ten-thousand-rupee move.
 *
 * Example output:
 *
 *   title:   Price dropped
 *   message: iPhone 16
 *            ₹69,999 → ₹67,999
 *            ↓ ₹2,000 (2.86%)
 */
export function buildPriceChangeMessage({ product, change }: PriceChangeEvent): NotificationMessage {
  const dropped = change.direction === 'down';
  const type: NotificationType = dropped ? 'price_drop' : 'price_increase';
  const arrow = dropped ? '↓' : '↑';
  const currency = change.currency || product.currency || 'INR';

  const title = dropped ? 'Price dropped' : 'Price increased';

  const message = [
    product.productName,
    `${formatMoney(change.oldPrice, currency)} → ${formatMoney(change.newPrice, currency)}`,
    `${arrow} ${formatMoney(change.absoluteChange, currency)} (${formatPercent(change.percentageChange)})`,
  ].join('\n');

  const payload: NotificationPayload = {
    productId: product.id,
    productName: product.productName,
    imageUrl: product.imageUrl,
    url: product.url,
    currency,
    oldPrice: change.oldPrice,
    newPrice: change.newPrice,
    absoluteChange: change.absoluteChange,
    percentageChange: change.percentageChange,
    direction: change.direction,
    detectedAt: change.detectedAt,
  };

  return { type, title, message, payload };
}

/** `2.86` -> `2.86%`, trimming a pointless `.00`. */
export function formatPercent(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
  return `${text}%`;
}

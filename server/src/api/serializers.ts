import { formatMoney } from '../domain/money.js';
import type {
  AppNotification,
  CheckLogEntry,
  PriceChange,
  PriceDirection,
  Product,
  ProductStats,
} from '../domain/types.js';
import type { PriceHistoryPoint, ProductWithChange } from '../services/productService.js';

/**
 * Domain -> JSON DTOs.
 *
 * The dashboard receives pre-computed display values (signed deltas, formatted
 * currency) so the UI never has to re-derive money maths and risk disagreeing
 * with the backend.
 */

export interface PriceChangeDto {
  id: number;
  productId: number;
  oldPrice: number;
  newPrice: number;
  /** Magnitude of the move. */
  absoluteChange: number;
  /** Magnitude in percent. */
  percentageChange: number;
  direction: PriceDirection;
  /** Negative for a drop, positive for an increase. */
  signedChange: number;
  currency: string;
  detectedAt: string;
  /** e.g. `↓ ₹2,000 (2.86%)` */
  display: string;
}

export function serializePriceChange(change: PriceChange): PriceChangeDto {
  const signedChange =
    change.direction === 'down' ? -change.absoluteChange : change.absoluteChange;
  const arrow = change.direction === 'down' ? '↓' : '↑';
  return {
    id: change.id,
    productId: change.productId,
    oldPrice: change.oldPrice,
    newPrice: change.newPrice,
    absoluteChange: change.absoluteChange,
    percentageChange: change.percentageChange,
    direction: change.direction,
    signedChange,
    currency: change.currency,
    detectedAt: change.detectedAt,
    display: `${arrow} ${formatMoney(change.absoluteChange, change.currency)} (${change.percentageChange}%)`,
  };
}

export interface ProductDto {
  id: number;
  url: string;
  productName: string;
  imageUrl: string | null;
  currency: string;

  currentPrice: number | null;
  previousPrice: number | null;
  lowestPrice: number | null;
  highestPrice: number | null;
  mrp: number | null;

  availability: string | null;
  seller: string | null;

  monitoringEnabled: boolean;
  priceChangeCount: number;
  consecutiveFailures: number;

  lastStatus: Product['lastStatus'];
  lastErrorCode: string | null;
  lastErrorMessage: string | null;

  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastAttemptedAt: string | null;
  lastPriceChangeAt: string | null;

  /** Convenience for the dashboard: formatted current price. */
  currentPriceDisplay: string | null;
  latestChange: PriceChangeDto | null;
}

export function serializeProduct(
  product: Product,
  latestChange: PriceChange | null = null,
): ProductDto {
  return {
    id: product.id,
    url: product.url,
    productName: product.productName,
    imageUrl: product.imageUrl,
    currency: product.currency,

    currentPrice: product.currentPrice,
    previousPrice: product.previousPrice,
    lowestPrice: product.lowestPrice,
    highestPrice: product.highestPrice,
    mrp: product.mrp,

    availability: product.availability,
    seller: product.seller,

    monitoringEnabled: product.monitoringEnabled,
    priceChangeCount: product.priceChangeCount,
    consecutiveFailures: product.consecutiveFailures,

    lastStatus: product.lastStatus,
    lastErrorCode: product.lastErrorCode,
    lastErrorMessage: product.lastErrorMessage,

    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    lastCheckedAt: product.lastCheckedAt,
    lastAttemptedAt: product.lastAttemptedAt,
    lastPriceChangeAt: product.lastPriceChangeAt,

    currentPriceDisplay:
      product.currentPrice === null
        ? null
        : formatMoney(product.currentPrice, product.currency),
    latestChange: latestChange ? serializePriceChange(latestChange) : null,
  };
}

export function serializeProductRow(row: ProductWithChange): ProductDto {
  return serializeProduct(row.product, row.latestChange);
}

export interface ProductStatsDto extends Omit<ProductStats, 'lastPriceChange'> {
  lastPriceChange: PriceChangeDto | null;
}

export function serializeStats(stats: ProductStats): ProductStatsDto {
  return {
    ...stats,
    lastPriceChange: stats.lastPriceChange ? serializePriceChange(stats.lastPriceChange) : null,
  };
}

export interface PriceHistoryPointDto {
  id: number;
  price: number;
  timestamp: string;
  currency: string;
  availability: string | null;
  seller: string | null;
  isBaseline: boolean;
  absoluteChange: number | null;
  percentageChange: number | null;
  direction: PriceDirection | null;
  signedChange: number | null;
  /** `↓ ₹2,000` for a change, `—` for the first observation. */
  display: string;
}

export function serializeHistoryPoint(point: PriceHistoryPoint): PriceHistoryPointDto {
  const change = point.change;
  return {
    id: point.id,
    price: point.price,
    timestamp: point.timestamp,
    currency: point.currency,
    availability: point.availability,
    seller: point.seller,
    isBaseline: point.isBaseline,
    absoluteChange: change?.absoluteChange ?? null,
    percentageChange: change?.percentageChange ?? null,
    direction: change?.direction ?? null,
    signedChange: change?.signedChange ?? null,
    display: change
      ? `${change.direction === 'down' ? '↓' : '↑'} ${formatMoney(change.absoluteChange, point.currency)}`
      : '—',
  };
}

export interface NotificationDto {
  id: number;
  productId: number | null;
  priceChangeId: number | null;
  channel: string;
  type: AppNotification['type'];
  title: string;
  message: string;
  payload: AppNotification['payload'];
  read: boolean;
  deliveryStatus: AppNotification['deliveryStatus'];
  deliveryError: string | null;
  createdAt: string;
}

export function serializeNotification(notification: AppNotification): NotificationDto {
  return { ...notification };
}

export interface CheckLogDto extends CheckLogEntry {
  /** Product name resolved for display, when the product still exists. */
  productName?: string | null;
}

export function serializeCheckLog(
  entry: CheckLogEntry,
  productName: string | null = null,
): CheckLogDto {
  return { ...entry, productName };
}

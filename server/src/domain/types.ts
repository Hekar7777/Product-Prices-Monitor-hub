import type { PriceDirection } from './money.js';

export type { PriceDirection, PriceDelta } from './money.js';

/** Result of the most recent check attempt for a product. */
export type CheckStatus = 'pending' | 'ok' | 'failed';

/** What a successful check concluded. */
export type CheckOutcome = 'baseline' | 'unchanged' | 'changed';

export interface Product {
  id: number;
  url: string;
  canonicalKey: string;
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

  lastStatus: CheckStatus;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;

  createdAt: string;
  updatedAt: string;
  /** Last *successful* check. Never advanced by a failed check. */
  lastCheckedAt: string | null;
  /** Last attempt, successful or not. */
  lastAttemptedAt: string | null;
  lastPriceChangeAt: string | null;
}

export interface PriceHistoryEntry {
  id: number;
  productId: number;
  price: number;
  currency: string;
  mrp: number | null;
  availability: string | null;
  seller: string | null;
  sourceUrl: string;
  isBaseline: boolean;
  timestamp: string;
}

export interface PriceChange {
  id: number;
  productId: number;
  priceHistoryId: number | null;
  oldPrice: number;
  newPrice: number;
  /** Magnitude, always >= 0. Combine with `direction` for the sign. */
  absoluteChange: number;
  /** Magnitude in percent, always >= 0. */
  percentageChange: number;
  direction: PriceDirection;
  currency: string;
  detectedAt: string;
}

export type NotificationType = 'price_drop' | 'price_increase' | 'system';
export type DeliveryStatus = 'delivered' | 'failed';

export interface AppNotification {
  id: number;
  productId: number | null;
  priceChangeId: number | null;
  channel: string;
  type: NotificationType;
  title: string;
  message: string;
  payload: NotificationPayload | null;
  read: boolean;
  deliveryStatus: DeliveryStatus;
  deliveryError: string | null;
  createdAt: string;
}

/** Structured data attached to a notification so clients need not parse text. */
export interface NotificationPayload {
  productId: number;
  productName: string;
  imageUrl: string | null;
  url: string;
  currency: string;
  oldPrice: number;
  newPrice: number;
  absoluteChange: number;
  percentageChange: number;
  direction: PriceDirection;
  detectedAt: string;
}

export type CheckLogStatus = 'success' | 'failed' | 'skipped';
export type CheckTrigger = 'scheduler' | 'manual' | 'initial';

export interface CheckLogEntry {
  id: number;
  productId: number | null;
  status: CheckLogStatus;
  outcome: CheckOutcome | null;
  price: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  durationMs: number | null;
  strategy: string | null;
  triggerSource: CheckTrigger;
  startedAt: string;
  finishedAt: string;
}

/** Aggregated statistics shown on the product detail page. */
export interface ProductStats {
  currentPrice: number | null;
  previousPrice: number | null;
  lowestPrice: number | null;
  highestPrice: number | null;
  averagePrice: number | null;
  totalPriceChanges: number;
  totalObservations: number;
  lastPriceChange: PriceChange | null;
  lastCheckedAt: string | null;
  lastPriceChangeAt: string | null;
  firstTrackedAt: string;
}

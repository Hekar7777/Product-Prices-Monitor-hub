import { roundMoney } from '../domain/money.js';
import type {
  AppNotification,
  CheckLogEntry,
  CheckLogStatus,
  CheckOutcome,
  CheckStatus,
  CheckTrigger,
  DeliveryStatus,
  NotificationPayload,
  NotificationType,
  PriceChange,
  PriceDirection,
  PriceHistoryEntry,
  Product,
} from '../domain/types.js';

/** Row -> domain mapping. Keeps SQL column names out of the service layer. */

/**
 * Reads a boolean column back. Postgres returns native JSON `true`/`false`
 * via PostgREST, but this also tolerates the legacy SQLite 0/1 representation
 * so a stray raw row shape never crashes the mapper.
 */
export function fromDbBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't';
}

export function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > 0 ? text : null;
}

export function toMoney(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? roundMoney(num) : null;
}

export function toInt(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const num = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

export function mapProduct(row: Record<string, unknown>): Product {
  return {
    id: toInt(row.id),
    url: String(row.url),
    canonicalKey: String(row.canonical_key),
    productName: String(row.product_name),
    imageUrl: toText(row.image_url),
    currency: toText(row.currency) ?? 'INR',

    currentPrice: toMoney(row.current_price),
    previousPrice: toMoney(row.previous_price),
    lowestPrice: toMoney(row.lowest_price),
    highestPrice: toMoney(row.highest_price),
    mrp: toMoney(row.mrp),

    availability: toText(row.availability),
    seller: toText(row.seller),

    monitoringEnabled: fromDbBool(row.monitoring_enabled),
    priceChangeCount: toInt(row.price_change_count),
    consecutiveFailures: toInt(row.consecutive_failures),

    lastStatus: (toText(row.last_status) ?? 'pending') as CheckStatus,
    lastErrorCode: toText(row.last_error_code),
    lastErrorMessage: toText(row.last_error_message),

    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastCheckedAt: toText(row.last_checked_at),
    lastAttemptedAt: toText(row.last_attempted_at),
    lastPriceChangeAt: toText(row.last_price_change_at),
  };
}

export function mapPriceHistory(row: Record<string, unknown>): PriceHistoryEntry {
  return {
    id: toInt(row.id),
    productId: toInt(row.product_id),
    price: toMoney(row.price) ?? 0,
    currency: toText(row.currency) ?? 'INR',
    mrp: toMoney(row.mrp),
    availability: toText(row.availability),
    seller: toText(row.seller),
    sourceUrl: String(row.source_url),
    isBaseline: fromDbBool(row.is_baseline),
    timestamp: String(row.timestamp),
  };
}

export function mapPriceChange(row: Record<string, unknown>): PriceChange {
  return {
    id: toInt(row.id),
    productId: toInt(row.product_id),
    priceHistoryId: row.price_history_id === null ? null : toInt(row.price_history_id),
    oldPrice: toMoney(row.old_price) ?? 0,
    newPrice: toMoney(row.new_price) ?? 0,
    absoluteChange: toMoney(row.absolute_change) ?? 0,
    percentageChange: toMoney(row.percentage_change) ?? 0,
    direction: (toText(row.direction) ?? 'up') as PriceDirection,
    currency: toText(row.currency) ?? 'INR',
    detectedAt: String(row.detected_at),
  };
}

export function mapNotification(row: Record<string, unknown>): AppNotification {
  let payload: NotificationPayload | null = null;
  const raw = toText(row.payload);
  if (raw) {
    try {
      payload = JSON.parse(raw) as NotificationPayload;
    } catch {
      payload = null; // Corrupt payload should not break the feed.
    }
  }

  return {
    id: toInt(row.id),
    productId: row.product_id === null ? null : toInt(row.product_id),
    priceChangeId: row.price_change_id === null ? null : toInt(row.price_change_id),
    channel: toText(row.channel) ?? 'in_app',
    type: (toText(row.type) ?? 'system') as NotificationType,
    title: String(row.title),
    message: String(row.message),
    payload,
    read: fromDbBool(row.read),
    deliveryStatus: (toText(row.delivery_status) ?? 'delivered') as DeliveryStatus,
    deliveryError: toText(row.delivery_error),
    createdAt: String(row.created_at),
  };
}

export function mapCheckLog(row: Record<string, unknown>): CheckLogEntry {
  return {
    id: toInt(row.id),
    productId: row.product_id === null ? null : toInt(row.product_id),
    status: (toText(row.status) ?? 'failed') as CheckLogStatus,
    outcome: (toText(row.outcome) as CheckOutcome | null) ?? null,
    price: toMoney(row.price),
    errorCode: toText(row.error_code),
    errorMessage: toText(row.error_message),
    attempts: toInt(row.attempts, 1),
    durationMs: row.duration_ms === null ? null : toInt(row.duration_ms),
    strategy: toText(row.strategy),
    triggerSource: (toText(row.trigger_source) ?? 'scheduler') as CheckTrigger,
    startedAt: String(row.started_at),
    finishedAt: String(row.finished_at),
  };
}

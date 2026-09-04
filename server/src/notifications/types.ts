import type { NotificationPayload, NotificationType, PriceChange, Product } from '../domain/types.js';

/**
 * Notification provider abstraction.
 *
 * Ships with in-app and Web Push providers. Email or webhook providers can
 * be added by implementing this interface and registering them with
 * `NotificationService` - no other part of the application needs to change.
 */

/** Everything a provider needs to describe a price change. */
export interface PriceChangeEvent {
  product: Product;
  change: PriceChange;
}

/** A rendered, provider-agnostic message. */
export interface NotificationMessage {
  type: NotificationType;
  /** Short headline, e.g. `Price dropped`. */
  title: string;
  /** Multi-line human-readable body. */
  message: string;
  /** Machine-readable data so clients do not have to parse `message`. */
  payload: NotificationPayload;
}

export interface DeliveryResult {
  ok: boolean;
  /** Populated when `ok` is false. */
  error?: string;
}

export interface NotificationProvider {
  /** Stable identifier persisted on each notification row. */
  readonly channel: string;
  /**
   * Whether this provider should receive messages right now. Providers that
   * are not configured (missing token, disabled in settings) return false and
   * are skipped silently.
   */
  isEnabled(): boolean;
  /**
   * Performs the outbound delivery.
   *
   * Note: `NotificationService` always persists a `notifications` row for every
   * enabled provider - that row is both the audit record and, for the in-app
   * channel, the delivery itself. Outbound providers should only do their
   * network I/O here and must not throw; return `{ ok: false, error }` instead.
   */
  send(message: NotificationMessage): Promise<DeliveryResult>;
}

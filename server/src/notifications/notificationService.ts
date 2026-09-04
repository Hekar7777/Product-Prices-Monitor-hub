import type { AppNotification } from '../domain/types.js';
import { logger } from '../logger.js';
import type {
  ListNotificationsOptions,
  NotificationRepository,
} from '../repositories/notificationRepository.js';
import { buildPriceChangeMessage } from './format.js';
import type { NotificationProvider, PriceChangeEvent } from './types.js';

export type NotificationListener = (notification: AppNotification) => void;

/**
 * Fans a price change out to every enabled notification provider and keeps a
 * persistent record of each delivery.
 *
 * The service is intentionally unaware of *why* a change happened. It is called
 * once per detected price change, and it notifies unconditionally - there are no
 * thresholds or target prices anywhere in this path.
 */
export class NotificationService {
  private readonly providers: NotificationProvider[] = [];
  private readonly listeners = new Set<NotificationListener>();
  private readonly log = logger.child({ component: 'notifications' });

  constructor(
    private readonly repo: NotificationRepository,
    providers: NotificationProvider[] = [],
  ) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: NotificationProvider): void {
    if (this.providers.some((p) => p.channel === provider.channel)) {
      throw new Error(`A notification provider for channel "${provider.channel}" is registered`);
    }
    this.providers.push(provider);
    this.log.debug('Registered notification provider', { channel: provider.channel });
  }

  channels(): string[] {
    return this.providers.map((p) => p.channel);
  }

  enabledChannels(): string[] {
    return this.providers.filter((p) => p.isEnabled()).map((p) => p.channel);
  }

  /**
   * Creates and delivers a notification for a detected price change.
   *
   * Returns one notification per provider that accepted the message. A provider
   * failing does not prevent the others from being notified, and a delivery
   * failure is persisted rather than thrown so a check never fails because a
   * notification could not be sent.
   */
  async notifyPriceChange(event: PriceChangeEvent): Promise<AppNotification[]> {
    const message = buildPriceChangeMessage(event);
    const created: AppNotification[] = [];

    for (const provider of this.providers) {
      if (!provider.isEnabled()) continue;

      // Idempotency guard: one notification per change per channel.
      if (await this.repo.existsForPriceChange(event.change.id, provider.channel)) {
        this.log.debug('Notification already exists for this change; skipping', {
          channel: provider.channel,
          priceChangeId: event.change.id,
        });
        continue;
      }

      let ok = true;
      let error: string | null = null;

      try {
        const result = await provider.send(message);
        ok = result.ok;
        error = result.error ?? null;
      } catch (err) {
        ok = false;
        error = err instanceof Error ? err.message : String(err);
      }

      const notification = await this.repo.create({
        productId: event.product.id,
        priceChangeId: event.change.id,
        channel: provider.channel,
        type: message.type,
        title: message.title,
        message: message.message,
        payload: message.payload,
        deliveryStatus: ok ? 'delivered' : 'failed',
        deliveryError: error,
        createdAt: event.change.detectedAt,
      });

      created.push(notification);

      if (ok) {
        this.log.info('Notification created', {
          event: 'notification.created',
          channel: provider.channel,
          notificationId: notification.id,
          productId: event.product.id,
          priceChangeId: event.change.id,
          direction: event.change.direction,
          oldPrice: event.change.oldPrice,
          newPrice: event.change.newPrice,
          absoluteChange: event.change.absoluteChange,
          percentageChange: event.change.percentageChange,
        });
      } else {
        this.log.error('Notification delivery failed', {
          event: 'notification.failed',
          channel: provider.channel,
          notificationId: notification.id,
          productId: event.product.id,
          error,
        });
      }

      this.emit(notification);
    }

    return created;
  }

  // --- read/update helpers used by the API -------------------------------

  list(options: ListNotificationsOptions = {}): Promise<AppNotification[]> {
    return this.repo.list(options);
  }

  unreadCount(): Promise<number> {
    return this.repo.unreadCount();
  }

  total(): Promise<number> {
    return this.repo.total();
  }

  markRead(id: number, read = true): Promise<AppNotification | null> {
    return this.repo.markRead(id, read);
  }

  markAllRead(): Promise<number> {
    return this.repo.markAllRead();
  }

  remove(id: number): Promise<boolean> {
    return this.repo.delete(id);
  }

  clear(): Promise<number> {
    return this.repo.deleteAll();
  }

  /** Subscribe to freshly created notifications (used for live UI updates). */
  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(notification: AppNotification): void {
    for (const listener of this.listeners) {
      try {
        listener(notification);
      } catch (err) {
        this.log.warn('Notification listener threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

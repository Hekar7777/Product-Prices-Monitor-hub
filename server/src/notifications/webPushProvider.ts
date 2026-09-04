import webpush from 'web-push';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import type { PushSubscriptionRepository } from '../repositories/pushSubscriptionRepository.js';
import type { DeliveryResult, NotificationMessage, NotificationProvider } from './types.js';

/**
 * Web Push notification channel.
 *
 * Implements the same `NotificationProvider` interface every other channel
 * does (see `notifications/types.ts`) - `NotificationService` calls `send()`
 * once per detected price change and persists one `notifications` row per
 * delivery, exactly like the in-app (and previously Telegram) provider.
 * Nothing in the price comparison/trigger logic is aware this channel exists.
 *
 * There is no per-subscription product list: every browser that has ever
 * enabled notifications receives every price-change message for the single
 * shared product list, mirroring the previous Telegram behaviour.
 *
 * Delivery uses the `web-push` library (VAPID authentication + payload
 * encryption per the Web Push protocol). The VAPID private key never leaves
 * this process - it lives only in `env.vapidPrivateKey`, read from the
 * server's own environment.
 */
export class WebPushNotificationProvider implements NotificationProvider {
  readonly channel = 'web_push';

  private readonly log = logger.child({ component: 'notifications.webPush' });
  private vapidConfigured = false;

  constructor(private readonly subscriptions: PushSubscriptionRepository) {}

  isEnabled(): boolean {
    return Boolean(env.vapidPublicKey && env.vapidPrivateKey);
  }

  private ensureVapidConfigured(): void {
    if (this.vapidConfigured) return;
    // Configuring is cheap and idempotent; done lazily so a process with the
    // channel disabled never touches the `web-push` module's global state.
    webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey!, env.vapidPrivateKey!);
    this.vapidConfigured = true;
  }

  /**
   * Sends `message` to every stored subscription.
   *
   * Reports overall success only if every subscription received the
   * message. A subscription-specific failure does not stop delivery to the
   * others. Expired/invalid subscriptions (HTTP 404/410, per the Web Push
   * protocol's meaning for "this endpoint no longer exists") are removed
   * from storage as a side effect of sending, so the list of subscriptions
   * self-cleans over time without a separate sweep.
   */
  async send(message: NotificationMessage): Promise<DeliveryResult> {
    if (!this.isEnabled()) {
      return { ok: false, error: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not configured.' };
    }
    this.ensureVapidConfigured();

    const subs = await this.subscriptions.list();
    if (subs.length === 0) {
      // Nothing to deliver to yet is not a failure - mirrors the in-app and
      // previous Telegram providers' "always ok when nothing to send" behaviour.
      return { ok: true };
    }

    const payload = JSON.stringify({
      title: message.title,
      body: message.message,
      type: message.type,
      data: message.payload,
    });

    const failures: string[] = [];
    let expiredRemoved = 0;

    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            payload,
          );
        } catch (err) {
          const statusCode = (err as { statusCode?: number } | null)?.statusCode;

          // 404 (Not Found) / 410 (Gone): the push service has confirmed this
          // endpoint will never accept another message. Removing it here
          // keeps the subscription list self-cleaning - see task requirement
          // "expired subscriptions must be removed from Supabase".
          if (statusCode === 404 || statusCode === 410) {
            try {
              await this.subscriptions.removeByEndpoint(sub.endpoint);
              expiredRemoved += 1;
            } catch (removeErr) {
              this.log.warn('Failed to remove an expired push subscription', {
                endpoint: redactEndpoint(sub.endpoint),
                error: removeErr instanceof Error ? removeErr.message : String(removeErr),
              });
            }
            // An expired subscription is not counted as a delivery failure -
            // there was nobody to fail to deliver to.
            return;
          }

          const detail = err instanceof Error ? err.message : String(err);
          failures.push(`${redactEndpoint(sub.endpoint)}: ${detail}`);
        }
      }),
    );

    if (expiredRemoved > 0) {
      this.log.info('Removed expired push subscriptions', { count: expiredRemoved });
    }

    if (failures.length === 0) return { ok: true };

    this.log.warn('Some Web Push deliveries failed', {
      failed: failures.length,
      total: subs.length,
    });

    return {
      ok: false,
      error: `${failures.length}/${subs.length} Web Push deliveries failed: ${failures
        .slice(0, 3)
        .join('; ')}`,
    };
  }
}

/** Never log a full push endpoint URL - it is a bearer-token-equivalent secret. */
function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.origin}/…`;
  } catch {
    return '(invalid endpoint)';
  }
}

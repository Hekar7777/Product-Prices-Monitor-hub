import { Router } from 'express';
import { z } from 'zod';
import type { AppContainer } from '../../app/container.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors.js';
import { asyncHandler } from '../middleware.js';

/**
 * Web Push subscription management.
 *
 * The frontend's "Enable Notifications" control:
 *   1. GETs `/vapid-public-key` to configure `pushManager.subscribe()`.
 *   2. Registers the service worker and creates a `PushSubscription`.
 *   3. POSTs the subscription here to store it.
 *
 * Disabling notifications DELETEs the same subscription by endpoint.
 *
 * There is no authentication on this API (see `createApp.ts`'s security
 * note - this is a single-user local tool by design), so anyone who can
 * reach the API can register a subscription. That is an accepted trade-off
 * consistent with every other route in this application.
 */
const subscriptionSchema = z.object({
  endpoint: z.string().trim().url('endpoint must be a valid URL.'),
  keys: z.object({
    p256dh: z.string().trim().min(1, 'keys.p256dh is required.'),
    auth: z.string().trim().min(1, 'keys.auth is required.'),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().trim().url('endpoint must be a valid URL.'),
});

export function createPushSubscriptionsRouter(container: AppContainer): Router {
  const router = Router();

  /** Public key the frontend passes to `pushManager.subscribe()`. Never the private key. */
  router.get(
    '/vapid-public-key',
    asyncHandler(async (_req, res) => {
      if (!env.vapidPublicKey) {
        throw AppError.internal(
          'VAPID_PUBLIC_KEY is not configured on the server; Web Push is disabled.',
        );
      }
      res.json({ publicKey: env.vapidPublicKey });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const parsed = subscriptionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw AppError.badRequest(
          parsed.error.issues[0]?.message ?? 'A valid PushSubscription payload is required.',
        );
      }

      await container.repositories.pushSubscriptions.save({
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
      });

      res.status(201).json({ ok: true });
    }),
  );

  router.delete(
    '/',
    asyncHandler(async (req, res) => {
      const parsed = unsubscribeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw AppError.badRequest(
          parsed.error.issues[0]?.message ?? 'An "endpoint" field is required.',
        );
      }

      await container.repositories.pushSubscriptions.removeByEndpoint(parsed.data.endpoint);
      res.status(204).end();
    }),
  );

  return router;
}

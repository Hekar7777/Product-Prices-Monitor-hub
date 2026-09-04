import { Router } from 'express';
import type { AppContainer } from '../../app/container.js';
import { env } from '../../config/env.js';
import { asyncHandler } from '../middleware.js';

/**
 * Settings API.
 *
 * Exposes only operational knobs: interval, global enable, concurrency,
 * timeout, retries, notification channels and log retention.
 *
 * There is deliberately no target price, price threshold or minimum discount
 * setting - the app notifies on every change, so there is nothing to tune.
 */
export function createSettingsRouter(container: AppContainer): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json({
        settings: container.settings.getAll(),
        updatedAt: await container.settings.updatedAt(),
        scheduler: container.scheduler.status(),
        notifications: {
          registeredChannels: container.notifications.channels(),
          enabledChannels: container.notifications.enabledChannels(),
        },
        extraction: {
          strategy: env.fetchStrategy,
          fetcher: container.fetcher.name,
          playwrightHeadless: env.playwrightHeadless,
        },
      });
    }),
  );

  router.patch(
    '/',
    asyncHandler(async (req, res) => {
      const settings = await container.settings.update(req.body ?? {});
      res.json({
        settings,
        updatedAt: await container.settings.updatedAt(),
        scheduler: container.scheduler.status(),
      });
    }),
  );

  return router;
}

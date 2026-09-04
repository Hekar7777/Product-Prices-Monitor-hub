import { Router } from 'express';
import type { AppContainer } from '../app/container.js';
import { createCronRouter } from './routes/cron.js';
import { createNotificationsRouter } from './routes/notifications.js';
import { createProductsRouter } from './routes/products.js';
import { createPushSubscriptionsRouter } from './routes/pushSubscriptions.js';
import { createSettingsRouter } from './routes/settings.js';
import { createSystemRouter } from './routes/system.js';

/** Mounts every API route under a single router. */
export function createApiRouter(container: AppContainer): Router {
  const router = Router();

  router.use('/products', createProductsRouter(container));
  router.use('/notifications', createNotificationsRouter(container));
  router.use('/settings', createSettingsRouter(container));
  router.use('/cron', createCronRouter(container));
  router.use('/push-subscriptions', createPushSubscriptionsRouter(container));
  router.use('/', createSystemRouter(container));

  return router;
}

export { errorHandler, notFoundHandler, requestLogger } from './middleware.js';

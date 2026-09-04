import { Router } from 'express';
import type { AppContainer } from '../../app/container.js';
import { AppError } from '../../errors.js';
import { asyncHandler, intQuery, requireIdParam } from '../middleware.js';
import { serializeNotification } from '../serializers.js';

/**
 * In-app notification feed.
 *
 * Every row here was created by a genuine price change. There is no concept of
 * a target price or threshold, so there is nothing to configure per product.
 */
export function createNotificationsRouter(container: AppContainer): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const unreadOnly = req.query.unread === 'true' || req.query.unread === '1';
      const limit = intQuery(req, 'limit', 50, 1, 200);
      const offset = intQuery(req, 'offset', 0, 0, 100_000);
      const productId = req.query.productId ? Number(req.query.productId) : undefined;

      const notifications = await container.notifications.list({
        unreadOnly,
        limit,
        offset,
        ...(productId && Number.isInteger(productId) ? { productId } : {}),
      });

      const [unreadCount, total] = await Promise.all([
        container.notifications.unreadCount(),
        container.notifications.total(),
      ]);

      res.json({
        notifications: notifications.map(serializeNotification),
        unreadCount,
        total,
        channels: container.notifications.enabledChannels(),
      });
    }),
  );

  router.post(
    '/read-all',
    asyncHandler(async (_req, res) => {
      const updated = await container.notifications.markAllRead();
      res.json({ updated, unreadCount: await container.notifications.unreadCount() });
    }),
  );

  router.post(
    '/:id/read',
    asyncHandler(async (req, res) => {
      const id = requireIdParam(req);
      const notification = await container.notifications.markRead(id, true);
      if (!notification) throw AppError.notFound(`Notification ${id} was not found.`);
      res.json({
        notification: serializeNotification(notification),
        unreadCount: await container.notifications.unreadCount(),
      });
    }),
  );

  router.post(
    '/:id/unread',
    asyncHandler(async (req, res) => {
      const id = requireIdParam(req);
      const notification = await container.notifications.markRead(id, false);
      if (!notification) throw AppError.notFound(`Notification ${id} was not found.`);
      res.json({
        notification: serializeNotification(notification),
        unreadCount: await container.notifications.unreadCount(),
      });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = requireIdParam(req);
      if (!(await container.notifications.remove(id))) {
        throw AppError.notFound(`Notification ${id} was not found.`);
      }
      res.status(204).end();
    }),
  );

  router.delete(
    '/',
    asyncHandler(async (_req, res) => {
      const removed = await container.notifications.clear();
      res.json({ removed });
    }),
  );

  return router;
}

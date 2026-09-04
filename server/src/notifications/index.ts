export type {
  DeliveryResult,
  NotificationMessage,
  NotificationProvider,
  PriceChangeEvent,
} from './types.js';
export { buildPriceChangeMessage, formatPercent } from './format.js';
export { InAppNotificationProvider } from './inAppProvider.js';
export { WebPushNotificationProvider } from './webPushProvider.js';
export { NotificationService } from './notificationService.js';
export type { NotificationListener } from './notificationService.js';

/*
 * Adding another channel: implement `NotificationProvider` (see
 * `WebPushNotificationProvider` for a worked example) and register it with
 * `notificationService.register(new YourProvider())`. Nothing else changes -
 * `NotificationService` persists a `notifications` row per channel, and the
 * price-comparison/trigger logic stays untouched.
 */

import type { Db } from '../db/index.js';
import { CheckLogRepository } from './checkLogRepository.js';
import { NotificationRepository } from './notificationRepository.js';
import { PriceChangeRepository } from './priceChangeRepository.js';
import { PriceHistoryRepository } from './priceHistoryRepository.js';
import { ProductRepository } from './productRepository.js';
import { PushSubscriptionRepository } from './pushSubscriptionRepository.js';
import { SettingsRepository } from './settingsRepository.js';

export { CheckLogRepository } from './checkLogRepository.js';
export { NotificationRepository } from './notificationRepository.js';
export { PriceChangeRepository } from './priceChangeRepository.js';
export { PriceHistoryRepository } from './priceHistoryRepository.js';
export { ProductRepository } from './productRepository.js';
export { PushSubscriptionRepository } from './pushSubscriptionRepository.js';
export { SettingsRepository } from './settingsRepository.js';

export type { CreateProductInput, ProductPatch, ListProductsOptions, ProductSort } from './productRepository.js';
export type {
  CreatePriceHistoryInput,
  HistoryAggregate,
  HistoryRangeOptions,
} from './priceHistoryRepository.js';
export type { CreatePriceChangeInput, ListPriceChangesOptions } from './priceChangeRepository.js';
export type {
  CreateNotificationInput,
  ListNotificationsOptions,
} from './notificationRepository.js';
export type { CreateCheckLogInput, ListCheckLogsOptions } from './checkLogRepository.js';
export type {
  PushSubscriptionRecord,
  SavePushSubscriptionInput,
} from './pushSubscriptionRepository.js';

export interface Repositories {
  products: ProductRepository;
  priceHistory: PriceHistoryRepository;
  priceChanges: PriceChangeRepository;
  notifications: NotificationRepository;
  checkLogs: CheckLogRepository;
  settings: SettingsRepository;
  pushSubscriptions: PushSubscriptionRepository;
}

export function createRepositories(db: Db): Repositories {
  return {
    products: new ProductRepository(db),
    priceHistory: new PriceHistoryRepository(db),
    priceChanges: new PriceChangeRepository(db),
    notifications: new NotificationRepository(db),
    checkLogs: new CheckLogRepository(db),
    settings: new SettingsRepository(db),
    pushSubscriptions: new PushSubscriptionRepository(db),
  };
}

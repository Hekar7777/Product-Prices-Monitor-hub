import type { SettingsService } from '../services/settingsService.js';
import type { DeliveryResult, NotificationProvider } from './types.js';

/**
 * In-app notifications - the only provider shipped in v1.
 *
 * Delivery for this channel *is* the persisted `notifications` row that
 * `NotificationService` writes, which the dashboard then reads. There is no
 * outbound I/O to perform, so `send()` simply reports success.
 */
export class InAppNotificationProvider implements NotificationProvider {
  readonly channel = 'in_app';

  constructor(private readonly settings: SettingsService) {}

  isEnabled(): boolean {
    return this.settings.get('notifyInApp');
  }

  async send(): Promise<DeliveryResult> {
    return { ok: true };
  }
}

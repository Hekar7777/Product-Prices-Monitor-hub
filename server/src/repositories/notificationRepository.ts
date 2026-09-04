import type { Db } from '../db/index.js';
import type {
  AppNotification,
  DeliveryStatus,
  NotificationPayload,
  NotificationType,
} from '../domain/types.js';
import { mapNotification, toInt } from './mappers.js';
import { assertNoError } from './supabaseHelpers.js';

export interface CreateNotificationInput {
  productId: number | null;
  priceChangeId: number | null;
  channel: string;
  type: NotificationType;
  title: string;
  message: string;
  payload: NotificationPayload | null;
  deliveryStatus?: DeliveryStatus;
  deliveryError?: string | null;
  createdAt?: string;
}

export interface ListNotificationsOptions {
  unreadOnly?: boolean;
  productId?: number;
  channel?: string;
  limit?: number;
  offset?: number;
}

export class NotificationRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreateNotificationInput): Promise<AppNotification> {
    const { data, error } = await this.db.client
      .from('notifications')
      .insert({
        product_id: input.productId,
        price_change_id: input.priceChangeId,
        channel: input.channel,
        type: input.type,
        title: input.title,
        message: input.message,
        payload: input.payload ? JSON.stringify(input.payload) : null,
        read: false,
        delivery_status: input.deliveryStatus ?? 'delivered',
        delivery_error: input.deliveryError ?? null,
        created_at: input.createdAt ?? new Date().toISOString(),
      })
      .select()
      .single();

    assertNoError(error, 'notifications.create');
    return mapNotification(data as Record<string, unknown>);
  }

  async findById(id: number): Promise<AppNotification | null> {
    const { data, error } = await this.db.client
      .from('notifications')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    assertNoError(error, 'notifications.findById');
    return data ? mapNotification(data as Record<string, unknown>) : null;
  }

  async list(options: ListNotificationsOptions = {}): Promise<AppNotification[]> {
    let query = this.db.client.from('notifications').select('*');

    if (options.unreadOnly) query = query.eq('read', false);
    if (options.productId !== undefined) query = query.eq('product_id', options.productId);
    if (options.channel) query = query.eq('channel', options.channel);

    query = query.order('created_at', { ascending: false }).order('id', { ascending: false });

    if (options.limit !== undefined) {
      const offset = options.offset ?? 0;
      query = query.range(offset, offset + options.limit - 1);
    }

    const { data, error } = await query;
    assertNoError(error, 'notifications.list');
    return (data ?? []).map((row) => mapNotification(row as Record<string, unknown>));
  }

  async countByPriceChange(priceChangeId: number): Promise<number> {
    const { count, error } = await this.db.client
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('price_change_id', priceChangeId);

    assertNoError(error, 'notifications.countByPriceChange');
    return toInt(count ?? 0);
  }

  /**
   * Guards against emitting the same notification twice for one price change,
   * e.g. if a check is somehow processed more than once.
   */
  async existsForPriceChange(priceChangeId: number, channel: string): Promise<boolean> {
    const { count, error } = await this.db.client
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('price_change_id', priceChangeId)
      .eq('channel', channel);

    assertNoError(error, 'notifications.existsForPriceChange');
    return toInt(count ?? 0) > 0;
  }

  async unreadCount(): Promise<number> {
    const { count, error } = await this.db.client
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('read', false);

    assertNoError(error, 'notifications.unreadCount');
    return toInt(count ?? 0);
  }

  async total(): Promise<number> {
    const { count, error } = await this.db.client
      .from('notifications')
      .select('*', { count: 'exact', head: true });

    assertNoError(error, 'notifications.total');
    return toInt(count ?? 0);
  }

  async markRead(id: number, read = true): Promise<AppNotification | null> {
    const { data, error } = await this.db.client
      .from('notifications')
      .update({ read })
      .eq('id', id)
      .select()
      .maybeSingle();

    assertNoError(error, 'notifications.markRead');
    return data ? mapNotification(data as Record<string, unknown>) : null;
  }

  async markAllRead(): Promise<number> {
    const { data, error } = await this.db.client
      .from('notifications')
      .update({ read: true })
      .eq('read', false)
      .select('id');

    assertNoError(error, 'notifications.markAllRead');
    return data?.length ?? 0;
  }

  async delete(id: number): Promise<boolean> {
    const { data, error } = await this.db.client
      .from('notifications')
      .delete()
      .eq('id', id)
      .select('id');

    assertNoError(error, 'notifications.delete');
    return (data?.length ?? 0) > 0;
  }

  async deleteAll(): Promise<number> {
    // Supabase requires a filter on delete; `id > 0` matches every row since
    // ids are a positive identity sequence.
    const { data, error } = await this.db.client
      .from('notifications')
      .delete()
      .gt('id', 0)
      .select('id');

    assertNoError(error, 'notifications.deleteAll');
    return data?.length ?? 0;
  }
}

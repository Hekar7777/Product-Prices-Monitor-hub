import type { Db } from '../db/index.js';
import { assertNoError } from './supabaseHelpers.js';

export interface PushSubscriptionRecord {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavePushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function mapPushSubscription(row: Record<string, unknown>): PushSubscriptionRecord {
  return {
    id: Number(row.id),
    endpoint: String(row.endpoint),
    p256dh: String(row.p256dh),
    auth: String(row.auth),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Web Push subscriptions.
 *
 * A subscription is created client-side (Service Worker + Push API) the
 * moment a user clicks "Enable Notifications" and grants permission, then
 * POSTed to the backend (see `api/routes/pushSubscriptions.ts`). There is no
 * per-subscription product list - every subscription receives every
 * price-change notification, mirroring the previous Telegram behaviour.
 *
 * Upserting on `endpoint` keeps re-enabling notifications from the same
 * browser idempotent instead of accumulating duplicate rows (a browser hands
 * out a stable endpoint per subscription and only issues a new one if the
 * old one is invalidated).
 */
export class PushSubscriptionRepository {
  constructor(private readonly db: Db) {}

  /** Creates or refreshes a subscription. Idempotent per `endpoint`. */
  async save(input: SavePushSubscriptionInput): Promise<PushSubscriptionRecord> {
    const now = new Date().toISOString();

    const { data, error } = await this.db.client
      .from('web_push_subscriptions')
      .upsert(
        {
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
          created_at: now,
          updated_at: now,
        },
        { onConflict: 'endpoint' },
      )
      .select()
      .single();

    assertNoError(error, 'web_push_subscriptions.save');
    return mapPushSubscription(data as Record<string, unknown>);
  }

  async list(): Promise<PushSubscriptionRecord[]> {
    const { data, error } = await this.db.client.from('web_push_subscriptions').select('*');
    assertNoError(error, 'web_push_subscriptions.list');
    return (data ?? []).map((row) => mapPushSubscription(row as Record<string, unknown>));
  }

  async removeByEndpoint(endpoint: string): Promise<boolean> {
    const { data, error } = await this.db.client
      .from('web_push_subscriptions')
      .delete()
      .eq('endpoint', endpoint)
      .select('id');

    assertNoError(error, 'web_push_subscriptions.removeByEndpoint');
    return (data?.length ?? 0) > 0;
  }

  async count(): Promise<number> {
    const { count, error } = await this.db.client
      .from('web_push_subscriptions')
      .select('*', { count: 'exact', head: true });

    assertNoError(error, 'web_push_subscriptions.count');
    return count ?? 0;
  }
}

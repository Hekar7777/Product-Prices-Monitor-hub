import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPriceChangeMessage } from '../src/notifications/format.js';
import type { DeliveryResult, NotificationProvider } from '../src/notifications/types.js';
import type { PriceChange, Product } from '../src/domain/types.js';
import { TEST_URL } from './helpers/fakeFetcher.js';
import { countRows, createHarness, type TestHarness } from './helpers/testApp.js';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 1,
    url: 'https://www.flipkart.com/x/p/itmabc',
    canonicalKey: 'pid:X',
    productName: 'iPhone 16',
    imageUrl: null,
    currency: 'INR',
    currentPrice: 67999,
    previousPrice: 69999,
    lowestPrice: 67999,
    highestPrice: 69999,
    mrp: null,
    availability: 'In Stock',
    seller: null,
    monitoringEnabled: true,
    priceChangeCount: 1,
    consecutiveFailures: 0,
    lastStatus: 'ok',
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: '2026-08-30T12:00:00.000Z',
    updatedAt: '2026-08-30T14:00:00.000Z',
    lastCheckedAt: '2026-08-30T14:00:00.000Z',
    lastAttemptedAt: '2026-08-30T14:00:00.000Z',
    lastPriceChangeAt: '2026-08-30T14:00:00.000Z',
    ...overrides,
  };
}

function change(overrides: Partial<PriceChange> = {}): PriceChange {
  return {
    id: 1,
    productId: 1,
    priceHistoryId: 1,
    oldPrice: 69999,
    newPrice: 67999,
    absoluteChange: 2000,
    percentageChange: 2.86,
    direction: 'down',
    currency: 'INR',
    detectedAt: '2026-08-30T14:00:00.000Z',
    ...overrides,
  };
}

describe('buildPriceChangeMessage', () => {
  it('renders a drop exactly as specified', () => {
    const message = buildPriceChangeMessage({ product: product(), change: change() });

    expect(message.title).toBe('Price dropped');
    expect(message.type).toBe('price_drop');
    expect(message.message).toBe('iPhone 16\n₹69,999 → ₹67,999\n↓ ₹2,000 (2.86%)');
  });

  it('renders an increase exactly as specified', () => {
    const message = buildPriceChangeMessage({
      product: product({ currentPrice: 70999, previousPrice: 67999 }),
      change: change({
        oldPrice: 67999,
        newPrice: 70999,
        absoluteChange: 3000,
        percentageChange: 4.41,
        direction: 'up',
      }),
    });

    expect(message.title).toBe('Price increased');
    expect(message.type).toBe('price_increase');
    expect(message.message).toBe('iPhone 16\n₹67,999 → ₹70,999\n↑ ₹3,000 (4.41%)');
  });

  it('includes machine-readable data so clients need not parse the text', () => {
    const message = buildPriceChangeMessage({ product: product(), change: change() });

    expect(message.payload).toEqual({
      productId: 1,
      productName: 'iPhone 16',
      imageUrl: null,
      url: 'https://www.flipkart.com/x/p/itmabc',
      currency: 'INR',
      oldPrice: 69999,
      newPrice: 67999,
      absoluteChange: 2000,
      percentageChange: 2.86,
      direction: 'down',
      detectedAt: '2026-08-30T14:00:00.000Z',
    });
  });

  it('drops a trailing .00 from whole percentages', () => {
    const message = buildPriceChangeMessage({
      product: product(),
      change: change({ oldPrice: 1000, newPrice: 500, absoluteChange: 500, percentageChange: 50 }),
    });
    expect(message.message).toContain('(50%)');
  });
});

describe('NotificationService', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('creates one unread in-app notification per price change', async () => {
    const p = await harness.container.products.addProduct(TEST_URL);

    harness.fetcher.setPrice(67999);
    await harness.container.monitor.checkProduct(p.id);
    harness.fetcher.setPrice(70999);
    await harness.container.monitor.checkProduct(p.id);

    const notifications = await harness.container.notifications.list({});
    expect(notifications).toHaveLength(2);
    expect(await harness.container.notifications.unreadCount()).toBe(2);

    // Newest first.
    expect(notifications[0]?.title).toBe('Price increased');
    expect(notifications[1]?.title).toBe('Price dropped');
    for (const notification of notifications) {
      expect(notification.deliveryStatus).toBe('delivered');
      expect(notification.priceChangeId).not.toBeNull();
      expect(notification.productId).toBe(p.id);
    }
  });

  it('does not create a second notification for the same change', async () => {
    const p = await harness.container.products.addProduct(TEST_URL);
    harness.fetcher.setPrice(67999);
    const result = await harness.container.monitor.checkProduct(p.id);

    const priceChange = result.change!;
    const again = await harness.container.notifications.notifyPriceChange({
      product: await harness.container.products.getById(p.id),
      change: priceChange,
    });

    expect(again).toHaveLength(0);
    expect(await countRows(harness.container, 'notifications')).toBe(1);
  });

  it('creates no notification when the in-app channel is disabled', async () => {
    const p = await harness.container.products.addProduct(TEST_URL);
    await harness.container.settings.update({ notifyInApp: false });

    harness.fetcher.setPrice(67999);
    const result = await harness.container.monitor.checkProduct(p.id);

    // The change is still recorded - only the notification is suppressed.
    expect(result.kind).toBe('changed');
    expect(result.change).not.toBeNull();
    expect(result.notifications).toHaveLength(0);
    expect(await countRows(harness.container, 'price_changes')).toBe(1);
    expect(await countRows(harness.container, 'notifications')).toBe(0);
  });

  it('marks notifications as read', async () => {
    const p = await harness.container.products.addProduct(TEST_URL);
    harness.fetcher.setPrice(67999);
    await harness.container.monitor.checkProduct(p.id);

    const [notification] = await harness.container.notifications.list({});
    const updated = await harness.container.notifications.markRead(notification!.id);

    expect(updated?.read).toBe(true);
    expect(await harness.container.notifications.unreadCount()).toBe(0);
    expect(await harness.container.notifications.list({ unreadOnly: true })).toHaveLength(0);
  });

  it('marks every notification as read at once', async () => {
    const p = await harness.container.products.addProduct(TEST_URL);
    for (const price of [67999, 66999, 65999]) {
      harness.fetcher.setPrice(price);
      await harness.container.monitor.checkProduct(p.id);
    }

    expect(await harness.container.notifications.markAllRead()).toBe(3);
    expect(await harness.container.notifications.unreadCount()).toBe(0);
  });

  it('emits created notifications to subscribers', async () => {
    const seen: string[] = [];
    harness.container.notifications.onNotification((notification) => {
      seen.push(notification.title);
    });

    const p = await harness.container.products.addProduct(TEST_URL);
    harness.fetcher.setPrice(67999);
    await harness.container.monitor.checkProduct(p.id);

    expect(seen).toEqual(['Price dropped']);
  });
});

describe('additional notification providers', () => {
  it('fans a change out to every enabled provider and records each delivery', async () => {
    const sent: string[] = [];

    // Channel name is deliberately not "web_push" - the container already
    // registers the real WebPushNotificationProvider, and channel names must
    // be unique per NotificationService instance.
    class RecordingProvider implements NotificationProvider {
      readonly channel = 'custom-webhook';
      isEnabled(): boolean {
        return true;
      }
      async send(message: { message: string }): Promise<DeliveryResult> {
        sent.push(message.message);
        return { ok: true };
      }
    }

    const harness = await createHarness();
    harness.container.notifications.register(new RecordingProvider());

    try {
      const p = await harness.container.products.addProduct(TEST_URL);
      harness.fetcher.setPrice(67999);
      const result = await harness.container.monitor.checkProduct(p.id);

      // in_app fires; web_push is registered but has no subscriptions yet,
      // so it delivers successfully with nothing to send and is not asserted
      // on here; the custom double is what this test cares about.
      expect(result.notifications.map((n) => n.channel)).toContain('custom-webhook');
      expect(sent).toEqual(['iPhone 16\n₹69,999 → ₹67,999\n↓ ₹2,000 (2.86%)']);
    } finally {
      await harness.dispose();
    }
  });

  it('records a failed delivery without failing the check', async () => {
    class BrokenProvider implements NotificationProvider {
      readonly channel = 'email';
      isEnabled(): boolean {
        return true;
      }
      async send(): Promise<DeliveryResult> {
        throw new Error('SMTP unavailable');
      }
    }

    const harness = await createHarness();
    harness.container.notifications.register(new BrokenProvider());

    try {
      const p = await harness.container.products.addProduct(TEST_URL);
      harness.fetcher.setPrice(67999);
      const result = await harness.container.monitor.checkProduct(p.id);

      // The price change itself succeeded.
      expect(result.kind).toBe('changed');

      const email = result.notifications.find((n) => n.channel === 'email');
      expect(email?.deliveryStatus).toBe('failed');
      expect(email?.deliveryError).toContain('SMTP unavailable');

      // The in-app channel was unaffected by the broken provider.
      const inApp = result.notifications.find((n) => n.channel === 'in_app');
      expect(inApp?.deliveryStatus).toBe('delivered');
    } finally {
      await harness.dispose();
    }
  });

  it('skips providers that are not configured', async () => {
    class DisabledProvider implements NotificationProvider {
      readonly channel = 'webhook';
      isEnabled(): boolean {
        return false;
      }
      async send(): Promise<DeliveryResult> {
        throw new Error('must not be called');
      }
    }

    const harness = await createHarness();
    harness.container.notifications.register(new DisabledProvider());

    try {
      expect(harness.container.notifications.channels()).toContain('webhook');
      expect(harness.container.notifications.enabledChannels()).not.toContain('webhook');

      const p = await harness.container.products.addProduct(TEST_URL);
      harness.fetcher.setPrice(67999);
      const result = await harness.container.monitor.checkProduct(p.id);

      expect(result.notifications.map((n) => n.channel)).toEqual(['in_app']);
    } finally {
      await harness.dispose();
    }
  });
});

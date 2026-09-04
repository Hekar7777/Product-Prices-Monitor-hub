import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `server/src/config/env.ts` reads `process.env` once, at module-load time.
 * To control `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` per test without them
 * leaking into every other test file, this file sets them on `process.env`
 * *before* dynamically importing anything that transitively reaches
 * `env.ts` - exactly the pattern `scripts/e2eVerify.ts` documents for
 * `CRON_SECRET`. Static top-level imports would already have resolved
 * `env.ts` with whatever `process.env` looked like at process start, so
 * every import used here is a dynamic `import()` inside a `beforeEach`.
 */

const sendNotification = vi.fn();
const setVapidDetails = vi.fn();

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}));

type WebPushModule = typeof import('../src/notifications/webPushProvider.js');
type ReposModule = typeof import('../src/repositories/pushSubscriptionRepository.js');
type FakeDbModule = typeof import('./helpers/fakeSupabase.js');

async function loadWithVapid(publicKey: string | null, privateKey: string | null) {
  if (publicKey === null) delete process.env.VAPID_PUBLIC_KEY;
  else process.env.VAPID_PUBLIC_KEY = publicKey;

  if (privateKey === null) delete process.env.VAPID_PRIVATE_KEY;
  else process.env.VAPID_PRIVATE_KEY = privateKey;

  vi.resetModules();

  const { WebPushNotificationProvider }: WebPushModule = await import(
    '../src/notifications/webPushProvider.js'
  );
  const { PushSubscriptionRepository }: ReposModule = await import(
    '../src/repositories/pushSubscriptionRepository.js'
  );
  const { createFakeSupabaseDb }: FakeDbModule = await import('./helpers/fakeSupabase.js');

  const db = createFakeSupabaseDb();
  const repo = new PushSubscriptionRepository(db);
  const provider = new WebPushNotificationProvider(repo);
  return { provider, repo };
}

function message() {
  return {
    type: 'price_drop' as const,
    title: 'Price dropped',
    message: 'iPhone 16\n₹69,999 → ₹67,999\n↓ ₹2,000 (2.86%)',
    payload: {
      productId: 1,
      productName: 'iPhone 16',
      imageUrl: null,
      url: 'https://www.flipkart.com/x/p/itmabc',
      currency: 'INR',
      oldPrice: 69999,
      newPrice: 67999,
      absoluteChange: 2000,
      percentageChange: 2.86,
      direction: 'down' as const,
      detectedAt: '2026-08-30T14:00:00.000Z',
    },
  };
}

describe('WebPushNotificationProvider', () => {
  beforeEach(() => {
    sendNotification.mockReset();
    setVapidDetails.mockReset();
  });

  afterEach(() => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    vi.resetModules();
  });

  it('is disabled when VAPID keys are not configured', async () => {
    const { provider } = await loadWithVapid(null, null);
    expect(provider.isEnabled()).toBe(false);

    const result = await provider.send(message());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/VAPID/);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('is enabled once both VAPID keys are configured', async () => {
    const { provider } = await loadWithVapid('public-key', 'private-key');
    expect(provider.isEnabled()).toBe(true);
  });

  it('reports success with nothing sent when there are no subscriptions', async () => {
    const { provider } = await loadWithVapid('public-key', 'private-key');
    const result = await provider.send(message());
    expect(result).toEqual({ ok: true });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('delivers the rendered message to every stored subscription', async () => {
    const { provider, repo } = await loadWithVapid('public-key', 'private-key');
    await repo.save({ endpoint: 'https://push.example/a', p256dh: 'p1', auth: 'a1' });
    await repo.save({ endpoint: 'https://push.example/b', p256dh: 'p2', auth: 'a2' });
    sendNotification.mockResolvedValue({ statusCode: 201 });

    const result = await provider.send(message());

    expect(result).toEqual({ ok: true });
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(setVapidDetails).toHaveBeenCalledWith(
      'mailto:admin@example.com',
      'public-key',
      'private-key',
    );

    const [sub, payload] = sendNotification.mock.calls[0]!;
    expect(sub).toEqual({
      endpoint: 'https://push.example/a',
      keys: { p256dh: 'p1', auth: 'a1' },
    });
    const parsed = JSON.parse(payload as string);
    expect(parsed).toMatchObject({
      title: 'Price dropped',
      body: 'iPhone 16\n₹69,999 → ₹67,999\n↓ ₹2,000 (2.86%)',
      type: 'price_drop',
      data: { productId: 1, direction: 'down' },
    });
  });

  it('removes a subscription on HTTP 410 (Gone) and does not count it as a failure', async () => {
    const { provider, repo } = await loadWithVapid('public-key', 'private-key');
    await repo.save({ endpoint: 'https://push.example/expired', p256dh: 'p1', auth: 'a1' });

    sendNotification.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }));

    const result = await provider.send(message());

    expect(result).toEqual({ ok: true });
    expect(await repo.list()).toHaveLength(0);
  });

  it('removes a subscription on HTTP 404 (Not Found)', async () => {
    const { provider, repo } = await loadWithVapid('public-key', 'private-key');
    await repo.save({ endpoint: 'https://push.example/missing', p256dh: 'p1', auth: 'a1' });

    sendNotification.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));

    const result = await provider.send(message());

    expect(result).toEqual({ ok: true });
    expect(await repo.list()).toHaveLength(0);
  });

  it('reports a failure for a non-expiry error without throwing, and keeps the subscription', async () => {
    const { provider, repo } = await loadWithVapid('public-key', 'private-key');
    await repo.save({ endpoint: 'https://push.example/flaky', p256dh: 'p1', auth: 'a1' });

    sendNotification.mockRejectedValue(Object.assign(new Error('server error'), { statusCode: 500 }));

    const result = await provider.send(message());

    expect(result.ok).toBe(false);
    expect(result.error).toContain('server error');
    expect(await repo.list()).toHaveLength(1);
  });

  it('isolates failures per subscription: one bad endpoint does not stop delivery to the others', async () => {
    const { provider, repo } = await loadWithVapid('public-key', 'private-key');
    await repo.save({ endpoint: 'https://push.example/good', p256dh: 'p1', auth: 'a1' });
    await repo.save({ endpoint: 'https://push.example/bad', p256dh: 'p2', auth: 'a2' });

    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith('/bad')) {
        throw Object.assign(new Error('boom'), { statusCode: 500 });
      }
      return { statusCode: 201 };
    });

    const result = await provider.send(message());

    expect(result.ok).toBe(false);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    // The good subscription is untouched and still delivered to.
    expect(await repo.list()).toHaveLength(2);
  });
});

describe('PushSubscriptionRepository', () => {
  it('upserts on endpoint so re-subscribing the same browser does not duplicate rows', async () => {
    const { createFakeSupabaseDb } = await import('./helpers/fakeSupabase.js');
    const { PushSubscriptionRepository } = await import(
      '../src/repositories/pushSubscriptionRepository.js'
    );
    const repo = new PushSubscriptionRepository(createFakeSupabaseDb());

    await repo.save({ endpoint: 'https://push.example/x', p256dh: 'p1', auth: 'a1' });
    await repo.save({ endpoint: 'https://push.example/x', p256dh: 'p2', auth: 'a2' });

    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ p256dh: 'p2', auth: 'a2' });
  });

  it('removes a subscription by endpoint', async () => {
    const { createFakeSupabaseDb } = await import('./helpers/fakeSupabase.js');
    const { PushSubscriptionRepository } = await import(
      '../src/repositories/pushSubscriptionRepository.js'
    );
    const repo = new PushSubscriptionRepository(createFakeSupabaseDb());

    await repo.save({ endpoint: 'https://push.example/x', p256dh: 'p1', auth: 'a1' });
    expect(await repo.removeByEndpoint('https://push.example/x')).toBe(true);
    expect(await repo.list()).toHaveLength(0);
    expect(await repo.removeByEndpoint('https://push.example/x')).toBe(false);
  });
});

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type TestHarness } from './helpers/testApp.js';

describe('POST/DELETE /api/push-subscriptions', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  const agent = () => request(harness.app);

  const validSubscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: { p256dh: 'p256dh-key-value', auth: 'auth-key-value' },
  };

  it('stores a subscription', async () => {
    await agent().post('/api/push-subscriptions').send(validSubscription).expect(201);

    const rows = await harness.container.repositories.pushSubscriptions.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      endpoint: validSubscription.endpoint,
      p256dh: 'p256dh-key-value',
      auth: 'auth-key-value',
    });
  });

  it('is idempotent for the same endpoint (upsert, not duplicate)', async () => {
    await agent().post('/api/push-subscriptions').send(validSubscription).expect(201);
    await agent()
      .post('/api/push-subscriptions')
      .send({ ...validSubscription, keys: { p256dh: 'new-p256dh', auth: 'new-auth' } })
      .expect(201);

    const rows = await harness.container.repositories.pushSubscriptions.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ p256dh: 'new-p256dh', auth: 'new-auth' });
  });

  it('rejects a payload missing keys', async () => {
    const response = await agent()
      .post('/api/push-subscriptions')
      .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc123' })
      .expect(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects a non-URL endpoint', async () => {
    await agent()
      .post('/api/push-subscriptions')
      .send({ endpoint: 'not-a-url', keys: { p256dh: 'x', auth: 'y' } })
      .expect(400);
  });

  it('removes a subscription by endpoint', async () => {
    await agent().post('/api/push-subscriptions').send(validSubscription).expect(201);

    await agent()
      .delete('/api/push-subscriptions')
      .send({ endpoint: validSubscription.endpoint })
      .expect(204);

    expect(await harness.container.repositories.pushSubscriptions.list()).toHaveLength(0);
  });

  it('returns 204 even when deleting an unknown endpoint (idempotent unsubscribe)', async () => {
    await agent()
      .delete('/api/push-subscriptions')
      .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/does-not-exist' })
      .expect(204);
  });

  it('rejects a delete payload without an endpoint', async () => {
    await agent().delete('/api/push-subscriptions').send({}).expect(400);
  });

  it('returns 500 for the VAPID public key endpoint when Web Push is not configured', async () => {
    // The default test harness has no VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY set,
    // matching a deployment that has not configured Web Push yet.
    const response = await agent().get('/api/push-subscriptions/vapid-public-key');
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
  });
});

describe('GET /api/push-subscriptions/vapid-public-key with VAPID configured', () => {
  const originalPublic = process.env.VAPID_PUBLIC_KEY;
  const originalPrivate = process.env.VAPID_PRIVATE_KEY;

  beforeEach(() => {
    process.env.VAPID_PUBLIC_KEY = 'test-public-key';
    process.env.VAPID_PRIVATE_KEY = 'test-private-key';
  });

  afterEach(() => {
    if (originalPublic === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = originalPublic;
    if (originalPrivate === undefined) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = originalPrivate;
  });

  it('exposes the configured public key', async () => {
    // `env.ts` reads process.env once at module load time (see its own
    // comment), and this test file's other describe block already imported
    // it via the static `testApp.ts` import chain above - by the time this
    // test runs, that first import already happened without these vars set.
    // Re-importing here after setting them, in a fresh module registry, lets
    // this one assertion see the "configured" state without affecting the
    // harness-based tests above, which intentionally exercise the
    // "unconfigured" (still valid, still supported) state.
    vi.resetModules();
    const { createApp } = await import('../src/app/createApp.js');
    const { createContainer } = await import('../src/app/container.js');
    const { FakeFlipkartFetcher } = await import('./helpers/fakeFetcher.js');
    const { createFakeSupabaseDb } = await import('./helpers/fakeSupabase.js');

    const container = await createContainer({
      db: createFakeSupabaseDb(),
      fetcher: new FakeFlipkartFetcher(),
    });
    const app = createApp(container);

    const response = await request(app).get('/api/push-subscriptions/vapid-public-key').expect(200);
    expect(response.body).toEqual({ publicKey: 'test-public-key' });

    await container.shutdown();
  });
});

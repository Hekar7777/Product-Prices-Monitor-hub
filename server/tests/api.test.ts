import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_URL, TEST_URL_2 } from './helpers/fakeFetcher.js';
import { createHarness, makeDue, type TestHarness } from './helpers/testApp.js';

describe('HTTP API', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  const agent = () => request(harness.app);

  async function addProduct(url = TEST_URL, price = 69999) {
    harness.fetcher.setPrice(price);
    const response = await agent().post('/api/products').send({ url }).expect(201);
    return response.body.product as { id: number; currentPrice: number; productName: string };
  }

  // --- health ------------------------------------------------------------

  it('reports health', async () => {
    const response = await agent().get('/api/health').expect(200);

    expect(response.body).toMatchObject({ status: 'ok', database: 'ok' });
    expect(response.body.scheduler).toBeDefined();
  });

  it('returns a JSON 404 for an unknown API route', async () => {
    const response = await agent().get('/api/does-not-exist').expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  // --- adding products ---------------------------------------------------

  describe('POST /api/products', () => {
    it('adds a product and returns it with a baseline price', async () => {
      const product = await addProduct();

      expect(product).toMatchObject({
        productName: 'iPhone 16',
        currentPrice: 69999,
        previousPrice: null,
        lowestPrice: 69999,
        highestPrice: 69999,
        monitoringEnabled: true,
        priceChangeCount: 0,
        currentPriceDisplay: '₹69,999',
        latestChange: null,
      });
    });

    it('rejects a non-Flipkart URL with 400', async () => {
      const response = await agent()
        .post('/api/products')
        .send({ url: 'https://www.amazon.in/dp/B0CHX1W1XY' })
        .expect(400);

      expect(response.body.error.code).toBe('BAD_REQUEST');
      expect(response.body.error.message).toMatch(/flipkart/i);
    });

    it('rejects a missing URL with 400', async () => {
      await agent().post('/api/products').send({}).expect(400);
      await agent().post('/api/products').send({ url: '' }).expect(400);
    });

    it('rejects a duplicate with 409', async () => {
      await addProduct();
      const response = await agent().post('/api/products').send({ url: TEST_URL }).expect(409);
      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('returns 422 when the product page cannot be read', async () => {
      harness.fetcher.failAlways('CAPTCHA');

      const response = await agent().post('/api/products').send({ url: TEST_URL }).expect(422);

      expect(response.body.error.code).toBe('UNPROCESSABLE');
      expect(response.body.error.details.code).toBe('CAPTCHA');
    });
  });

  // --- listing -----------------------------------------------------------

  describe('GET /api/products', () => {
    it('lists products with the dashboard overview', async () => {
      await addProduct();
      harness.fetcher.productName = 'Sony Bravia TV';
      await addProduct(TEST_URL_2, 52490);

      const response = await agent().get('/api/products').expect(200);

      expect(response.body.products).toHaveLength(2);
      expect(response.body.overview).toMatchObject({
        totalProducts: 2,
        monitoredProducts: 2,
        pausedProducts: 0,
      });
      expect(response.body.checkingProductIds).toEqual([]);
    });

    it('filters by status and search term', async () => {
      const first = await addProduct();
      harness.fetcher.productName = 'Sony Bravia TV';
      await addProduct(TEST_URL_2, 52490);

      await agent().patch(`/api/products/${first.id}`).send({ monitoringEnabled: false }).expect(200);

      const paused = await agent().get('/api/products?status=paused').expect(200);
      expect(paused.body.products).toHaveLength(1);

      const monitoring = await agent().get('/api/products?status=monitoring').expect(200);
      expect(monitoring.body.products).toHaveLength(1);

      const searched = await agent().get('/api/products?search=sony').expect(200);
      expect(searched.body.products).toHaveLength(1);
      expect(searched.body.products[0].productName).toBe('Sony Bravia TV');
    });
  });

  // --- detail ------------------------------------------------------------

  describe('GET /api/products/:id', () => {
    it('returns the product with statistics', async () => {
      const product = await addProduct();

      harness.fetcher.setPrice(67999);
      await agent().post(`/api/products/${product.id}/check`).expect(200);

      const response = await agent().get(`/api/products/${product.id}`).expect(200);

      expect(response.body.product).toMatchObject({ currentPrice: 67999, previousPrice: 69999 });
      expect(response.body.product.latestChange).toMatchObject({
        oldPrice: 69999,
        newPrice: 67999,
        absoluteChange: 2000,
        percentageChange: 2.86,
        direction: 'down',
        signedChange: -2000,
        display: '↓ ₹2,000 (2.86%)',
      });
      expect(response.body.stats).toMatchObject({
        lowestPrice: 67999,
        highestPrice: 69999,
        totalPriceChanges: 1,
        totalObservations: 2,
      });
    });

    it('returns 404 for an unknown product', async () => {
      const response = await agent().get('/api/products/9999').expect(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 for a malformed id', async () => {
      await agent().get('/api/products/abc').expect(400);
      await agent().get('/api/products/-1').expect(400);
    });
  });

  // --- manual check ------------------------------------------------------

  describe('POST /api/products/:id/check', () => {
    it('reports an unchanged price', async () => {
      const product = await addProduct();

      const response = await agent().post(`/api/products/${product.id}/check`).expect(200);

      expect(response.body.outcome).toBe('unchanged');
      expect(response.body.change).toBeNull();
      expect(response.body.notifications).toBe(0);
    });

    it('reports a detected change and the notification it produced', async () => {
      const product = await addProduct();
      harness.fetcher.setPrice(67999);

      const response = await agent().post(`/api/products/${product.id}/check`).expect(200);

      expect(response.body.outcome).toBe('changed');
      expect(response.body.change).toMatchObject({ direction: 'down', absoluteChange: 2000 });
      expect(response.body.notifications).toBe(1);
    });

    it('reports a failure and keeps the previous price', async () => {
      const product = await addProduct();
      harness.fetcher.failAlways('TIMEOUT');

      const response = await agent().post(`/api/products/${product.id}/check`).expect(200);

      expect(response.body.outcome).toBe('failed');
      expect(response.body.error.code).toBe('TIMEOUT');
      expect(response.body.product.currentPrice).toBe(69999);
      expect(response.body.notifications).toBe(0);
    });

    it('returns 409 when a check is already running', async () => {
      const product = await addProduct();

      harness.fetcher.hold();
      const inFlight = harness.container.monitor.checkProduct(product.id, { trigger: 'scheduler' });

      const response = await agent().post(`/api/products/${product.id}/check`).expect(409);
      expect(response.body.outcome).toBe('skipped');
      expect(response.body.skipReason).toBe('already_running');

      harness.fetcher.release();
      await inFlight;
    });

    it('returns 404 for an unknown product', async () => {
      await agent().post('/api/products/4242/check').expect(404);
    });
  });

  // --- pause / resume / delete -------------------------------------------

  describe('PATCH and DELETE /api/products/:id', () => {
    it('pauses and resumes monitoring', async () => {
      const product = await addProduct();

      const paused = await agent()
        .patch(`/api/products/${product.id}`)
        .send({ monitoringEnabled: false })
        .expect(200);
      expect(paused.body.product.monitoringEnabled).toBe(false);

      const resumed = await agent()
        .patch(`/api/products/${product.id}`)
        .send({ monitoringEnabled: true })
        .expect(200);
      expect(resumed.body.product.monitoringEnabled).toBe(true);
    });

    it('rejects an unknown field or wrong type', async () => {
      const product = await addProduct();

      await agent().patch(`/api/products/${product.id}`).send({ monitoringEnabled: 'yes' }).expect(400);
      // No target price setting exists, so an attempt to set one is refused.
      await agent().patch(`/api/products/${product.id}`).send({ targetPrice: 50000 }).expect(400);
    });

    it('deletes a product', async () => {
      const product = await addProduct();

      await agent().delete(`/api/products/${product.id}`).expect(204);
      await agent().get(`/api/products/${product.id}`).expect(404);

      const list = await agent().get('/api/products').expect(200);
      expect(list.body.products).toHaveLength(0);
    });

    it('returns 404 when deleting twice', async () => {
      const product = await addProduct();
      await agent().delete(`/api/products/${product.id}`).expect(204);
      await agent().delete(`/api/products/${product.id}`).expect(404);
    });
  });

  // --- history -----------------------------------------------------------

  describe('GET /api/products/:id/history', () => {
    it('returns the price series with per-row deltas', async () => {
      const product = await addProduct();

      harness.fetcher.setPrice(67999);
      await agent().post(`/api/products/${product.id}/check`).expect(200);
      harness.fetcher.setPrice(70999);
      await agent().post(`/api/products/${product.id}/check`).expect(200);

      const response = await agent().get(`/api/products/${product.id}/history?range=all`).expect(200);

      expect(response.body.range).toBe('all');
      expect(response.body.points.map((p: { price: number }) => p.price)).toEqual([
        69999, 67999, 70999,
      ]);
      expect(response.body.points[0]).toMatchObject({ isBaseline: true, display: '—', direction: null });
      expect(response.body.points[1]).toMatchObject({ direction: 'down', display: '↓ ₹2,000' });
      expect(response.body.points[2]).toMatchObject({ direction: 'up', display: '↑ ₹3,000' });
    });

    it('accepts every documented range and falls back for an unknown one', async () => {
      const product = await addProduct();

      for (const range of ['24h', '7d', '30d', '3m', 'all']) {
        const response = await agent()
          .get(`/api/products/${product.id}/history?range=${range}`)
          .expect(200);
        expect(response.body.range).toBe(range);
      }

      const fallback = await agent()
        .get(`/api/products/${product.id}/history?range=nonsense`)
        .expect(200);
      expect(fallback.body.range).toBe('all');
    });
  });

  describe('GET /api/products/:id/changes and /logs', () => {
    it('lists detected changes and check attempts', async () => {
      const product = await addProduct();
      harness.fetcher.setPrice(67999);
      await agent().post(`/api/products/${product.id}/check`).expect(200);

      const changes = await agent().get(`/api/products/${product.id}/changes`).expect(200);
      expect(changes.body.changes).toHaveLength(1);

      const logs = await agent().get(`/api/products/${product.id}/logs`).expect(200);
      expect(logs.body.logs).toHaveLength(2); // baseline + the manual check
      expect(logs.body.logs[0].triggerSource).toBe('manual');
    });
  });

  // --- notifications -----------------------------------------------------

  describe('/api/notifications', () => {
    it('exposes the notification created by a price change', async () => {
      const product = await addProduct();
      harness.fetcher.setPrice(67999);
      await agent().post(`/api/products/${product.id}/check`).expect(200);

      const response = await agent().get('/api/notifications').expect(200);

      expect(response.body.unreadCount).toBe(1);
      expect(response.body.total).toBe(1);
      expect(response.body.channels).toContain('in_app');
      expect(response.body.notifications[0]).toMatchObject({
        title: 'Price dropped',
        type: 'price_drop',
        message: 'iPhone 16\n₹69,999 → ₹67,999\n↓ ₹2,000 (2.86%)',
        read: false,
        channel: 'in_app',
      });
    });

    it('marks one and then all notifications as read', async () => {
      const product = await addProduct();
      for (const price of [67999, 66999]) {
        harness.fetcher.setPrice(price);
        await agent().post(`/api/products/${product.id}/check`).expect(200);
      }

      const list = await agent().get('/api/notifications').expect(200);
      const first = list.body.notifications[0];

      const read = await agent().post(`/api/notifications/${first.id}/read`).expect(200);
      expect(read.body.notification.read).toBe(true);
      expect(read.body.unreadCount).toBe(1);

      const all = await agent().post('/api/notifications/read-all').expect(200);
      expect(all.body.unreadCount).toBe(0);

      const unread = await agent().get('/api/notifications?unread=true').expect(200);
      expect(unread.body.notifications).toHaveLength(0);
    });

    it('deletes one and then all notifications', async () => {
      const product = await addProduct();
      for (const price of [67999, 66999]) {
        harness.fetcher.setPrice(price);
        await agent().post(`/api/products/${product.id}/check`).expect(200);
      }

      const list = await agent().get('/api/notifications').expect(200);
      await agent().delete(`/api/notifications/${list.body.notifications[0].id}`).expect(204);

      const cleared = await agent().delete('/api/notifications').expect(200);
      expect(cleared.body.removed).toBe(1);

      const after = await agent().get('/api/notifications').expect(200);
      expect(after.body.total).toBe(0);
    });

    it('returns 404 for an unknown notification', async () => {
      await agent().post('/api/notifications/999/read').expect(404);
      await agent().delete('/api/notifications/999').expect(404);
    });
  });

  // --- settings ----------------------------------------------------------

  describe('/api/settings', () => {
    it('returns the current settings and scheduler status', async () => {
      const response = await agent().get('/api/settings').expect(200);

      expect(response.body.settings).toMatchObject({
        monitorIntervalMinutes: 15,
        monitoringEnabled: true,
        maxConcurrentChecks: 3,
        notifyInApp: true,
      });
      expect(response.body.scheduler).toBeDefined();
      expect(response.body.notifications.registeredChannels).toContain('in_app');
    });

    it('exposes no target-price or threshold setting', async () => {
      const response = await agent().get('/api/settings').expect(200);
      const keys = Object.keys(response.body.settings);

      for (const forbidden of ['targetPrice', 'priceThreshold', 'minDiscount', 'maxPrice']) {
        expect(keys).not.toContain(forbidden);
      }
    });

    it('updates settings', async () => {
      const response = await agent()
        .patch('/api/settings')
        .send({ monitorIntervalMinutes: 30, maxConcurrentChecks: 5 })
        .expect(200);

      expect(response.body.settings.monitorIntervalMinutes).toBe(30);
      expect(response.body.settings.maxConcurrentChecks).toBe(5);

      // The change is persisted, not just echoed.
      const reread = await agent().get('/api/settings').expect(200);
      expect(reread.body.settings.monitorIntervalMinutes).toBe(30);
    });

    it('rejects out-of-range and unknown settings', async () => {
      await agent().patch('/api/settings').send({ monitorIntervalMinutes: 0 }).expect(400);
      await agent().patch('/api/settings').send({ monitorIntervalMinutes: 100000 }).expect(400);
      await agent().patch('/api/settings').send({ maxConcurrentChecks: 999 }).expect(400);
      await agent().patch('/api/settings').send({ monitoringEnabled: 'yes' }).expect(400);
      await agent().patch('/api/settings').send({ targetPrice: 50000 }).expect(400);
    });
  });

  // --- scheduler / logs --------------------------------------------------

  describe('/api/scheduler and /api/logs', () => {
    it('runs a monitoring sweep on demand', async () => {
      const product = await addProduct();
      await makeDue(harness.container, product.id, 30);
      harness.fetcher.setPrice(65999);

      const response = await agent().post('/api/scheduler/run').expect(200);

      expect(response.body.ran).toBe(true);
      expect(response.body.tick).toMatchObject({ due: 1, checked: 1, changed: 1, notifications: 1 });
    });

    it('explains why a sweep did not run', async () => {
      await agent().patch('/api/settings').send({ monitoringEnabled: false }).expect(200);

      const response = await agent().post('/api/scheduler/run').expect(200);

      expect(response.body.ran).toBe(false);
      expect(response.body.reason).toMatch(/disabled/i);
    });

    it('exposes the check audit trail including failures', async () => {
      const product = await addProduct();
      harness.fetcher.failAlways('CAPTCHA');
      await agent().post(`/api/products/${product.id}/check`).expect(200);

      const all = await agent().get('/api/logs/checks').expect(200);
      expect(all.body.counts).toMatchObject({ success: 1, failed: 1 });

      const failed = await agent().get('/api/logs/checks?status=failed').expect(200);
      expect(failed.body.logs).toHaveLength(1);
      expect(failed.body.logs[0]).toMatchObject({
        status: 'failed',
        errorCode: 'CAPTCHA',
        productName: 'iPhone 16',
      });
    });

    it('exposes recent application log records', async () => {
      await addProduct();
      const response = await agent().get('/api/logs/app?limit=50').expect(200);
      expect(Array.isArray(response.body.logs)).toBe(true);
    });
  });

  // --- full flow ---------------------------------------------------------

  it('supports the complete flow: add, unchanged, drop, rise, fail, delete', async () => {
    // 1. Add - baseline, no notification.
    const product = await addProduct(TEST_URL, 69999);
    expect((await agent().get('/api/notifications')).body.total).toBe(0);

    // 2. Same price - no notification.
    let check = await agent().post(`/api/products/${product.id}/check`).expect(200);
    expect(check.body.outcome).toBe('unchanged');

    // 3. Price drops - notification.
    harness.fetcher.setPrice(67999);
    check = await agent().post(`/api/products/${product.id}/check`).expect(200);
    expect(check.body.outcome).toBe('changed');
    expect(check.body.change.display).toBe('↓ ₹2,000 (2.86%)');

    // 4. Price rises - notification.
    harness.fetcher.setPrice(70999);
    check = await agent().post(`/api/products/${product.id}/check`).expect(200);
    expect(check.body.change.display).toBe('↑ ₹3,000 (4.41%)');

    // 5. Scrape fails - price retained, no notification.
    harness.fetcher.failAlways('CAPTCHA');
    check = await agent().post(`/api/products/${product.id}/check`).expect(200);
    expect(check.body.outcome).toBe('failed');
    expect(check.body.product.currentPrice).toBe(70999);

    const notifications = await agent().get('/api/notifications').expect(200);
    expect(notifications.body.total).toBe(2);
    expect(notifications.body.unreadCount).toBe(2);

    const detail = await agent().get(`/api/products/${product.id}`).expect(200);
    expect(detail.body.stats).toMatchObject({
      currentPrice: 70999,
      previousPrice: 67999,
      lowestPrice: 67999,
      highestPrice: 70999,
      totalPriceChanges: 2,
    });

    // 6. Delete - everything goes.
    await agent().delete(`/api/products/${product.id}`).expect(204);
    expect((await agent().get('/api/notifications')).body.total).toBe(0);
  });
});

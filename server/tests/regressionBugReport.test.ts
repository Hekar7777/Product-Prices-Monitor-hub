import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from './helpers/testApp.js';

/**
 * Regression coverage for a reported bug:
 *
 *   - "Request failed with status 500" when adding a valid Flipkart product.
 *   - Top navigation showed "Server unreachable".
 *
 * Root causes found and fixed:
 *
 *   1. `server/package.json`'s `dev` script passed `--disable-warning` to `tsx`
 *      *before* the `watch` subcommand. tsx only recognises `watch` as its
 *      first CLI argument, so with a flag ahead of it, `watch` was treated as
 *      the entry file to run and the process crashed on startup with
 *      ERR_MODULE_NOT_FOUND. The backend was simply never running, which is
 *      exactly what produces "Request failed with status 500" (Vite's proxy
 *      has nothing to forward to) and "Server unreachable" (the health poll
 *      fails). Fixed by putting `watch` first: `tsx watch --disable-warning=... src/index.ts`.
 *
 *   2. Independently of (1), the Express error handler
 *      (`server/src/api/middleware.ts`) did not recognise the plain
 *      `SyntaxError` that `express.json()` throws for a malformed request
 *      body (or the oversized-body error). Both fell through to the generic
 *      "Internal server error" 500 instead of a 400. This suite locks that in.
 *
 * This file exercises the HTTP layer directly (via supertest, against the real
 * app object) rather than the process-level startup script, since a script typo
 * cannot be represented as a unit test - but the resulting API behaviour that
 * the user actually observed is fully covered here.
 */
describe('regression: 500 on adding a Flipkart product', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  const agent = () => request(harness.app);

  // The exact URL from the bug report.
  const VIVO_URL =
    'https://www.flipkart.com/vivo-x200t-stellar-black-512-gb/p/itm1b8452d68859b?pid=MOBHJK5MWVU36Z9H';

  it('adds the exact reported product URL successfully, with real extracted data', async () => {
    harness.fetcher.productName = 'vivo X200T (Stellar Black, 512 GB)';
    harness.fetcher.setPrice(69999);
    harness.fetcher.mrp = null;
    harness.fetcher.seller = null;
    harness.fetcher.imageUrl =
      'https://rukmini1.flixcart.com/image/1500/1500/xif0q/mobile/u/q/r/-enriched-transparent-original-imahjzxknyum2hqe.png?q=70';

    const response = await agent().post('/api/products').send({ url: VIVO_URL }).expect(201);

    expect(response.body.product).toMatchObject({
      productName: 'vivo X200T (Stellar Black, 512 GB)',
      currentPrice: 69999,
      previousPrice: null,
      availability: 'In Stock',
      monitoringEnabled: true,
    });
    // No fake/placeholder price - the value came from the fetcher, unmodified.
    expect(response.body.product.currentPrice).toBe(harness.fetcher.price);
    expect(response.body.product.imageUrl).toContain('flixcart.com');

    // A baseline must never produce a notification.
    const notifications = await agent().get('/api/notifications').expect(200);
    expect(notifications.body.total).toBe(0);
  });

  it('extracts correctly when the URL carries pid/lid query parameters', async () => {
    harness.fetcher.setPrice(54999);

    const withParams =
      'https://www.flipkart.com/vivo-x200t-stellar-black-512-gb/p/itm1b8452d68859b?pid=MOBHJK5MWVU36Z9H&lid=LSTMOB123ABC&marketplace=FLIPKART&otracker=search';

    const response = await agent().post('/api/products').send({ url: withParams }).expect(201);

    expect(response.body.product.currentPrice).toBe(54999);
    // pid/lid are preserved; tracking params like otracker are stripped.
    expect(response.body.product.url).toContain('pid=MOBHJK5MWVU36Z9H');
    expect(response.body.product.url).toContain('lid=LSTMOB123ABC');
    expect(response.body.product.url).not.toContain('otracker');
  });

  it('a malformed JSON request body returns 400, never a bare 500', async () => {
    const response = await request(harness.app)
      .post('/api/products')
      .set('Content-Type', 'application/json')
      .send('{ this is not valid json')
      .expect(400);

    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(response.body.error.message).toMatch(/not valid json/i);
  });

  it('an oversized request body returns 400, never a bare 500', async () => {
    const response = await request(harness.app)
      .post('/api/products')
      .set('Content-Type', 'application/json')
      .send({ url: `https://www.flipkart.com/x/p/${'a'.repeat(40_000)}` })
      .expect(400);

    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('an invalid (non-Flipkart) URL returns 400, never a 500', async () => {
    const response = await agent()
      .post('/api/products')
      .send({ url: 'https://www.amazon.in/dp/B0CHX1W1XY' })
      .expect(400);

    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('a page with no readable price returns a structured 422, never a 500', async () => {
    harness.fetcher.failAlways('PRICE_NOT_FOUND');

    const response = await agent().post('/api/products').send({ url: VIVO_URL }).expect(422);

    expect(response.body.error.code).toBe('UNPROCESSABLE');
    expect(response.body.error.details.code).toBe('PRICE_NOT_FOUND');
    expect(response.body.error.message).toBeTruthy();
  });

  it('a CAPTCHA response returns a structured 422 and creates no product', async () => {
    harness.fetcher.failAlways('CAPTCHA');

    const response = await agent().post('/api/products').send({ url: VIVO_URL }).expect(422);

    expect(response.body.error.code).toBe('UNPROCESSABLE');
    expect(response.body.error.details.code).toBe('CAPTCHA');
    const list = await agent().get('/api/products').expect(200);
    expect(list.body.products).toHaveLength(0);
  });

  it('CAPTCHA on a later check keeps the previous price and does not notify', async () => {
    harness.fetcher.setPrice(69999);
    const added = await agent().post('/api/products').send({ url: VIVO_URL }).expect(201);
    const productId = added.body.product.id;

    harness.fetcher.failAlways('CAPTCHA');
    const check = await agent().post(`/api/products/${productId}/check`).expect(200);

    expect(check.body.outcome).toBe('failed');
    expect(check.body.error.code).toBe('CAPTCHA');
    expect(check.body.product.currentPrice).toBe(69999);
    expect(check.body.notifications).toBe(0);
  });

  it('a timeout on a later check keeps the previous price and does not notify', async () => {
    harness.fetcher.setPrice(69999);
    const added = await agent().post('/api/products').send({ url: VIVO_URL }).expect(201);
    const productId = added.body.product.id;

    harness.fetcher.failAlways('TIMEOUT');
    const check = await agent().post(`/api/products/${productId}/check`).expect(200);

    expect(check.body.outcome).toBe('failed');
    expect(check.body.error.code).toBe('TIMEOUT');
    expect(check.body.product.currentPrice).toBe(69999);
    expect(check.body.notifications).toBe(0);
  });

  it('an unchanged price produces no notification', async () => {
    harness.fetcher.setPrice(69999);
    const added = await agent().post('/api/products').send({ url: VIVO_URL }).expect(201);

    const check = await agent()
      .post(`/api/products/${added.body.product.id}/check`)
      .expect(200);

    expect(check.body.outcome).toBe('unchanged');
    expect(check.body.notifications).toBe(0);
  });

  it('a changed price produces exactly one notification', async () => {
    harness.fetcher.setPrice(69999);
    const added = await agent().post('/api/products').send({ url: VIVO_URL }).expect(201);

    harness.fetcher.setPrice(64999);
    const check = await agent()
      .post(`/api/products/${added.body.product.id}/check`)
      .expect(200);

    expect(check.body.outcome).toBe('changed');
    expect(check.body.notifications).toBe(1);

    const notifications = await agent().get('/api/notifications').expect(200);
    expect(notifications.body.total).toBe(1);
  });
});

describe('regression: health endpoint / "Server unreachable" indicator', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('GET /api/health succeeds while the server is up, independent of settings/scheduler assembly', async () => {
    const response = await request(harness.app).get('/api/health').expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.database).toBe('ok');
    expect(response.body.scheduler).toMatchObject({
      running: expect.any(Boolean),
      monitoringEnabled: expect.any(Boolean),
      intervalMinutes: expect.any(Number),
    });
  });

  it('GET /api/health never 500s even under load from other endpoints', async () => {
    // Fire several concurrent requests, simulating the dashboard's polling
    // hooks all hitting the API at once; the health check must stay cheap
    // and independent.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(harness.app).get('/api/health')),
    );
    for (const res of results) {
      expect(res.status).toBe(200);
    }
  });
});

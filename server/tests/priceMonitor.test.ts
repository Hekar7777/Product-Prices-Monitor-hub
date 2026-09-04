import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_URL } from './helpers/fakeFetcher.js';
import { countRows, createHarness, makeDue, type TestHarness } from './helpers/testApp.js';

/**
 * The business rule, end to end:
 *
 *   different price -> record a change and notify
 *   same price      -> do nothing
 *   failed check    -> keep the last valid price, do not notify
 */
describe('PriceMonitorService', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function addProduct(price = 69999) {
    harness.fetcher.setPrice(price);
    return harness.container.products.addProduct(TEST_URL);
  }

  // --- baseline ----------------------------------------------------------

  it('records the first price as a baseline without notifying', async () => {
    const product = await addProduct(69999);

    expect(product.currentPrice).toBe(69999);
    expect(product.previousPrice).toBeNull();
    expect(product.lowestPrice).toBe(69999);
    expect(product.highestPrice).toBe(69999);
    expect(product.priceChangeCount).toBe(0);
    expect(product.lastStatus).toBe('ok');
    expect(product.lastCheckedAt).not.toBeNull();

    // A baseline is not a change.
    expect(await countRows(harness.container, 'price_changes')).toBe(0);
    expect(await countRows(harness.container, 'notifications')).toBe(0);
    expect(await harness.container.notifications.unreadCount()).toBe(0);

    // It is still a meaningful observation, so history has exactly one row.
    const history = await harness.container.repositories.priceHistory.listByProduct(product.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.isBaseline).toBe(true);
    expect(history[0]?.price).toBe(69999);
  });

  // --- unchanged ---------------------------------------------------------

  it('does nothing when the price is unchanged', async () => {
    const created = await addProduct(69999);

    // Backdate so "last_checked_at advanced" is unambiguous rather than
    // depending on the baseline and the check landing in different milliseconds.
    await makeDue(harness.container, created.id, 60);
    const before = await harness.container.products.getById(created.id);
    const product = before;

    const result = await harness.container.monitor.checkProduct(product.id);

    expect(result.kind).toBe('unchanged');
    expect(result.change).toBeNull();
    expect(result.notifications).toHaveLength(0);
    expect(result.historyEntry).toBeNull();

    const after = await harness.container.products.getById(product.id);
    expect(after.currentPrice).toBe(69999);
    expect(after.previousPrice).toBeNull();
    expect(after.priceChangeCount).toBe(0);

    // last_checked_at advances even though nothing changed.
    expect(Date.parse(after.lastCheckedAt!)).toBeGreaterThan(Date.parse(before.lastCheckedAt!));

    // No duplicate history row for an identical price.
    expect(await countRows(harness.container, 'price_history')).toBe(1);
    expect(await countRows(harness.container, 'price_changes')).toBe(0);
    expect(await countRows(harness.container, 'notifications')).toBe(0);
  });

  it('does not create history rows for many unchanged checks', async () => {
    const product = await addProduct(69999);

    for (let i = 0; i < 5; i += 1) {
      const result = await harness.container.monitor.checkProduct(product.id);
      expect(result.kind).toBe('unchanged');
    }

    expect(await countRows(harness.container, 'price_history')).toBe(1);
    // Every attempt is still audited.
    expect(await countRows(harness.container, 'check_logs')).toBe(6);
  });

  // --- price drop --------------------------------------------------------

  it('records a change and notifies when the price drops', async () => {
    const product = await addProduct(69999);
    harness.fetcher.setPrice(67999);

    const result = await harness.container.monitor.checkProduct(product.id);

    expect(result.kind).toBe('changed');
    expect(result.change).not.toBeNull();
    expect(result.change).toMatchObject({
      oldPrice: 69999,
      newPrice: 67999,
      absoluteChange: 2000,
      percentageChange: 2.86,
      direction: 'down',
    });

    const after = await harness.container.products.getById(product.id);
    expect(after.currentPrice).toBe(67999);
    expect(after.previousPrice).toBe(69999);
    expect(after.lowestPrice).toBe(67999);
    expect(after.highestPrice).toBe(69999);
    expect(after.priceChangeCount).toBe(1);
    expect(after.lastPriceChangeAt).not.toBeNull();

    expect(result.notifications).toHaveLength(1);
    const notification = result.notifications[0]!;
    expect(notification.title).toBe('Price dropped');
    expect(notification.type).toBe('price_drop');
    expect(notification.message).toBe('iPhone 16\n₹69,999 → ₹67,999\n↓ ₹2,000 (2.86%)');
    expect(notification.read).toBe(false);
    expect(notification.channel).toBe('in_app');
    expect(notification.payload).toMatchObject({
      oldPrice: 69999,
      newPrice: 67999,
      absoluteChange: 2000,
      percentageChange: 2.86,
      direction: 'down',
    });
  });

  // --- price increase ----------------------------------------------------

  it('records a change and notifies when the price increases', async () => {
    const product = await addProduct(67999);
    harness.fetcher.setPrice(70999);

    const result = await harness.container.monitor.checkProduct(product.id);

    expect(result.kind).toBe('changed');
    expect(result.change).toMatchObject({
      oldPrice: 67999,
      newPrice: 70999,
      absoluteChange: 3000,
      percentageChange: 4.41,
      direction: 'up',
    });

    const after = await harness.container.products.getById(product.id);
    expect(after.currentPrice).toBe(70999);
    expect(after.previousPrice).toBe(67999);
    expect(after.lowestPrice).toBe(67999);
    expect(after.highestPrice).toBe(70999);

    const notification = result.notifications[0]!;
    expect(notification.title).toBe('Price increased');
    expect(notification.type).toBe('price_increase');
    expect(notification.message).toBe('iPhone 16\n₹67,999 → ₹70,999\n↑ ₹3,000 (4.41%)');
  });

  it('notifies for a tiny change, because there is no threshold', async () => {
    const product = await addProduct(1000);
    harness.fetcher.setPrice(999);

    const result = await harness.container.monitor.checkProduct(product.id);

    expect(result.kind).toBe('changed');
    expect(result.change?.absoluteChange).toBe(1);
    expect(result.notifications).toHaveLength(1);
  });

  it('tracks lowest and highest across a sequence of changes', async () => {
    const product = await addProduct(50000);

    for (const price of [45000, 60000, 48000]) {
      harness.fetcher.setPrice(price);
      await harness.container.monitor.checkProduct(product.id);
    }

    const after = await harness.container.products.getById(product.id);
    expect(after.currentPrice).toBe(48000);
    expect(after.previousPrice).toBe(60000);
    expect(after.lowestPrice).toBe(45000);
    expect(after.highestPrice).toBe(60000);
    expect(after.priceChangeCount).toBe(3);
    expect(await countRows(harness.container, 'price_changes')).toBe(3);
    expect(await countRows(harness.container, 'notifications')).toBe(3);
    // Baseline + three changes.
    expect(await countRows(harness.container, 'price_history')).toBe(4);
  });

  // --- failed checks -----------------------------------------------------

  const failureCodes = [
    'CAPTCHA',
    'TIMEOUT',
    'NETWORK_ERROR',
    'HTTP_ERROR',
    'PRODUCT_REMOVED',
    'PRODUCT_UNAVAILABLE',
    'PRICE_NOT_FOUND',
    'PARSE_ERROR',
    'BROWSER_ERROR',
    'BROWSER_UNAVAILABLE',
    'LOGIN_REQUIRED',
  ] as const;

  for (const code of failureCodes) {
    it(`keeps the last valid price and does not notify on ${code}`, async () => {
      const created = await addProduct(69999);

      // Backdate the timestamps so "advanced" versus "did not advance" is
      // unambiguous instead of depending on sub-millisecond timing.
      await makeDue(harness.container, created.id, 60);
      const product = await harness.container.products.getById(created.id);

      harness.fetcher.failAlways(code);

      const result = await harness.container.monitor.checkProduct(product.id);

      expect(result.kind).toBe('failed');
      expect(result.errorCode).toBe(code);
      expect(result.change).toBeNull();
      expect(result.historyEntry).toBeNull();
      expect(result.notifications).toHaveLength(0);

      const after = await harness.container.products.getById(product.id);
      // The price is untouched - this is the critical guarantee.
      expect(after.currentPrice).toBe(69999);
      expect(after.previousPrice).toBeNull();
      expect(after.lowestPrice).toBe(69999);
      expect(after.highestPrice).toBe(69999);
      expect(after.lastStatus).toBe('failed');
      expect(after.lastErrorCode).toBe(code);
      expect(after.consecutiveFailures).toBe(1);

      // last_checked_at (last *success*) must not advance on a failure.
      expect(after.lastCheckedAt).toBe(product.lastCheckedAt);
      // last_attempted_at does advance, so scheduling still works.
      expect(Date.parse(after.lastAttemptedAt!)).toBeGreaterThan(
        Date.parse(product.lastAttemptedAt!),
      );

      expect(await countRows(harness.container, 'price_changes')).toBe(0);
      expect(await countRows(harness.container, 'notifications')).toBe(0);

      // The failure is visible in the audit trail.
      const logs = await harness.container.repositories.checkLogs.list({ productId: product.id });
      expect(logs[0]).toMatchObject({ status: 'failed', errorCode: code, price: null });
    });
  }

  it('treats a missing price as a failed check, not a price of zero', async () => {
    const product = await addProduct(69999);
    // Simulate a fetcher that somehow returns an unusable price.
    harness.fetcher.setPrice(0);

    const result = await harness.container.monitor.checkProduct(product.id);

    expect(result.kind).toBe('failed');
    expect(result.errorCode).toBe('PRICE_NOT_FOUND');

    const after = await harness.container.products.getById(product.id);
    expect(after.currentPrice).toBe(69999);
    expect(await countRows(harness.container, 'notifications')).toBe(0);
  });

  it('counts consecutive failures and resets them after a success', async () => {
    const product = await addProduct(69999);

    harness.fetcher.failAlways('TIMEOUT');
    await harness.container.monitor.checkProduct(product.id);
    await harness.container.monitor.checkProduct(product.id);
    expect((await harness.container.products.getById(product.id)).consecutiveFailures).toBe(2);

    harness.fetcher.succeedAgain();
    harness.fetcher.setPrice(65000);
    const result = await harness.container.monitor.checkProduct(product.id);

    expect(result.kind).toBe('changed');
    const after = await harness.container.products.getById(product.id);
    expect(after.consecutiveFailures).toBe(0);
    expect(after.lastStatus).toBe('ok');
    expect(after.lastErrorCode).toBeNull();
    // The change is measured against the last *successful* price, not a failure.
    expect(result.change?.oldPrice).toBe(69999);
  });

  it('recovers and detects the change that happened while checks were failing', async () => {
    const product = await addProduct(69999);

    harness.fetcher.failAlways('CAPTCHA');
    await harness.container.monitor.checkProduct(product.id);

    harness.fetcher.succeedAgain();
    harness.fetcher.setPrice(67999);
    const result = await harness.container.monitor.checkProduct(product.id);

    expect(result.kind).toBe('changed');
    expect(result.change).toMatchObject({ oldPrice: 69999, newPrice: 67999, direction: 'down' });
  });

  // --- duplicate prevention ---------------------------------------------

  it('refuses to run two checks for the same product at once', async () => {
    const product = await addProduct(69999);

    harness.fetcher.hold();
    const first = harness.container.monitor.checkProduct(product.id, { trigger: 'scheduler' });

    // The first check is now parked inside the fetcher.
    expect(harness.container.monitor.isChecking(product.id)).toBe(true);
    expect(harness.container.monitor.runningCount()).toBe(1);

    const secondResult = await harness.container.monitor.checkProduct(product.id, { trigger: 'manual' });
    expect(secondResult.kind).toBe('skipped');
    expect(secondResult.skipReason).toBe('already_running');

    harness.fetcher.release();
    const firstResult = await first;

    expect(firstResult.kind).toBe('unchanged');
    expect(harness.container.monitor.isChecking(product.id)).toBe(false);
    // Only one actual fetch happened.
    expect(harness.fetcher.calls).toHaveLength(2); // 1 for addProduct, 1 for the check
  });

  it('allows concurrent checks for different products', async () => {
    const a = await addProduct(69999);

    harness.fetcher.setPrice(52490);
    const b = await harness.container.products.addProduct(
      'https://www.flipkart.com/sony-tv/p/itm9f8a1b2c3d4e5?pid=TVSGXYZ123ABC456',
    );

    harness.fetcher.hold();
    const first = harness.container.monitor.checkProduct(a.id);
    const second = harness.container.monitor.checkProduct(b.id);

    expect(harness.container.monitor.runningCount()).toBe(2);
    harness.fetcher.release();

    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.kind)).not.toContain('skipped');
  });

  it('rejects a check for a product that does not exist', async () => {
    await expect(harness.container.monitor.checkProduct(9999)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  // --- paused products ---------------------------------------------------

  it('still allows a manual check on a paused product', async () => {
    const product = await addProduct(69999);
    await harness.container.products.setMonitoring(product.id, false);

    harness.fetcher.setPrice(60000);
    const result = await harness.container.monitor.checkProduct(product.id, { trigger: 'manual' });

    expect(result.kind).toBe('changed');
    expect(result.notifications).toHaveLength(1);
  });
});

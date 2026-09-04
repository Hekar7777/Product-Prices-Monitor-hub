import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { TEST_URL, TEST_URL_2 } from './helpers/fakeFetcher.js';
import { backdateHistory, countRows, createHarness, type TestHarness } from './helpers/testApp.js';

describe('ProductService', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  // --- adding ------------------------------------------------------------

  describe('addProduct', () => {
    it('extracts and stores the product with its baseline price', async () => {
      const product = await harness.container.products.addProduct(TEST_URL);

      expect(product.id).toBeGreaterThan(0);
      expect(product.productName).toBe('iPhone 16');
      expect(product.currentPrice).toBe(69999);
      expect(product.mrp).toBe(79900);
      expect(product.imageUrl).toContain('flixcart.com');
      expect(product.availability).toBe('In Stock');
      expect(product.seller).toBe('SuperComNet');
      expect(product.currency).toBe('INR');
      expect(product.monitoringEnabled).toBe(true);

      // The stored URL is the normalised one.
      expect(product.url).toBe(
        'https://www.flipkart.com/apple-iphone-16-black-128-gb/p/itm6ac6a86b6e1d2?pid=MOBH4DQF8KZ4YWNQ',
      );
    });

    it('does not notify for the baseline', async () => {
      await harness.container.products.addProduct(TEST_URL);

      expect(await countRows(harness.container, 'notifications')).toBe(0);
      expect(await countRows(harness.container, 'price_changes')).toBe(0);
      expect(await countRows(harness.container, 'price_history')).toBe(1);
    });

    it('records a successful baseline check in the audit trail', async () => {
      const product = await harness.container.products.addProduct(TEST_URL);
      const logs = await harness.container.repositories.checkLogs.list({ productId: product.id });

      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        status: 'success',
        outcome: 'baseline',
        price: 69999,
        triggerSource: 'initial',
      });
    });

    it('rejects a non-Flipkart URL with 400 and stores nothing', async () => {
      await expect(
        harness.container.products.addProduct('https://www.amazon.in/dp/B0CHX1W1XY'),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(await countRows(harness.container, 'products')).toBe(0);
      // Nothing was fetched, because validation happens first.
      expect(harness.fetcher.calls).toHaveLength(0);
    });

    it('rejects a Flipkart URL that is not a product page', async () => {
      await expect(
        harness.container.products.addProduct('https://www.flipkart.com/search?q=iphone'),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects an empty URL', async () => {
      await expect(harness.container.products.addProduct('   ')).rejects.toBeInstanceOf(AppError);
    });

    it('refuses to add the same product twice', async () => {
      await harness.container.products.addProduct(TEST_URL);

      await expect(
        // Same pid, different tracking parameters and host.
        harness.container.products.addProduct(
          'https://flipkart.com/apple-iphone-16/p/itm6ac6a86b6e1d2?pid=MOBH4DQF8KZ4YWNQ&otracker=search',
        ),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(await countRows(harness.container, 'products')).toBe(1);
    });

    it('reports an unreadable product page as 422 and stores nothing', async () => {
      harness.fetcher.failAlways('CAPTCHA');

      await expect(harness.container.products.addProduct(TEST_URL)).rejects.toMatchObject({
        statusCode: 422,
      });

      expect(await countRows(harness.container, 'products')).toBe(0);
      // The failed attempt is still visible in the logs.
      const logs = await harness.container.repositories.checkLogs.list({});
      expect(logs[0]).toMatchObject({ status: 'failed', errorCode: 'CAPTCHA', productId: null });
    });
  });

  // --- pause / resume ----------------------------------------------------

  describe('pause and resume', () => {
    it('pauses and resumes monitoring', async () => {
      const product = await harness.container.products.addProduct(TEST_URL);
      expect(product.monitoringEnabled).toBe(true);

      const paused = await harness.container.products.setMonitoring(product.id, false);
      expect(paused.monitoringEnabled).toBe(false);

      const resumed = await harness.container.products.setMonitoring(product.id, true);
      expect(resumed.monitoringEnabled).toBe(true);
    });

    it('excludes paused products from the scheduler queue', async () => {
      const product = await harness.container.products.addProduct(TEST_URL);
      await harness.container.products.setMonitoring(product.id, false);

      const due = await harness.container.repositories.products.findDue(0);
      expect(due.map((p) => p.id)).not.toContain(product.id);
    });

    it('includes a resumed product in the scheduler queue again', async () => {
      const product = await harness.container.products.addProduct(TEST_URL);
      await harness.container.products.setMonitoring(product.id, false);
      await harness.container.products.setMonitoring(product.id, true);

      const due = await harness.container.repositories.products.findDue(0);
      expect(due.map((p) => p.id)).toContain(product.id);
    });

    it('reports 404 when pausing a product that does not exist', async () => {
      await expect(harness.container.products.setMonitoring(4242, false)).rejects.toThrow(AppError);
    });
  });

  // --- deletion ----------------------------------------------------------

  describe('deletion', () => {
    it('removes the product and every dependent row', async () => {
      const product = await harness.container.products.addProduct(TEST_URL);

      harness.fetcher.setPrice(67999);
      await harness.container.monitor.checkProduct(product.id);

      expect(await countRows(harness.container, 'price_history')).toBe(2);
      expect(await countRows(harness.container, 'price_changes')).toBe(1);
      expect(await countRows(harness.container, 'notifications')).toBe(1);
      expect(await countRows(harness.container, 'check_logs')).toBe(2);

      await harness.container.products.remove(product.id);

      expect(await countRows(harness.container, 'products')).toBe(0);
      expect(await countRows(harness.container, 'price_history')).toBe(0);
      expect(await countRows(harness.container, 'price_changes')).toBe(0);
      expect(await countRows(harness.container, 'notifications')).toBe(0);
      expect(await countRows(harness.container, 'check_logs')).toBe(0);
    });

    it('reports 404 for a product that does not exist', async () => {
      await expect(harness.container.products.remove(999)).rejects.toThrow(AppError);
    });

    it('allows the same URL to be added again after deletion', async () => {
      const product = await harness.container.products.addProduct(TEST_URL);
      await harness.container.products.remove(product.id);

      const again = await harness.container.products.addProduct(TEST_URL);
      expect(again.id).not.toBe(product.id);
      expect(again.currentPrice).toBe(69999);
    });
  });

  // --- reads -------------------------------------------------------------

  describe('detail and statistics', () => {
    it('reports statistics across the full price series', async () => {
      const product = await harness.container.products.addProduct(TEST_URL);

      for (const price of [67999, 71999, 65999]) {
        harness.fetcher.setPrice(price);
        await harness.container.monitor.checkProduct(product.id);
      }

      const { stats } = await harness.container.products.getDetail(product.id);

      expect(stats.currentPrice).toBe(65999);
      expect(stats.previousPrice).toBe(71999);
      expect(stats.lowestPrice).toBe(65999);
      expect(stats.highestPrice).toBe(71999);
      expect(stats.totalPriceChanges).toBe(3);
      expect(stats.totalObservations).toBe(4);
      expect(stats.lastPriceChange).toMatchObject({
        oldPrice: 71999,
        newPrice: 65999,
        direction: 'down',
      });
      expect(stats.averagePrice).toBeCloseTo((69999 + 67999 + 71999 + 65999) / 4, 2);
    });

    it('reports 404 for an unknown product', async () => {
      await expect(harness.container.products.getDetail(12345)).rejects.toThrow(AppError);
    });
  });

  describe('history series', () => {
    it('marks the first entry as the baseline with no delta', async () => {
      const product = await harness.container.products.addProduct(TEST_URL);
      const points = await harness.container.products.getHistory(product.id, 'all');

      expect(points).toHaveLength(1);
      expect(points[0]?.isBaseline).toBe(true);
      expect(points[0]?.change).toBeNull();
    });

    it('computes the delta between consecutive observations', async () => {
      const product = await harness.container.products.addProduct(TEST_URL);

      harness.fetcher.setPrice(67999);
      await harness.container.monitor.checkProduct(product.id);
      harness.fetcher.setPrice(70999);
      await harness.container.monitor.checkProduct(product.id);

      const points = await harness.container.products.getHistory(product.id, 'all');

      expect(points.map((p) => p.price)).toEqual([69999, 67999, 70999]);
      expect(points[0]?.change).toBeNull();
      expect(points[1]?.change).toMatchObject({
        absoluteChange: 2000,
        percentageChange: 2.86,
        direction: 'down',
        signedChange: -2000,
      });
      expect(points[2]?.change).toMatchObject({
        absoluteChange: 3000,
        percentageChange: 4.41,
        direction: 'up',
        signedChange: 3000,
      });
    });

    it('carries the opening price into a narrower time range', async () => {
      const product = await harness.container.products.addProduct(TEST_URL);

      // Push the baseline 10 days into the past.
      const baselineList = await harness.container.repositories.priceHistory.listByProduct(product.id);
      const baseline = baselineList[0]!;
      await backdateHistory(harness.container, baseline.id, 10);

      harness.fetcher.setPrice(67999);
      await harness.container.monitor.checkProduct(product.id);

      const last24h = await harness.container.products.getHistory(product.id, '24h');

      // Two points: the price in effect when the window opened, then the change.
      expect(last24h).toHaveLength(2);
      expect(last24h[0]?.price).toBe(69999);
      expect(last24h[1]?.price).toBe(67999);

      const allTime = await harness.container.products.getHistory(product.id, 'all');
      expect(allTime).toHaveLength(2);
    });
  });

  describe('list and overview', () => {
    it('returns each product with its latest change', async () => {
      const a = await harness.container.products.addProduct(TEST_URL);
      harness.fetcher.setPrice(52490);
      await harness.container.products.addProduct(TEST_URL_2);

      harness.fetcher.setPrice(50000);
      await harness.container.monitor.checkProduct(a.id);

      const rows = await harness.container.products.list();
      expect(rows).toHaveLength(2);

      const rowA = rows.find((row) => row.product.id === a.id);
      expect(rowA?.latestChange).toMatchObject({ direction: 'down', oldPrice: 69999 });

      const rowB = rows.find((row) => row.product.id !== a.id);
      expect(rowB?.latestChange).toBeNull();
    });

    it('filters by monitoring status and search term', async () => {
      const a = await harness.container.products.addProduct(TEST_URL);
      harness.fetcher.productName = 'Sony Bravia TV';
      harness.fetcher.setPrice(52490);
      await harness.container.products.addProduct(TEST_URL_2);

      await harness.container.products.setMonitoring(a.id, false);

      expect(await harness.container.products.list({ monitoringEnabled: false })).toHaveLength(1);
      expect(await harness.container.products.list({ monitoringEnabled: true })).toHaveLength(1);
      expect(await harness.container.products.list({ search: 'sony' })).toHaveLength(1);
      expect(await harness.container.products.list({ search: 'nothing here' })).toHaveLength(0);
    });

    it('summarises the dashboard', async () => {
      const a = await harness.container.products.addProduct(TEST_URL);
      harness.fetcher.setPrice(52490);
      const b = await harness.container.products.addProduct(TEST_URL_2);

      await harness.container.products.setMonitoring(b.id, false);

      harness.fetcher.setPrice(50000);
      await harness.container.monitor.checkProduct(a.id);

      harness.fetcher.failAlways('TIMEOUT');
      await harness.container.monitor.checkProduct(a.id);

      const overview = await harness.container.products.overview();

      expect(overview.totalProducts).toBe(2);
      expect(overview.monitoredProducts).toBe(1);
      expect(overview.pausedProducts).toBe(1);
      expect(overview.changesLast24h).toBe(1);
      expect(overview.failedChecksLast24h).toBe(1);
      expect(overview.unreadNotifications).toBe(1);
      expect(overview.productsWithErrors).toBe(1);
    });
  });
});

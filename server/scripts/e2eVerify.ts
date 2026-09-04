/**
 * End-to-end verification of the whole application.
 *
 * This boots the real HTTP server against an in-memory fake Supabase client
 * (the repositories' real query-builder code runs unmodified; only the
 * network transport is faked - see `tests/helpers/fakeSupabase.ts`), then
 * drives it over real HTTP requests, including the cron-triggered check
 * endpoint that replaced the old in-process timer scheduler.
 *
 * The only substituted components are (a) the database transport, so this
 * script needs no live Supabase project, and (b) the outermost boundary -
 * the Flipkart page fetcher - because a verification run must be
 * deterministic and must not send traffic to a third-party site. Both
 * substitutes implement the exact same interfaces the production code talks
 * to, so everything above them (routing, validation, price comparison,
 * history, notifications, persistence, the cron endpoint) is the production
 * code path.
 *
 * Run with:  npm --workspace server run verify:e2e
 *
 * Note on env var timing: `CRON_SECRET` must be set on `process.env` *before*
 * `src/config/env.ts` is first evaluated, because it reads env vars once at
 * module-load time. Static top-level imports are resolved before any of this
 * file's own code runs, so every import that transitively reaches `env.ts`
 * (createApp, createContainer, the fetcher types, settingsService) is done
 * via dynamic `import()` inside `main()`, after the env var is set.
 */
import type { FetchResult, FlipkartProductFetcher } from '../src/fetcher/types.js';

const PORT = 4123;
const BASE = `http://127.0.0.1:${PORT}`;
const CRON_SECRET = 'e2e-verify-secret';
const PRODUCT_URL =
  'https://www.flipkart.com/apple-iphone-16-black-128-gb/p/itm6ac6a86b6e1d2?pid=MOBH4DQF8KZ4YWNQ';

// --- scripted stand-in for the Flipkart extractor ---------------------------

class ScriptedFetcher implements FlipkartProductFetcher {
  readonly name = 'scripted';
  price = 69999;
  failure: string | null = null;

  async fetchProduct(url: string): Promise<FetchResult> {
    if (this.failure) {
      const { FetchError } = await import('../src/errors.js');
      throw new FetchError(this.failure as never, `simulated ${this.failure}`, {
        strategy: this.name,
      });
    }
    return {
      product: {
        productName: 'Apple iPhone 16 (Black, 128 GB)',
        price: this.price,
        mrp: 79900,
        imageUrl: 'https://rukminim2.flixcart.com/image/400/400/iphone.jpeg',
        availability: 'In Stock',
        seller: 'SuperComNet',
        currency: 'INR',
        url,
      },
      meta: { strategy: this.name, attempts: 1, durationMs: 5, httpStatus: 200 },
    };
  }
}

// --- tiny assertion harness -------------------------------------------------

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.error(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

interface ApiResponse<T> {
  status: number;
  body: T;
}

async function call<T = any>(
  method: string,
  routePath: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  return callRaw(method, routePath, body, { 'Content-Type': 'application/json' });
}

async function callRaw<T = any>(
  method: string,
  routePath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${BASE}${routePath}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed as T };
}

// --- run --------------------------------------------------------------------

async function main(): Promise<void> {
  // Must happen before any of the dynamic imports below, since they
  // transitively load `src/config/env.ts`, which reads CRON_SECRET once at
  // module-evaluation time.
  process.env.CRON_SECRET = CRON_SECRET;

  const { createApp } = await import('../src/app/createApp.js');
  const { createContainer } = await import('../src/app/container.js');
  const { logger } = await import('../src/logger.js');
  const { defaultSettings } = await import('../src/services/settingsService.js');
  const { createFakeSupabaseDb } = await import('../tests/helpers/fakeSupabase.js');

  // The run asserts that structured events such as `price.changed` are
  // emitted, which requires the info level regardless of the ambient LOG_LEVEL.
  logger.setLevel('info');

  const fetcher = new ScriptedFetcher();
  const db = createFakeSupabaseDb();
  const container = await createContainer({
    db,
    fetcher,
    settingsDefaults: {
      ...defaultSettings(),
      monitorIntervalMinutes: 1,
      maxConcurrentChecks: 2,
    },
  });

  const app = createApp(container);

  const server = app.listen(PORT, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));

  try {
    // ---------------------------------------------------------------------
    section('1. Server and database come up');
    const health = await call('GET', '/api/health');
    check('GET /api/health returns 200', health.status === 200, health.body);
    check('database is reachable', health.body.database === 'ok', health.body);

    // ---------------------------------------------------------------------
    section('1b. The cron-triggered check endpoint replaces the old timer');
    const noSecret = await callRaw('POST', '/api/cron/check-prices', undefined, {});
    check('missing x-cron-secret header is rejected with 401', noSecret.status === 401, noSecret.body);

    const wrongSecret = await callRaw('POST', '/api/cron/check-prices', undefined, {
      'x-cron-secret': 'wrong',
    });
    check('incorrect x-cron-secret header is rejected with 401', wrongSecret.status === 401);

    // ---------------------------------------------------------------------
    section('2. Invalid input is rejected');
    const notFlipkart = await call('POST', '/api/products', {
      url: 'https://www.amazon.in/dp/B0CHX1W1XY',
    });
    check('non-Flipkart URL returns 400', notFlipkart.status === 400, notFlipkart.body);

    const notAProduct = await call('POST', '/api/products', {
      url: 'https://www.flipkart.com/search?q=iphone',
    });
    check('Flipkart non-product URL returns 400', notAProduct.status === 400, notAProduct.body);

    const missingUrl = await call('POST', '/api/products', {});
    check('missing URL returns 400', missingUrl.status === 400, missingUrl.body);

    const unknownRoute = await call('GET', '/api/nope');
    check('unknown API route returns JSON 404', unknownRoute.status === 404, unknownRoute.body);

    // ---------------------------------------------------------------------
    section('3. Adding a product records a baseline and does NOT notify');
    fetcher.price = 69999;
    const created = await call('POST', '/api/products', { url: PRODUCT_URL });
    check('POST /api/products returns 201', created.status === 201, created.body);

    const productId: number = created.body.product?.id;
    check('product name was extracted', created.body.product?.productName === 'Apple iPhone 16 (Black, 128 GB)');
    check('baseline price was extracted', created.body.product?.currentPrice === 69999);
    check('image was extracted', typeof created.body.product?.imageUrl === 'string');
    check('MRP was extracted', created.body.product?.mrp === 79900);
    check('previous price is empty at baseline', created.body.product?.previousPrice === null);
    check('lowest equals baseline', created.body.product?.lowestPrice === 69999);
    check('highest equals baseline', created.body.product?.highestPrice === 69999);
    check('price is formatted for display', created.body.product?.currentPriceDisplay === '₹69,999');

    let notifications = await call('GET', '/api/notifications');
    check('no notification for the baseline', notifications.body.total === 0, notifications.body);

    const duplicate = await call('POST', '/api/products', { url: PRODUCT_URL });
    check('adding the same product again returns 409', duplicate.status === 409, duplicate.body);

    // ---------------------------------------------------------------------
    section('4. Unchanged price does nothing');
    let checkResult = await call('POST', `/api/products/${productId}/check`);
    check('outcome is "unchanged"', checkResult.body.outcome === 'unchanged', checkResult.body);
    check('no change record', checkResult.body.change === null);
    check('no notification created', checkResult.body.notifications === 0);

    let history = await call('GET', `/api/products/${productId}/history?range=all`);
    check('history still holds a single observation', history.body.points.length === 1, history.body.points);

    // ---------------------------------------------------------------------
    section('5. A price drop is detected and notified');
    fetcher.price = 67999;
    checkResult = await call('POST', `/api/products/${productId}/check`);
    check('outcome is "changed"', checkResult.body.outcome === 'changed', checkResult.body);
    check('old price recorded', checkResult.body.change?.oldPrice === 69999);
    check('new price recorded', checkResult.body.change?.newPrice === 67999);
    check('absolute change is 2000', checkResult.body.change?.absoluteChange === 2000);
    check('percentage change is 2.86', checkResult.body.change?.percentageChange === 2.86);
    check('direction is down', checkResult.body.change?.direction === 'down');
    check('display matches the spec', checkResult.body.change?.display === '↓ ₹2,000 (2.86%)');
    check('one notification created', checkResult.body.notifications === 1);

    notifications = await call('GET', '/api/notifications');
    const drop = notifications.body.notifications[0];
    check('notification title is "Price dropped"', drop?.title === 'Price dropped');
    check(
      'notification body matches the spec',
      drop?.message === 'Apple iPhone 16 (Black, 128 GB)\n₹69,999 → ₹67,999\n↓ ₹2,000 (2.86%)',
      drop?.message,
    );
    check('notification is unread', drop?.read === false);
    check('unread counter is 1', notifications.body.unreadCount === 1);

    // ---------------------------------------------------------------------
    section('6. A price increase is detected and notified');
    fetcher.price = 70999;
    checkResult = await call('POST', `/api/products/${productId}/check`);
    check('absolute change is 3000', checkResult.body.change?.absoluteChange === 3000);
    check('percentage change is 4.41', checkResult.body.change?.percentageChange === 4.41);
    check('direction is up', checkResult.body.change?.direction === 'up');
    check('display matches the spec', checkResult.body.change?.display === '↑ ₹3,000 (4.41%)');

    notifications = await call('GET', '/api/notifications');
    check('notification title is "Price increased"', notifications.body.notifications[0]?.title === 'Price increased');
    check('two notifications so far', notifications.body.total === 2, notifications.body.total);

    // ---------------------------------------------------------------------
    section('7. A failed check keeps the last valid price and raises no alert');
    fetcher.failure = 'CAPTCHA';
    checkResult = await call('POST', `/api/products/${productId}/check`);
    check('outcome is "failed"', checkResult.body.outcome === 'failed', checkResult.body);
    check('failure is classified as CAPTCHA', checkResult.body.error?.code === 'CAPTCHA');
    check('price is retained at ₹70,999', checkResult.body.product?.currentPrice === 70999);
    check('no notification created', checkResult.body.notifications === 0);

    notifications = await call('GET', '/api/notifications');
    check('notification count is unchanged', notifications.body.total === 2, notifications.body.total);

    const failedLogs = await call('GET', '/api/logs/checks?status=failed');
    check('the failure is visible in the check log', failedLogs.body.logs.length === 1, failedLogs.body.counts);

    // Repeat the failure to confirm the price is still never overwritten.
    await call('POST', `/api/products/${productId}/check`);
    const afterFailures = await call('GET', `/api/products/${productId}`);
    check('price survives repeated failures', afterFailures.body.product.currentPrice === 70999);
    check('consecutive failures counted', afterFailures.body.product.consecutiveFailures === 2, afterFailures.body.product.consecutiveFailures);
    check('product status is "failed"', afterFailures.body.product.lastStatus === 'failed');

    // ---------------------------------------------------------------------
    section('8. The cron endpoint detects a change with no scheduler timer involved');
    fetcher.failure = null;
    fetcher.price = 65999;

    // Make the product due for the cron-triggered check to pick up.
    await container.repositories.products.update(productId, {
      lastAttemptedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });

    const changesBefore = await container.repositories.priceChanges.countByProduct(productId);

    const cronRun = await callRaw('POST', '/api/cron/check-prices', undefined, {
      'x-cron-secret': CRON_SECRET,
    });
    check('cron endpoint accepts the correct secret', cronRun.status === 200, cronRun.body);
    check('cron-triggered tick ran', cronRun.body.ran === true, cronRun.body);
    check('cron-triggered tick checked the due product', cronRun.body.tick?.checked === 1, cronRun.body.tick);

    const changesAfter = await container.repositories.priceChanges.countByProduct(productId);
    check('the cron-triggered check detected the change', changesAfter > changesBefore);

    const scheduled = await call('GET', `/api/products/${productId}`);
    check('current price updated to ₹65,999', scheduled.body.product.currentPrice === 65999, scheduled.body.product.currentPrice);
    check('previous price updated to ₹70,999', scheduled.body.product.previousPrice === 70999);
    check('failure counter reset after success', scheduled.body.product.consecutiveFailures === 0);
    check('status back to ok', scheduled.body.product.lastStatus === 'ok');

    notifications = await call('GET', '/api/notifications');
    check('the cron-triggered check produced a notification', notifications.body.total === 3, notifications.body.total);

    // ---------------------------------------------------------------------
    section('9. History, statistics and chart ranges');
    history = await call('GET', `/api/products/${productId}/history?range=all`);
    const prices = history.body.points.map((p: { price: number }) => p.price);
    check('history holds only meaningful observations', prices.length === 4, prices);
    check('history sequence is correct', JSON.stringify(prices) === JSON.stringify([69999, 67999, 70999, 65999]), prices);
    check('first point is the baseline with no delta', history.body.points[0].isBaseline === true && history.body.points[0].display === '—');
    check('second point shows the drop', history.body.points[1].display === '↓ ₹2,000');
    check('third point shows the rise', history.body.points[2].display === '↑ ₹3,000');

    for (const range of ['24h', '7d', '30d', '3m', 'all']) {
      const ranged = await call('GET', `/api/products/${productId}/history?range=${range}`);
      check(`range "${range}" is served`, ranged.status === 200 && ranged.body.range === range);
    }

    const detail = await call('GET', `/api/products/${productId}`);
    check('lowest recorded price is ₹65,999', detail.body.stats.lowestPrice === 65999, detail.body.stats);
    check('highest recorded price is ₹70,999', detail.body.stats.highestPrice === 70999);
    check('three price changes counted', detail.body.stats.totalPriceChanges === 3);
    check('four observations counted', detail.body.stats.totalObservations === 4);
    check('last change is reported', detail.body.stats.lastPriceChange?.newPrice === 65999);
    check('last checked timestamp present', typeof detail.body.stats.lastCheckedAt === 'string');

    const changes = await call('GET', `/api/products/${productId}/changes`);
    check('changes endpoint lists all three', changes.body.changes.length === 3);

    // ---------------------------------------------------------------------
    section('10. Pause and resume');
    let patched = await call('PATCH', `/api/products/${productId}`, { monitoringEnabled: false });
    check('product can be paused', patched.body.product.monitoringEnabled === false, patched.body);
    const dueWhilePaused = await container.repositories.products.findDue(0);
    check(
      'a paused product is not queued by the scheduler',
      dueWhilePaused.every((p) => p.id !== productId),
    );

    // A manual check still works while paused.
    fetcher.price = 64999;
    checkResult = await call('POST', `/api/products/${productId}/check`);
    check('manual check works while paused', checkResult.body.outcome === 'changed', checkResult.body);

    patched = await call('PATCH', `/api/products/${productId}`, { monitoringEnabled: true });
    check('product can be resumed', patched.body.product.monitoringEnabled === true);
    const dueAfterResume = await container.repositories.products.findDue(0);
    check(
      'a resumed product is queued again',
      dueAfterResume.some((p) => p.id === productId),
    );

    const badPatch = await call('PATCH', `/api/products/${productId}`, { targetPrice: 50000 });
    check('there is no target-price field to set', badPatch.status === 400, badPatch.body);

    // ---------------------------------------------------------------------
    section('11. Settings');
    let settings = await call('GET', '/api/settings');
    check('settings are served', settings.status === 200);
    check('interval reflects the configured value', settings.body.settings.monitorIntervalMinutes === 1);
    const settingKeys = Object.keys(settings.body.settings);
    check(
      'no target-price or threshold setting exists',
      !settingKeys.some((k) => /target|threshold|discount|maxprice/i.test(k)),
      settingKeys,
    );

    settings = await call('PATCH', '/api/settings', { monitorIntervalMinutes: 30, maxConcurrentChecks: 4 });
    check('settings can be updated', settings.body.settings.monitorIntervalMinutes === 30, settings.body.settings);
    check('the settings response reflects the new interval', settings.body.scheduler.intervalMinutes === 30);

    settings = await call('GET', '/api/settings');
    check('settings persisted to the database', settings.body.settings.monitorIntervalMinutes === 30);

    const badSetting = await call('PATCH', '/api/settings', { monitorIntervalMinutes: 0 });
    check('out-of-range settings are rejected', badSetting.status === 400);

    // Turn monitoring off globally and confirm the cron endpoint stands down.
    await call('PATCH', '/api/settings', { monitoringEnabled: false });
    const disabledRun = await callRaw('POST', '/api/cron/check-prices', undefined, {
      'x-cron-secret': CRON_SECRET,
    });
    check('global pause stops cron-triggered checks', disabledRun.body.ran === false, disabledRun.body);
    await call('PATCH', '/api/settings', { monitoringEnabled: true, monitorIntervalMinutes: 1 });

    // ---------------------------------------------------------------------
    section('12. Notifications feed management');
    notifications = await call('GET', '/api/notifications');
    const total = notifications.body.total;
    check('feed has every change', total === 4, total);

    const firstId = notifications.body.notifications[0].id;
    const read = await call('POST', `/api/notifications/${firstId}/read`);
    check('a notification can be marked read', read.body.notification.read === true);
    check('unread counter decreases', read.body.unreadCount === total - 1, read.body.unreadCount);

    const readAll = await call('POST', '/api/notifications/read-all');
    check('all notifications can be marked read', readAll.body.unreadCount === 0, readAll.body);

    const unreadOnly = await call('GET', '/api/notifications?unread=true');
    check('unread filter works', unreadOnly.body.notifications.length === 0);

    // ---------------------------------------------------------------------
    section('13. Diagnostics');
    const checkLogs = await call('GET', '/api/logs/checks');
    check('check log records every attempt', checkLogs.body.logs.length >= 8, checkLogs.body.counts);
    check('successes and failures are both recorded', checkLogs.body.counts.success >= 5 && checkLogs.body.counts.failed === 2, checkLogs.body.counts);
    check('log entries carry the product name', checkLogs.body.logs[0].productName === 'Apple iPhone 16 (Black, 128 GB)');

    const appLogs = await call('GET', '/api/logs/app?limit=100');
    check('application log is exposed', Array.isArray(appLogs.body.logs) && appLogs.body.logs.length > 0);
    const events = new Set(appLogs.body.logs.map((r: { event?: string }) => r.event).filter(Boolean));
    for (const event of ['price.changed', 'price.unchanged', 'product.check.failed', 'notification.created']) {
      check(`structured event "${event}" was logged`, events.has(event));
    }

    // ---------------------------------------------------------------------
    section('14. Deletion cascades');
    const deleted = await call('DELETE', `/api/products/${productId}`);
    check('DELETE returns 204', deleted.status === 204);

    const gone = await call('GET', `/api/products/${productId}`);
    check('the product is gone', gone.status === 404);

    for (const table of ['price_history', 'price_changes', 'notifications', 'check_logs'] as const) {
      const { count } = await container.db.client
        .from(table)
        .select('*', { count: 'exact', head: true });
      check(`${table} was cleared by cascade`, (count ?? 0) === 0, count);
    }

    const list = await call('GET', '/api/products');
    check('product list is empty', list.body.products.length === 0);
    check('overview reflects the empty state', list.body.overview.totalProducts === 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await container.shutdown();
  }

  console.log(`\n${'─'.repeat(60)}`);
  if (failures.length === 0) {
    console.log(`ALL CHECKS PASSED  (${passed}/${passed})`);
  } else {
    console.error(`${failures.length} CHECK(S) FAILED  (${passed} passed)`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\nVerification run crashed:', err);
  process.exit(1);
});

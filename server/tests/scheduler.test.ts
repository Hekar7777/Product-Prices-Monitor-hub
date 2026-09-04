import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countRows, createHarness, makeDue, type TestHarness } from './helpers/testApp.js';

describe('MonitoringScheduler', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness({ settings: { monitorIntervalMinutes: 15 } });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function addProducts(count: number): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < count; i += 1) {
      harness.fetcher.setPrice(10_000 + i);
      const product = await harness.container.products.addProduct(
        `https://www.flipkart.com/thing-${i}/p/itmproduct${i}?pid=PIDTEST${i}`,
      );
      ids.push(product.id);
    }
    return ids;
  }

  // --- due selection -----------------------------------------------------

  it('does not re-check a product that was just added', async () => {
    await addProducts(1);

    const tick = await harness.container.scheduler.runTick();

    expect(tick?.due).toBe(0);
    expect(tick?.checked).toBe(0);
  });

  it('checks a product once its interval has elapsed', async () => {
    const [id] = await addProducts(1);
    await makeDue(harness.container, id!, 20);

    const tick = await harness.container.scheduler.runTick();

    expect(tick?.due).toBe(1);
    expect(tick?.checked).toBe(1);
    expect(tick?.unchanged).toBe(1);
  });

  it('skips paused products', async () => {
    const [a, b] = await addProducts(2);
    await makeDue(harness.container, a!, 20);
    await makeDue(harness.container, b!, 20);
    await harness.container.products.setMonitoring(b!, false);

    const tick = await harness.container.scheduler.runTick();

    expect(tick?.due).toBe(1);
    expect(tick?.checked).toBe(1);
  });

  it('does nothing when monitoring is disabled globally', async () => {
    const [id] = await addProducts(1);
    await makeDue(harness.container, id!, 20);

    await harness.container.settings.update({ monitoringEnabled: false });
    const tick = await harness.container.scheduler.runTick();

    expect(tick).toBeNull();
    // Only the baseline fetch from addProduct happened.
    expect(harness.fetcher.calls).toHaveLength(1);
  });

  // --- outcomes ----------------------------------------------------------

  it('summarises changes, non-changes and failures', async () => {
    const ids = await addProducts(3);
    for (const id of ids) await makeDue(harness.container, id, 20);

    // All three products now report a different price than their baseline.
    harness.fetcher.setPrice(99999);

    const tick = await harness.container.scheduler.runTick();

    expect(tick?.checked).toBe(3);
    expect(tick?.changed).toBe(3);
    expect(tick?.notifications).toBe(3);
    expect(await countRows(harness.container, 'notifications')).toBe(3);
  });

  it('keeps going when one product fails', async () => {
    const ids = await addProducts(2);
    for (const id of ids) await makeDue(harness.container, id, 20);

    harness.fetcher.failOnce('TIMEOUT');
    harness.fetcher.setPrice(88888);

    const tick = await harness.container.scheduler.runTick();

    expect(tick?.checked).toBe(2);
    expect(tick?.failed).toBe(1);
    expect(tick?.changed).toBe(1);
  });

  // --- duplicate prevention ---------------------------------------------

  it('does not queue a product that is already being checked', async () => {
    const [id] = await addProducts(1);
    await makeDue(harness.container, id!, 20);

    // Start a manual check and park it inside the fetcher.
    harness.fetcher.hold();
    const manual = harness.container.monitor.checkProduct(id!, { trigger: 'manual' });
    expect(harness.container.monitor.isChecking(id!)).toBe(true);

    const tick = await harness.container.scheduler.runTick();

    // The product was due, but the scheduler recognised the in-flight check.
    expect(tick?.due).toBe(1);
    expect(tick?.checked).toBe(0);
    expect(tick?.skipped).toBe(1);

    harness.fetcher.release();
    await manual;
  });

  it('never runs two ticks at the same time', async () => {
    const ids = await addProducts(2);
    for (const id of ids) await makeDue(harness.container, id, 20);

    harness.fetcher.hold();
    const first = harness.container.scheduler.runTick();

    // Let the first tick reach the fetcher before the second one starts.
    await new Promise((resolve) => setImmediate(resolve));

    const second = await harness.container.scheduler.runTick();
    expect(second).toBeNull();
    expect(harness.container.scheduler.status().tickInProgress).toBe(true);

    harness.fetcher.release();
    const firstSummary = await first;

    expect(firstSummary?.checked).toBe(2);
    expect(harness.container.scheduler.status().tickInProgress).toBe(false);
  });

  it('honours the concurrency limit', async () => {
    await harness.container.settings.update({ maxConcurrentChecks: 2 });

    const ids = await addProducts(6);
    for (const id of ids) await makeDue(harness.container, id, 20);

    // Real latency is needed for fetches to overlap at all.
    harness.fetcher.delayMs = 15;
    // Reset the peak recorded during the sequential addProduct calls.
    harness.fetcher.peakConcurrent = 0;

    const tick = await harness.container.scheduler.runTick();

    expect(tick?.checked).toBe(6);
    // Work was genuinely parallel, but never exceeded the configured cap.
    expect(harness.fetcher.peakConcurrent).toBe(2);
  });

  it('runs serially when the concurrency limit is one', async () => {
    await harness.container.settings.update({ maxConcurrentChecks: 1 });

    const ids = await addProducts(4);
    for (const id of ids) await makeDue(harness.container, id, 20);

    harness.fetcher.delayMs = 10;
    harness.fetcher.peakConcurrent = 0;

    const tick = await harness.container.scheduler.runTick();

    expect(tick?.checked).toBe(4);
    expect(harness.fetcher.peakConcurrent).toBe(1);
  });

  it('checks every due product exactly once per tick', async () => {
    const ids = await addProducts(4);
    for (const id of ids) await makeDue(harness.container, id, 20);
    harness.fetcher.calls.length = 0;

    await harness.container.scheduler.runTick();

    expect(harness.fetcher.calls).toHaveLength(4);
    expect(new Set(harness.fetcher.calls).size).toBe(4);
  });

  // --- status / lifecycle ------------------------------------------------

  it('reports its status', async () => {
    const [id] = await addProducts(1);
    await makeDue(harness.container, id!, 20);

    const before = harness.container.scheduler.status();
    expect(before.intervalMinutes).toBe(15);
    expect(before.totalTicks).toBe(0);

    await harness.container.scheduler.runTick();

    const after = harness.container.scheduler.status();
    expect(after.totalTicks).toBe(1);
    expect(after.totalChecks).toBe(1);
    expect(after.lastTick?.checked).toBe(1);
    expect(after.lastTickFinishedAt).not.toBeNull();
  });

  it('picks up a new interval immediately', async () => {
    expect(harness.container.scheduler.status().intervalMinutes).toBe(15);

    await harness.container.settings.update({ monitorIntervalMinutes: 1 });

    expect(harness.container.scheduler.status().intervalMinutes).toBe(1);
  });

  it('survives a product being deleted mid-tick', async () => {
    const ids = await addProducts(2);
    for (const id of ids) await makeDue(harness.container, id, 20);

    harness.fetcher.hold();
    const tick = harness.container.scheduler.runTick();
    await new Promise((resolve) => setImmediate(resolve));

    // Remove one product while the tick is in flight.
    await harness.container.repositories.products.delete(ids[1]!);
    harness.fetcher.release();

    const summary = await tick;
    // The tick completed rather than throwing.
    expect(summary).not.toBeNull();
    expect((summary?.checked ?? 0) + (summary?.failed ?? 0)).toBe(2);
  });
});

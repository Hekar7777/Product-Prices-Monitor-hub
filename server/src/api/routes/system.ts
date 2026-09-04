import { Router } from 'express';
import type { AppContainer } from '../../app/container.js';
import type { CheckLogStatus } from '../../domain/types.js';
import { logger, onLog, type LogRecord } from '../../logger.js';
import { asyncHandler, enumQuery, intQuery } from '../middleware.js';
import { serializeCheckLog } from '../serializers.js';

/**
 * Health, scheduler control and log inspection.
 *
 * A rolling in-memory buffer of recent application log records is kept so the
 * dashboard can surface scheduler and extraction problems without the user
 * having to tail a file.
 */
const LOG_BUFFER_LIMIT = 500;
const recentLogs: LogRecord[] = [];

onLog((record) => {
  recentLogs.push(record);
  if (recentLogs.length > LOG_BUFFER_LIMIT) recentLogs.shift();
});

const CHECK_STATUSES = ['all', 'success', 'failed', 'skipped'] as const;

export function createSystemRouter(container: AppContainer): Router {
  const router = Router();

  router.get(
    '/health',
    asyncHandler(async (_req, res) => {
      // A cheap query proves Supabase is actually reachable.
      let database = 'ok';
      try {
        const { error } = await container.db.client.from('settings').select('key').limit(1);
        if (error) database = `error: ${error.message}`;
      } catch (err) {
        database = err instanceof Error ? `error: ${err.message}` : 'error';
      }

      const scheduler = container.scheduler.status();
      const healthy = database === 'ok';

      res.status(healthy ? 200 : 503).json({
        status: healthy ? 'ok' : 'degraded',
        uptimeSeconds: Math.round(process.uptime()),
        database,
        scheduler: {
          running: scheduler.running,
          monitoringEnabled: scheduler.monitoringEnabled,
          intervalMinutes: scheduler.intervalMinutes,
          activeChecks: scheduler.activeChecks,
        },
      });
    }),
  );

  router.get(
    '/overview',
    asyncHandler(async (_req, res) => {
      res.json({
        overview: await container.products.overview(container.monitor.runningCount()),
        scheduler: container.scheduler.status(),
      });
    }),
  );

  router.get(
    '/scheduler',
    asyncHandler(async (_req, res) => {
      res.json({ scheduler: container.scheduler.status() });
    }),
  );

  /**
   * Runs a monitoring pass immediately instead of waiting for the next tick.
   * Useful after adding several products, and used by the "Check all now"
   * dashboard action.
   */
  router.post(
    '/scheduler/run',
    asyncHandler(async (_req, res) => {
      const summary = await container.scheduler.runTick();
      res.json({
        ran: summary !== null,
        reason:
          summary === null
            ? container.settings.get('monitoringEnabled')
              ? 'A tick is already in progress.'
              : 'Monitoring is disabled in settings.'
            : null,
        tick: summary,
        scheduler: container.scheduler.status(),
      });
    }),
  );

  /** Check audit trail: every attempt, including failures that changed nothing. */
  router.get(
    '/logs/checks',
    asyncHandler(async (req, res) => {
      const status = enumQuery(req, 'status', CHECK_STATUSES, 'all');
      const limit = intQuery(req, 'limit', 100, 1, 500);

      const entries = await container.repositories.checkLogs.list({
        limit,
        ...(status === 'all' ? {} : { status: status as CheckLogStatus }),
      });

      // Resolve product names in one pass rather than per row.
      const names = new Map<number, string>();
      for (const product of await container.repositories.products.list()) {
        names.set(product.id, product.productName);
      }

      const [success, failed, skipped] = await Promise.all([
        container.repositories.checkLogs.countByStatus('success'),
        container.repositories.checkLogs.countByStatus('failed'),
        container.repositories.checkLogs.countByStatus('skipped'),
      ]);

      res.json({
        logs: entries.map((entry) =>
          serializeCheckLog(entry, entry.productId ? names.get(entry.productId) ?? null : null),
        ),
        counts: { success, failed, skipped },
      });
    }),
  );

  /** Recent structured application log records. */
  router.get(
    '/logs/app',
    asyncHandler(async (req, res) => {
      const limit = intQuery(req, 'limit', 200, 1, LOG_BUFFER_LIMIT);
      res.json({
        level: logger.getLevel(),
        logs: recentLogs.slice(-limit).reverse(),
      });
    }),
  );

  return router;
}

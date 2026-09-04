import { Router } from 'express';
import type { AppContainer } from '../../app/container.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors.js';
import { asyncHandler } from '../middleware.js';

/**
 * Cron-triggered price check.
 *
 * Replaces the previous in-process `setInterval` scheduler. An external
 * scheduler (see `.github/workflows/check-prices.yml`) calls this endpoint on
 * a fixed cadence; the endpoint itself just runs one `runTick()` pass and
 * returns its summary. `MonitoringScheduler.runTick()` is exactly the same
 * due-selection / concurrency-capped / failure-isolated logic that used to
 * run on a timer - only the trigger moved from "internal timer" to "external
 * HTTP call".
 *
 * Protected by a shared secret (`CRON_SECRET`) passed via the `x-cron-secret`
 * header, checked with a constant-time comparison so response timing cannot
 * be used to guess the secret byte-by-byte.
 */
export function createCronRouter(container: AppContainer): Router {
  const router = Router();

  router.post(
    '/check-prices',
    asyncHandler(async (req, res) => {
      if (!env.cronSecret) {
        // Fail closed: an unconfigured secret must not silently allow every
        // request through.
        throw AppError.internal(
          'CRON_SECRET is not configured on the server; refusing to run the check.',
        );
      }

      const provided = req.header('x-cron-secret') ?? '';
      if (!timingSafeEqual(provided, env.cronSecret)) {
        res.status(401).json({
          error: { code: 'UNAUTHORIZED', message: 'Missing or incorrect x-cron-secret header.' },
        });
        return;
      }

      const tick = await container.scheduler.runTick();
      res.json({
        ran: tick !== null,
        reason:
          tick === null
            ? container.settings.get('monitoringEnabled')
              ? 'A tick is already in progress.'
              : 'Monitoring is disabled in settings.'
            : null,
        tick,
      });
    }),
  );

  return router;
}

/** Constant-time string comparison, used for the shared-secret check above. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

import { createApp } from './app/createApp.js';
import { createContainer } from './app/container.js';
import { env } from './config/env.js';
import { logger, serialiseError } from './logger.js';

/**
 * Process entry point.
 *
 * There is no in-process scheduler to start anymore: price checks are
 * triggered by an authenticated POST to /api/cron/check-prices (see
 * `api/routes/cron.ts`), driven externally by `.github/workflows/check-prices.yml`.
 * This process only needs to be up and reachable when that request arrives.
 */
async function main(): Promise<void> {
  const container = await createContainer();
  const app = createApp(container);

  const server = app.listen(env.port, env.host, () => {
    logger.info('Flipkart price monitor is running', {
      component: 'app',
      url: `http://${env.host}:${env.port}`,
      environment: env.nodeEnv,
      intervalMinutes: container.settings.get('monitorIntervalMinutes'),
      monitoringEnabled: container.settings.get('monitoringEnabled'),
      maxConcurrentChecks: container.settings.get('maxConcurrentChecks'),
    });

    if (env.host === '0.0.0.0' || env.host === '::') {
      logger.warn(
        'The API is bound to all interfaces and has no authentication. Anyone who can reach this port can read and modify monitored products.',
        { component: 'app', host: env.host },
      );
    }
  });

  server.on('error', (err) => {
    logger.error('HTTP server error', { component: 'app', ...serialiseError(err) });
    process.exitCode = 1;
  });

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('Shutting down', { component: 'app', signal });

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Do not hang forever on lingering keep-alive sockets.
      setTimeout(resolve, 5_000).unref();
    });

    await container.shutdown();
    logger.info('Shutdown complete', { component: 'app' });
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
      component: 'app',
      ...serialiseError(reason),
    });
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { component: 'app', ...serialiseError(err) });
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.error('Failed to start the application', { component: 'app', ...serialiseError(err) });
  process.exit(1);
});

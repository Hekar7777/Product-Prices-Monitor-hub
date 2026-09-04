import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, { type Express } from 'express';
import { createApiRouter } from '../api/index.js';
import { errorHandler, notFoundHandler, requestLogger } from '../api/middleware.js';
import { REPO_ROOT, env } from '../config/env.js';
import { logger } from '../logger.js';
import type { AppContainer } from './container.js';

/**
 * Builds the Express application.
 *
 * The API is mounted under `/api`. When a production web build exists at
 * `web/dist`, it is served from the same origin so the whole app runs on one
 * port; in development Vite proxies `/api` instead.
 *
 * Note on access control: this service has no authentication. It is designed as
 * a single-user local tool and binds to 127.0.0.1 by default. Exposing it on a
 * public interface would let anyone read or modify the monitored product list,
 * so put it behind a reverse proxy with authentication first.
 */
export function createApp(container: AppContainer): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use(
    cors({
      origin: env.corsOrigins.length > 0 ? env.corsOrigins : false,
      credentials: false,
    }),
  );

  // Request bodies are tiny (a URL, a settings patch); cap them accordingly.
  app.use(express.json({ limit: '32kb' }));
  app.use(requestLogger);

  app.use('/api', createApiRouter(container));

  const webDist = path.join(REPO_ROOT, 'web', 'dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    logger.info('Serving the dashboard build', { component: 'http', dir: webDist });
    app.use(express.static(webDist));

    // Client-side routing: anything that is not an API call returns index.html.
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

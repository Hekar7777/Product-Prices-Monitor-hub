import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asyncHandler, errorHandler, notFoundHandler } from '../src/api/middleware.js';

/**
 * Regression coverage for the diagnostic-message improvement to the central
 * error handler (`server/src/api/middleware.ts`).
 *
 * Before this change, any unhandled/unexpected error (e.g. a Supabase query
 * throwing something other than an `AppError`/`FetchError`/`ZodError`) always
 * produced the same opaque body: `{ error: { code: 'INTERNAL_ERROR', message:
 * 'Something went wrong on the server.' } }`, with no way to tell from the
 * client what actually failed short of reading server logs. This suite
 * builds a minimal Express app around the real `errorHandler` and asserts:
 *
 *   - Outside production, the response includes the thrown error's own
 *     message/name as `error.details`, so "Request failed with status 500."
 *     is no longer the only information available in development/logs.
 *   - In production, that detail is withheld and the response stays generic
 *     - no stack trace or internal message ever reaches a production client.
 *   - The response body never contains a stack trace, in either mode.
 */
function buildApp(): express.Express {
  const app = express();
  app.get(
    '/boom',
    asyncHandler(async () => {
      throw new Error('Supabase query failed (products.list): relation "products" does not exist');
    }),
  );
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('errorHandler: unhandled error diagnostics', () => {
  afterEach(() => {
    process.env.NODE_ENV = 'test';
  });

  it('includes the underlying error message as details when not running in production', async () => {
    process.env.NODE_ENV = 'test';
    const response = await request(buildApp()).get('/boom').expect(500);

    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(response.body.error.message).toBe('Something went wrong on the server.');
    expect(response.body.error.details).toMatchObject({
      name: 'Error',
      message: expect.stringContaining('relation "products" does not exist'),
    });
  });

  it('never includes a stack trace in the response body', async () => {
    const response = await request(buildApp()).get('/boom').expect(500);
    expect(JSON.stringify(response.body)).not.toMatch(/at asyncHandler|at Layer|\.ts:\d+:\d+/);
  });

  it('withholds the diagnostic detail in production, keeping only the generic message', async () => {
    // `env.ts` reads NODE_ENV once at module-load time (see its own
    // comments), so the module registry must be reset and every transitive
    // import re-done dynamically *after* setting NODE_ENV=production, exactly
    // like `scripts/e2eVerify.ts` does for CRON_SECRET.
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    vi.resetModules();

    try {
      const expressModule = await import('express');
      const supertestModule = await import('supertest');
      const { asyncHandler: prodAsyncHandler, errorHandler: prodErrorHandler, notFoundHandler: prodNotFoundHandler } =
        await import('../src/api/middleware.js');

      const app = expressModule.default();
      app.get(
        '/boom',
        prodAsyncHandler(async () => {
          throw new Error('some internal detail that must not reach a production client');
        }),
      );
      app.use(prodNotFoundHandler);
      app.use(prodErrorHandler);

      const response = await supertestModule.default(app).get('/boom').expect(500);

      expect(response.body.error).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong on the server.',
      });
      expect(response.body.error.details).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toContain('some internal detail');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      vi.resetModules();
    }
  });
});

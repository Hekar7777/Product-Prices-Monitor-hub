import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { AppError, FetchError, describeFetchError } from '../errors.js';
import { logger, serialiseError } from '../logger.js';

const log = logger.child({ component: 'http' });

/** Wraps an async handler so rejections reach Express' error pipeline. */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

/** One structured log line per request, with status and duration. */
export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const fields = {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    };
    if (res.statusCode >= 500) log.error('Request failed', fields);
    else if (res.statusCode >= 400) log.warn('Request rejected', fields);
    else log.debug('Request handled', fields);
  });

  next();
};

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route matches ${req.method} ${req.path}` },
  });
};

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

interface BodyParserError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
  expose?: boolean;
}

/** Detects the body-parser/raw-body errors express.json() throws on bad input. */
function isBodyParserError(err: unknown): err is BodyParserError {
  if (!(err instanceof Error)) return false;
  const candidate = err as BodyParserError;
  if (candidate.type === 'entity.too.large' || candidate.type === 'entity.parse.failed') {
    return true;
  }
  // Malformed JSON surfaces as a bare SyntaxError with status 400 attached by
  // body-parser, and no `type` field in some versions.
  return (
    err instanceof SyntaxError && (candidate.status === 400 || candidate.statusCode === 400)
  );
}

/**
 * Central error translator. Domain errors map onto meaningful HTTP statuses;
 * anything unrecognised becomes a 500 without leaking internals to the client.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;

  if (err instanceof AppError) {
    const body: ApiErrorBody = { error: { code: err.code, message: err.message } };
    if (err.details !== undefined) body.error.details = err.details;
    res.status(err.statusCode).json(body);
    return;
  }

  if (err instanceof FetchError) {
    res.status(422).json({
      error: {
        code: err.code,
        message: describeFetchError(err.code),
        details: { detail: err.message, url: err.url ?? null },
      },
    } satisfies ApiErrorBody);
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'BAD_REQUEST',
        message: 'Request validation failed.',
        details: err.issues.map((issue) => ({
          field: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      },
    } satisfies ApiErrorBody);
    return;
  }

  // express.json() throws a plain SyntaxError (via body-parser) for malformed
  // JSON bodies, and a plain Error with `.type === 'entity.too.large'` for an
  // oversized body. Neither is a server fault - both are bad requests.
  if (isBodyParserError(err)) {
    log.warn('Rejected a malformed request body', {
      method: req.method,
      path: req.originalUrl,
      reason: err.message,
    });
    res.status(400).json({
      error: {
        code: 'BAD_REQUEST',
        message:
          err.type === 'entity.too.large'
            ? 'Request body is too large.'
            : 'Request body is not valid JSON.',
      },
    } satisfies ApiErrorBody);
    return;
  }

  const serialised = serialiseError(err);

  log.error('Unhandled error while serving a request', {
    method: req.method,
    path: req.originalUrl,
    ...serialised,
  });

  // In production, never say more than "something went wrong" - the full
  // error (including stack traces) is always in the server logs via the
  // `log.error` call above, which is the right place to look for it.
  //
  // Outside production (development, test, or any other NODE_ENV value),
  // include the error's own message and a `name`/`code` if present, so a
  // failure like a missing Supabase table or a bad query does not present as
  // an opaque "Request failed with status 500." in the browser console -
  // this is what the client's diagnostic message is built from. This never
  // includes a stack trace or environment values in the response body, only
  // the message the thrown error itself already carries.
  const body: ApiErrorBody = {
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server.' },
  };

  if (!env.isProduction) {
    body.error.details = {
      name: typeof serialised.name === 'string' ? serialised.name : undefined,
      message: typeof serialised.message === 'string' ? serialised.message : String(err),
    };
  }

  res.status(500).json(body);
}

/** Parses and validates a positive integer route parameter. */
export function requireIdParam(req: Request, name = 'id'): number {
  const raw = req.params[name];
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest(`"${name}" must be a positive integer.`);
  }
  return id;
}

/** Reads a bounded integer query parameter. */
export function intQuery(
  req: Request,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = req.query[name];
  if (raw === undefined) return fallback;
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Reads a string query parameter constrained to a known set. */
export function enumQuery<T extends string>(
  req: Request,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = req.query[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return fallback;
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

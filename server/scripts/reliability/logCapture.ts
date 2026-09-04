import { onLog, type LogRecord } from '../../src/logger.js';
import type { AttemptLogEntry } from './types.js';

/** Structured-log message strings the fetcher stack emits per attempt. */
const ATTEMPT_MESSAGES = new Set([
  'Product fetch attempt failed',
  'Escalating to the next extraction strategy',
  'Fetched product over HTTP',
  'Fetched product with Chromium',
  'HTTP fetch failed',
  'Chromium fetch failed',
]);

/**
 * Captures the production fetcher's own structured log lines for one
 * `fetchProduct()` call, so the diagnostic report can show exactly which
 * retries/escalations happened - straight from the code that runs in
 * production (`resilientFetcher.ts`, `httpFetcher.ts`, `playwrightFetcher.ts`),
 * not a re-implementation of it.
 *
 * Attribution is by the `url` field every one of those log lines already
 * carries. This is safe under concurrency as long as the same URL is never
 * fetched twice at once (the runner in `run.ts` guarantees that within a
 * round), since two different URLs never share a log line.
 */
export class AttemptLogCapture {
  private readonly buffer: LogRecord[] = [];
  private readonly unsubscribe: () => void;

  constructor() {
    this.unsubscribe = onLog((record) => {
      if (typeof record.msg === 'string' && ATTEMPT_MESSAGES.has(record.msg)) {
        this.buffer.push(record);
      }
    });
  }

  /** Pulls out (and removes) every captured log line for `url` since `sinceIso`. */
  drain(url: string, sinceIso: string): AttemptLogEntry[] {
    const matched: LogRecord[] = [];
    const remaining: LogRecord[] = [];

    for (const record of this.buffer) {
      if (record.url === url && record.time >= sinceIso) matched.push(record);
      else remaining.push(record);
    }

    this.buffer.length = 0;
    this.buffer.push(...remaining);

    return matched
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((record) => ({
        strategy: String(record.strategy ?? record.from ?? 'unknown'),
        attempt: typeof record.attempt === 'number' ? record.attempt : 0,
        code: String(record.code ?? (record.msg?.toString().includes('Fetched') ? 'OK' : 'UNKNOWN')),
        httpStatus: typeof record.status === 'number' ? record.status : null,
        willRetry: Boolean(record.willRetry),
        message: String(record.msg),
      }));
  }

  dispose(): void {
    this.unsubscribe();
  }
}

#!/usr/bin/env -S node --import tsx
/**
 * Flipkart price-fetch reliability diagnostic.
 *
 * Measures how often the CURRENT PRODUCTION fetching/extraction code
 * actually succeeds at reading a live Flipkart price, and classifies every
 * failure. This does not modify, mock, or reimplement any part of the
 * extraction pipeline - it imports and calls:
 *
 *   createFlipkartFetcher()      (server/src/fetcher/index.ts)
 *     -> ResilientFlipkartFetcher  (retries, backoff, strategy escalation)
 *       -> HttpFlipkartFetcher      (plain HTTP + the 5-parser HTML pipeline)
 *       -> PlaywrightFlipkartFetcher (headless Chromium fallback)
 *
 * exactly as `createContainer()` does for the real running server. Nothing
 * else - no product/price-history/notification/database code executes, so
 * this tool is structurally incapable of recording a price change or
 * mutating application data. It only reads pages and counts outcomes.
 *
 * USAGE
 *   npm --workspace server run reliability -- [options]
 *
 * OPTIONS
 *   --rounds <n>            How many times to check every URL (default 1)
 *   --interval-min <n>      Minutes to wait between rounds (default 20)
 *   --concurrency <n>       Parallel checks within a round (default 1)
 *   --delay-ms <n>          Delay between individual checks within a round
 *                           (default 4000; ignored when --concurrency > 1)
 *   --strategy <s>          auto | http | playwright (default: auto, same
 *                           as production's FETCH_STRATEGY default)
 *   --timeout-ms <n>        Per-attempt timeout (default: production default,
 *                           30000)
 *   --max-attempts <n>      Retries per strategy (default: production
 *                           default, 3)
 *   --urls-file <path>      JSON file of [{ "url", "label" }, ...] to use
 *                           instead of the built-in representative list
 *   --out-dir <path>        Where to write the raw JSONL / CSV / report.txt
 *                           (default: server/reliability-runs/<timestamp>/)
 *   --max-duration-min <n>  Stop starting new rounds after this many minutes
 *                           have elapsed (useful for a "run overnight" cap)
 *
 * CONSERVATIVE DEFAULTS BY DESIGN: concurrency 1, a multi-second delay
 * between individual checks, and a 20-minute gap between full rounds. This
 * is intentionally gentler than production's own default (15-minute
 * per-product interval, up to 3 concurrent checks) so a diagnostic run does
 * not add meaningfully to Flipkart's request load. Override deliberately if
 * you want a tighter test, but nothing here defaults to hammering the site.
 *
 * The tool writes every result to disk as it goes (JSON Lines), so a run
 * left going for hours or days survives an interruption (Ctrl+C, terminal
 * closed, laptop sleep) with all data collected up to that point intact and
 * summarisable on its own - see `summarise.ts` to regenerate the report from
 * a partial `records.jsonl` at any time without re-running anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFlipkartFetcher } from '../../src/fetcher/index.js';
import type { FetchStrategy } from '../../src/config/env.js';
import { FetchError } from '../../src/errors.js';
import { logger } from '../../src/logger.js';
import { classifyOutcome } from './classify.js';
import { AttemptLogCapture } from './logCapture.js';
import { renderReport, summarise, toCsv } from './report.js';
import type { CheckRecord, RunConfig } from './types.js';
import { DEFAULT_TEST_URLS, type TestUrl } from './urls.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface Cli {
  rounds: number;
  intervalMinutes: number;
  concurrency: number;
  delayMs: number;
  strategy: FetchStrategy;
  timeoutMs: number;
  maxAttempts: number;
  urlsFile: string | null;
  outDir: string | null;
  maxDurationMinutes: number | null;
}

function parseArgs(argv: string[]): Cli {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const num = (flag: string, fallback: number): number => {
    const raw = get(flag);
    const parsed = raw !== undefined ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const strategyRaw = get('--strategy') ?? 'auto';
  const strategy: FetchStrategy =
    strategyRaw === 'http' || strategyRaw === 'playwright' ? strategyRaw : 'auto';

  return {
    rounds: num('--rounds', 1),
    intervalMinutes: num('--interval-min', 20),
    concurrency: Math.max(1, num('--concurrency', 1)),
    delayMs: num('--delay-ms', 4000),
    strategy,
    timeoutMs: num('--timeout-ms', 30_000),
    maxAttempts: num('--max-attempts', 3),
    urlsFile: get('--urls-file') ?? null,
    outDir: get('--out-dir') ?? null,
    maxDurationMinutes: get('--max-duration-min') ? num('--max-duration-min', 0) : null,
  };
}

function loadUrls(cli: Cli): TestUrl[] {
  if (!cli.urlsFile) return DEFAULT_TEST_URLS;
  const raw = fs.readFileSync(cli.urlsFile, 'utf-8');
  const parsed = JSON.parse(raw) as TestUrl[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${cli.urlsFile} must contain a non-empty JSON array of { url, label }`);
  }
  return parsed;
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const urls = loadUrls(cli);

  const outDir =
    cli.outDir ??
    path.join(HERE, '..', '..', 'reliability-runs', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(outDir, { recursive: true });

  const jsonlPath = path.join(outDir, 'records.jsonl');
  const configPath = path.join(outDir, 'config.json');
  const reportPath = path.join(outDir, 'report.txt');
  const csvPath = path.join(outDir, 'records.csv');

  const config: RunConfig = {
    strategy: cli.strategy,
    timeoutMs: cli.timeoutMs,
    maxAttempts: cli.maxAttempts,
    headless: true,
    concurrency: cli.concurrency,
    perCheckDelayMs: cli.concurrency > 1 ? 0 : cli.delayMs,
    intervalMinutes: cli.intervalMinutes,
  };
  fs.writeFileSync(configPath, JSON.stringify({ ...config, rounds: cli.rounds, urls }, null, 2));

  logger.setLevel('warn'); // Keep stdout to this tool's own progress lines.

  console.log('Flipkart price-fetch reliability diagnostic');
  console.log(`  URLs           : ${urls.length}`);
  console.log(`  Rounds         : ${cli.rounds}${cli.rounds > 1 ? ` (every ${cli.intervalMinutes} min)` : ''}`);
  console.log(`  Strategy       : ${cli.strategy}`);
  console.log(`  Concurrency    : ${cli.concurrency}`);
  console.log(`  Output dir     : ${outDir}`);
  console.log('  (production fetcher code, unmodified - see server/src/fetcher/)');
  console.log('  Ctrl+C to stop early; partial results are already saved and reportable.\n');

  // The exact same factory `createContainer()` uses for the real server.
  const fetcher = createFlipkartFetcher({
    strategy: cli.strategy,
    timeoutMs: cli.timeoutMs,
    maxAttempts: cli.maxAttempts,
    headless: true,
  });

  const logCapture = new AttemptLogCapture();
  const records: CheckRecord[] = [];
  const jsonlStream = fs.createWriteStream(jsonlPath, { flags: 'a' });

  let stopRequested = false;
  const onSigint = () => {
    if (stopRequested) return;
    stopRequested = true;
    console.log('\nStopping after the current check finishes... (partial results are saved)');
  };
  process.on('SIGINT', onSigint);

  const runStartedAt = Date.now();

  async function checkOne(target: TestUrl, round: number): Promise<void> {
    const startedAtIso = new Date().toISOString();
    const startedAt = Date.now();

    let record: CheckRecord;

    try {
      const result = await fetcher.fetchProduct(target.url);
      const durationMs = Date.now() - startedAt;
      const attemptLog = logCapture.drain(target.url, startedAtIso);

      record = {
        timestamp: startedAtIso,
        round,
        url: target.url,
        label: target.label,
        outcome: 'success',
        category: 'SUCCESS',
        fetchErrorCode: null,
        httpStatus: result.meta.httpStatus,
        strategyChain: fetcher.name,
        finalStrategy: result.meta.strategy,
        extractedBy: result.meta.extractedBy ?? null,
        attempts: result.meta.attempts,
        durationMs,
        errorMessage: null,
        price: result.product.price,
        attemptLog,
      };

      console.log(
        `  [round ${round}] OK      ${target.label.padEnd(32)} ₹${result.product.price}` +
          ` (${result.meta.strategy}, ${durationMs}ms, ${result.meta.attempts} attempt(s))`,
      );
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const error = err instanceof FetchError ? err : FetchError.from(err);
      const attemptLog = logCapture.drain(target.url, startedAtIso);
      const category = classifyOutcome(error.code, error.status ?? null);

      record = {
        timestamp: startedAtIso,
        round,
        url: target.url,
        label: target.label,
        outcome: 'failure',
        category,
        fetchErrorCode: error.code,
        httpStatus: error.status ?? null,
        strategyChain: fetcher.name,
        finalStrategy: error.strategy ?? null,
        extractedBy: null,
        attempts: attemptLog.length > 0 ? attemptLog.length : 1,
        durationMs,
        errorMessage: error.message,
        price: null,
        attemptLog,
      };

      console.log(
        `  [round ${round}] FAIL    ${target.label.padEnd(32)} ${category}` +
          ` (${error.code}${error.status ? ` / HTTP ${error.status}` : ''}, ${durationMs}ms)`,
      );
    }

    records.push(record);
    jsonlStream.write(JSON.stringify(record) + '\n');
  }

  let round = 1;
  while (round <= cli.rounds && !stopRequested) {
    if (
      cli.maxDurationMinutes !== null &&
      Date.now() - runStartedAt > cli.maxDurationMinutes * 60_000
    ) {
      console.log(`Reached --max-duration-min (${cli.maxDurationMinutes} min); stopping.`);
      break;
    }

    console.log(`--- Round ${round}/${cli.rounds} ---`);

    if (cli.concurrency > 1) {
      // Bounded worker pool - never more than `concurrency` fetches in flight,
      // and never two requests for the same URL at once within a round.
      const queue = [...urls];
      const workers = Array.from({ length: Math.min(cli.concurrency, urls.length) }, async () => {
        while (queue.length > 0 && !stopRequested) {
          const target = queue.shift();
          if (!target) return;
          await checkOne(target, round);
        }
      });
      await Promise.all(workers);
    } else {
      for (const target of urls) {
        if (stopRequested) break;
        await checkOne(target, round);
        if (target !== urls[urls.length - 1]) await sleep(cli.delayMs);
      }
    }

    round += 1;

    if (round <= cli.rounds && !stopRequested) {
      console.log(`Waiting ${cli.intervalMinutes} min before the next round...\n`);
      await sleep(cli.intervalMinutes * 60_000);
    }
  }

  process.off('SIGINT', onSigint);
  logCapture.dispose();
  await fetcher.close?.();
  jsonlStream.end();

  const summary = summarise(records);
  const reportText = renderReport(summary, config);

  fs.writeFileSync(reportPath, reportText);
  fs.writeFileSync(csvPath, toCsv(records));
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n' + reportText);
  console.log(`\nRaw records : ${jsonlPath}`);
  console.log(`CSV         : ${csvPath}`);
  console.log(`Report      : ${reportPath}`);
  console.log(`Summary JSON: ${path.join(outDir, 'summary.json')}`);
}

main().catch((err) => {
  console.error('Reliability diagnostic crashed:', err);
  process.exitCode = 1;
});

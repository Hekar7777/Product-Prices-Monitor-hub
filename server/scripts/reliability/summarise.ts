#!/usr/bin/env -S node --import tsx
/**
 * Regenerates report.txt / summary.json / records.csv from a `records.jsonl`
 * file, without re-running any checks.
 *
 * Useful for a long-running diagnostic left going for hours or days: point
 * this at the run's output directory at any point (including while the run
 * is still going, or after killing it early) to get an up-to-date report
 * from whatever has been collected so far.
 *
 * USAGE
 *   npm --workspace server run reliability:summarise -- <run-dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderReport, summarise, toCsv } from './report.js';
import type { CheckRecord, RunConfig } from './types.js';

function main(): void {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error('Usage: reliability:summarise -- <run-dir>');
    process.exitCode = 1;
    return;
  }

  const jsonlPath = path.join(runDir, 'records.jsonl');
  const configPath = path.join(runDir, 'config.json');

  if (!fs.existsSync(jsonlPath)) {
    console.error(`No records.jsonl found in ${runDir}`);
    process.exitCode = 1;
    return;
  }

  const records: CheckRecord[] = fs
    .readFileSync(jsonlPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as CheckRecord);

  const config: RunConfig = fs.existsSync(configPath)
    ? (JSON.parse(fs.readFileSync(configPath, 'utf-8')) as RunConfig)
    : {
        strategy: 'auto',
        timeoutMs: 30_000,
        maxAttempts: 3,
        headless: true,
        concurrency: 1,
        perCheckDelayMs: 0,
        intervalMinutes: 0,
      };

  const summary = summarise(records);
  const reportText = renderReport(summary, config);

  fs.writeFileSync(path.join(runDir, 'report.txt'), reportText);
  fs.writeFileSync(path.join(runDir, 'records.csv'), toCsv(records));
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(reportText);
  console.log(`\n(Regenerated from ${records.length} record(s) in ${jsonlPath})`);
}

main();

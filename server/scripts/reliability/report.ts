import { CATEGORY_LABELS, CATEGORY_ORDER } from './classify.js';
import type { CheckRecord, ReliabilityCategory, RunConfig } from './types.js';

export interface UrlSummary {
  url: string;
  label: string;
  total: number;
  successes: number;
  failures: number;
  successRate: number;
  categoryCounts: Record<ReliabilityCategory, number>;
  avgDurationMsSuccess: number | null;
  avgDurationMsFailure: number | null;
}

export interface OverallSummary {
  totalChecks: number;
  totalUrls: number;
  totalRounds: number;
  startedAt: string;
  finishedAt: string;
  wallClockMs: number;
  successes: number;
  failures: number;
  successRatePct: number;
  categoryCounts: Record<ReliabilityCategory, number>;
  categoryPct: Record<ReliabilityCategory, number>;
  avgDurationMsSuccess: number | null;
  avgDurationMsFailure: number | null;
  p50DurationMsSuccess: number | null;
  p95DurationMsSuccess: number | null;
  perUrl: UrlSummary[];
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? null;
}

function emptyCategoryCounts(): Record<ReliabilityCategory, number> {
  const out = {} as Record<ReliabilityCategory, number>;
  for (const cat of CATEGORY_ORDER) out[cat] = 0;
  return out;
}

export function summarise(records: CheckRecord[]): OverallSummary {
  const categoryCounts = emptyCategoryCounts();
  const successDurations: number[] = [];
  const failureDurations: number[] = [];
  const byUrl = new Map<string, CheckRecord[]>();

  for (const record of records) {
    categoryCounts[record.category] += 1;
    if (record.outcome === 'success') successDurations.push(record.durationMs);
    else failureDurations.push(record.durationMs);

    const list = byUrl.get(record.url) ?? [];
    list.push(record);
    byUrl.set(record.url, list);
  }

  const successes = records.filter((r) => r.outcome === 'success').length;
  const failures = records.length - successes;

  const timestamps = records.map((r) => r.timestamp).sort();
  const startedAt = timestamps[0] ?? new Date().toISOString();
  const finishedAt = timestamps[timestamps.length - 1] ?? startedAt;

  const categoryPct = {} as Record<ReliabilityCategory, number>;
  for (const cat of CATEGORY_ORDER) {
    categoryPct[cat] = records.length > 0 ? roundPct((categoryCounts[cat] / records.length) * 100) : 0;
  }

  const perUrl: UrlSummary[] = [...byUrl.entries()].map(([url, list]) => {
    const urlCategoryCounts = emptyCategoryCounts();
    const urlSuccessDurations: number[] = [];
    const urlFailureDurations: number[] = [];

    for (const record of list) {
      urlCategoryCounts[record.category] += 1;
      if (record.outcome === 'success') urlSuccessDurations.push(record.durationMs);
      else urlFailureDurations.push(record.durationMs);
    }

    const urlSuccesses = list.filter((r) => r.outcome === 'success').length;

    return {
      url,
      label: list[0]?.label ?? url,
      total: list.length,
      successes: urlSuccesses,
      failures: list.length - urlSuccesses,
      successRate: list.length > 0 ? roundPct((urlSuccesses / list.length) * 100) : 0,
      categoryCounts: urlCategoryCounts,
      avgDurationMsSuccess: average(urlSuccessDurations),
      avgDurationMsFailure: average(urlFailureDurations),
    };
  });

  return {
    totalChecks: records.length,
    totalUrls: byUrl.size,
    totalRounds: records.length > 0 ? Math.max(...records.map((r) => r.round)) : 0,
    startedAt,
    finishedAt,
    wallClockMs: Date.parse(finishedAt) - Date.parse(startedAt),
    successes,
    failures,
    successRatePct: records.length > 0 ? roundPct((successes / records.length) * 100) : 0,
    categoryCounts,
    categoryPct,
    avgDurationMsSuccess: average(successDurations),
    avgDurationMsFailure: average(failureDurations),
    p50DurationMsSuccess: percentile(successDurations, 50),
    p95DurationMsSuccess: percentile(successDurations, 95),
    perUrl,
  };
}

function roundPct(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function formatMs(period: number): string {
  const seconds = Math.round(period / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function bar(pct: number, width = 30): string {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

/** Renders the full human-readable report to a string. */
export function renderReport(summary: OverallSummary, config: RunConfig): string {
  const lines: string[] = [];
  const push = (line = '') => lines.push(line);

  push('═'.repeat(72));
  push('FLIPKART PRICE-FETCH RELIABILITY REPORT');
  push('═'.repeat(72));
  push();
  push('This used the exact production fetching code (createFlipkartFetcher →');
  push('ResilientFlipkartFetcher → HttpFlipkartFetcher/PlaywrightFlipkartFetcher →');
  push('parseFlipkartHtml). No price-comparison, notification, or database code');
  push('ran; nothing here could record a price change.');
  push();
  push(`Checks performed : ${summary.totalChecks} (${summary.totalUrls} URLs × ${summary.totalRounds} round(s))`);
  push(`Period covered    : ${summary.startedAt} → ${summary.finishedAt}`);
  push(`                    (${formatMs(summary.wallClockMs)} wall-clock)`);
  push(`Fetch strategy    : ${config.strategy}  (timeout ${config.timeoutMs}ms, ${config.maxAttempts} attempts/strategy)`);
  push(`Concurrency       : ${config.concurrency} parallel check(s), ${config.perCheckDelayMs}ms delay between rounds`);
  push();
  push('-'.repeat(72));
  push('OVERALL RESULT');
  push('-'.repeat(72));
  push(`Success : ${summary.successes}/${summary.totalChecks}  (${summary.successRatePct}%)`);
  push(`Failure : ${summary.failures}/${summary.totalChecks}  (${roundPct(100 - summary.successRatePct)}%)`);
  push();
  push(`  ${bar(summary.successRatePct)} ${summary.successRatePct}% success`);
  push();
  push('Response time (successful fetches only):');
  push(`  average : ${formatDuration(summary.avgDurationMsSuccess)}`);
  push(`  median  : ${formatDuration(summary.p50DurationMsSuccess)}`);
  push(`  p95     : ${formatDuration(summary.p95DurationMsSuccess)}`);
  if (summary.avgDurationMsFailure !== null) {
    push(`  average time spent on a failing attempt: ${formatDuration(summary.avgDurationMsFailure)}`);
  }
  push();
  push('-'.repeat(72));
  push('BREAKDOWN BY OUTCOME TYPE');
  push('-'.repeat(72));
  for (const cat of CATEGORY_ORDER) {
    const count = summary.categoryCounts[cat];
    if (count === 0) continue;
    const pct = summary.categoryPct[cat];
    push(`  ${CATEGORY_LABELS[cat].padEnd(36)} ${String(count).padStart(4)}  (${pct.toFixed(1).padStart(5)}%)  ${bar(pct, 20)}`);
  }
  push();
  push('-'.repeat(72));
  push('BREAKDOWN BY PRODUCT URL');
  push('-'.repeat(72));
  for (const u of summary.perUrl) {
    push(`  ${u.label}`);
    push(`    ${u.url}`);
    push(
      `    ${u.successes}/${u.total} succeeded (${u.successRate}%)` +
        (u.avgDurationMsSuccess !== null ? ` · avg ${formatDuration(u.avgDurationMsSuccess)}` : ''),
    );
    const failingCats = CATEGORY_ORDER.filter((c) => c !== 'SUCCESS' && u.categoryCounts[c] > 0);
    if (failingCats.length > 0) {
      push(`    failures: ${failingCats.map((c) => `${CATEGORY_LABELS[c]} ×${u.categoryCounts[c]}`).join(', ')}`);
    }
    push();
  }

  push('-'.repeat(72));
  push('WHAT THE CURRENT IMPLEMENTATION ALREADY DOES ABOUT THIS');
  push('-'.repeat(72));
  push('(from server/src/fetcher/resilientFetcher.ts and server/src/config/env.ts)');
  push(`  - Retries          : yes, up to ${config.maxAttempts} attempts per strategy, exponential`);
  push('                       backoff with jitter (750ms base, 5s cap), for');
  push('                       TIMEOUT / NETWORK_ERROR / HTTP_ERROR / PRICE_NOT_FOUND /');
  push('                       PARSE_ERROR / BROWSER_ERROR / UNKNOWN only.');
  push('  - CAPTCHA handling : never retried and never escalated - a challenge page');
  push('                       is treated as a deliberate signal, not a bug to route');
  push('                       around.');
  if (config.strategy === 'auto') {
    push('  - Escalation       : yes, HTTP → Playwright (browser) when the page loads but');
    push('                       the price cannot be located (PRICE_NOT_FOUND /');
    push('                       PARSE_ERROR / HTTP_ERROR).');
  } else {
    push(`  - Escalation       : n/a for this run - strategy was pinned to "${config.strategy}".`);
  }
  push(`  - Concurrency limit: yes, "maxConcurrentChecks" setting (production default 3);`);
  push(`                       this diagnostic itself ran at ${config.concurrency}.`);
  push(`  - Timeout          : yes, ${config.timeoutMs}ms per attempt (configurable).`);
  push('  - Delay between checks: yes, this diagnostic waited between rounds by');
  push(`                       design (${config.perCheckDelayMs}ms); production checks each`);
  push('                       product on its own configured interval, default 15 min.');
  push();
  push('═'.repeat(72));

  return lines.join('\n');
}

export function toCsv(records: CheckRecord[]): string {
  const header = [
    'timestamp',
    'round',
    'url',
    'label',
    'outcome',
    'category',
    'fetchErrorCode',
    'httpStatus',
    'strategyChain',
    'finalStrategy',
    'extractedBy',
    'attempts',
    'durationMs',
    'price',
    'errorMessage',
  ];

  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const rows = records.map((r) =>
    [
      r.timestamp,
      r.round,
      r.url,
      r.label,
      r.outcome,
      r.category,
      r.fetchErrorCode,
      r.httpStatus,
      r.strategyChain,
      r.finalStrategy,
      r.extractedBy,
      r.attempts,
      r.durationMs,
      r.price,
      r.errorMessage,
    ]
      .map(escape)
      .join(','),
  );

  return [header.join(','), ...rows].join('\n');
}

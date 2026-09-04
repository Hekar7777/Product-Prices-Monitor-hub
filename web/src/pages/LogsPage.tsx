import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Spinner } from '../components/indicators';
import { usePoll } from '../hooks/usePoll';
import { api } from '../lib/api';
import { formatDateTime, formatDuration, formatMoney, formatTime } from '../lib/format';

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'success', label: 'Successful' },
  { value: 'failed', label: 'Failed' },
  { value: 'skipped', label: 'Skipped' },
] as const;

const LEVEL_STYLES: Record<string, string> = {
  error: 'text-up',
  warn: 'text-yellow-400',
  info: 'text-accent',
  debug: 'text-muted',
  trace: 'text-muted',
};

/**
 * Diagnostics.
 *
 * The check log makes every attempt visible, including failures that
 * deliberately changed nothing.
 */
export function LogsPage() {
  const [status, setStatus] = useState<string>('all');
  const [tab, setTab] = useState<'checks' | 'app'>('checks');

  const checks = usePoll(
    useCallback(() => api.getCheckLogs({ status, limit: 150 }), [status]),
    15_000,
    `checks-${status}`,
  );

  const appLogs = usePoll(useCallback(() => api.getAppLogs(200), []), 10_000, 'app-logs');

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Logs</h1>
        <p className="mt-1 text-sm text-muted">
          A failed check is recorded but never overwrites the last valid price and never raises a
          price-change notification.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="tablist" aria-label="Log type">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'checks'}
            className={`btn btn-sm ${tab === 'checks' ? 'btn-primary' : ''}`}
            onClick={() => setTab('checks')}
          >
            Check history
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'app'}
            className={`btn btn-sm ${tab === 'app' ? 'btn-primary' : ''}`}
            onClick={() => setTab('app')}
          >
            Application log
          </button>
        </div>

        {tab === 'checks' && (
          <>
            <span className="ml-auto text-xs text-muted">
              {checks.data
                ? `${checks.data.counts.success} success · ${checks.data.counts.failed} failed · ${checks.data.counts.skipped} skipped`
                : ''}
            </span>
            <label htmlFor="log-status" className="sr-only">
              Filter by result
            </label>
            <select
              id="log-status"
              className="input w-auto"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              {STATUS_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      {tab === 'checks' ? (
        <section className="card overflow-hidden">
          {checks.loading ? (
            <div className="p-8 text-center">
              <Spinner label="Loading check history" />
            </div>
          ) : checks.data && checks.data.logs.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] border-collapse">
                <thead className="border-b border-border bg-surfaceAlt/50">
                  <tr>
                    <th scope="col" className="th">
                      When
                    </th>
                    <th scope="col" className="th">
                      Product
                    </th>
                    <th scope="col" className="th">
                      Result
                    </th>
                    <th scope="col" className="th text-right">
                      Price read
                    </th>
                    <th scope="col" className="th">
                      Trigger
                    </th>
                    <th scope="col" className="th">
                      Strategy
                    </th>
                    <th scope="col" className="th text-right">
                      Attempts
                    </th>
                    <th scope="col" className="th text-right">
                      Took
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {checks.data.logs.map((entry) => (
                    <tr key={entry.id} className="hover:bg-surfaceAlt/40">
                      <td className="td whitespace-nowrap">{formatDateTime(entry.finishedAt)}</td>
                      <td className="td max-w-[16rem] truncate">
                        {entry.productId ? (
                          <Link to={`/products/${entry.productId}`} className="hover:text-accent">
                            {entry.productName ?? `#${entry.productId}`}
                          </Link>
                        ) : (
                          <span className="text-muted">(not yet added)</span>
                        )}
                      </td>
                      <td className="td">
                        {entry.status === 'success' ? (
                          <span className="text-down">{entry.outcome ?? 'success'}</span>
                        ) : entry.status === 'skipped' ? (
                          <span className="text-muted">skipped</span>
                        ) : (
                          <span className="text-up">{entry.errorCode ?? 'failed'}</span>
                        )}
                        {entry.errorMessage && (
                          <div className="max-w-[22rem] truncate text-xs text-muted" title={entry.errorMessage}>
                            {entry.errorMessage}
                          </div>
                        )}
                      </td>
                      <td className="td text-right tabular-nums">
                        {entry.price === null ? '—' : formatMoney(entry.price)}
                      </td>
                      <td className="td text-muted">{entry.triggerSource}</td>
                      <td className="td text-muted">{entry.strategy ?? '—'}</td>
                      <td className="td text-right text-muted">{entry.attempts}</td>
                      <td className="td text-right text-muted">{formatDuration(entry.durationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="p-6 text-sm text-muted">No checks recorded for this filter.</p>
          )}
        </section>
      ) : (
        <section className="card overflow-hidden">
          <div className="border-b border-border px-5 py-3 text-xs text-muted">
            Most recent first · level {appLogs.data?.level ?? '—'} · in-memory buffer, resets on restart
          </div>
          {appLogs.loading ? (
            <div className="p-8 text-center">
              <Spinner label="Loading application log" />
            </div>
          ) : appLogs.data && appLogs.data.logs.length > 0 ? (
            <ul className="divide-y divide-border font-mono text-xs">
              {appLogs.data.logs.map((record, index) => {
                const { time, level, msg, ...rest } = record;
                return (
                  <li key={`${time}-${index}`} className="flex flex-wrap gap-x-3 gap-y-1 px-4 py-2">
                    <span className="text-muted">{formatTime(time)}</span>
                    <span className={`w-12 shrink-0 uppercase ${LEVEL_STYLES[level] ?? 'text-ink'}`}>{level}</span>
                    <span className="min-w-0 flex-1 break-words text-ink">{msg}</span>
                    {Object.keys(rest).length > 0 && (
                      <span className="w-full break-all text-muted sm:w-auto">
                        {Object.entries(rest)
                          .filter(([key]) => key !== 'stack')
                          .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
                          .join(' ')}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="p-6 text-sm text-muted">No log records buffered yet.</p>
          )}
        </section>
      )}
    </div>
  );
}

import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PriceChart } from '../components/PriceChart';
import { ChangeBadge, DeltaCell, ProductThumb, Spinner, StatCard, StatusPill } from '../components/indicators';
import { useToast } from '../components/Toaster';
import { usePoll } from '../hooks/usePoll';
import { api } from '../lib/api';
import { errorMessage, formatDateTime, formatDuration, formatMoney, timeAgo } from '../lib/format';
import { HISTORY_RANGES, RANGE_LABELS, type HistoryRange } from '../types';

export function ProductDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const navigate = useNavigate();
  const toast = useToast();

  const [range, setRange] = useState<HistoryRange>('30d');
  const [busy, setBusy] = useState(false);

  const detail = usePoll(useCallback(() => api.getProduct(id), [id]), 15_000, `detail-${id}`);
  const history = usePoll(
    useCallback(() => api.getHistory(id, range), [id, range]),
    30_000,
    `history-${id}-${range}`,
  );
  const logs = usePoll(useCallback(() => api.getProductLogs(id, 25), [id]), 30_000, `logs-${id}`);

  if (Number.isNaN(id) || id <= 0) {
    return <p className="text-sm text-up">Invalid product id.</p>;
  }

  if (detail.loading) {
    return (
      <div className="card p-10 text-center">
        <Spinner label="Loading product" />
      </div>
    );
  }

  if (detail.error || !detail.data) {
    return (
      <div className="space-y-4">
        <div role="alert" className="card border-up/40 bg-up/5 p-4 text-sm text-up">
          {detail.error ?? 'Product not found.'}
        </div>
        <Link to="/" className="btn">
          Back to dashboard
        </Link>
      </div>
    );
  }

  const { product, stats, checking } = detail.data;
  const points = history.data?.points ?? [];
  // Newest first for the table, matching the spec's example ordering.
  const tableRows = [...points].reverse();

  const runCheck = async () => {
    setBusy(true);
    try {
      const result = await api.checkProduct(id);
      if (result.outcome === 'changed' && result.change) {
        toast.success(
          `${result.change.direction === 'down' ? 'Price dropped' : 'Price increased'}\n${result.change.display}`,
        );
      } else if (result.outcome === 'unchanged') {
        toast.info('Price unchanged.');
      } else if (result.outcome === 'skipped') {
        toast.info('A check is already running for this product.');
      } else if (result.outcome === 'failed') {
        toast.error(
          `Check failed: ${result.error?.message ?? 'unknown error'}\nThe last valid price was kept.`,
        );
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      await Promise.all([detail.refresh(), history.refresh(), logs.refresh()]);
    }
  };

  const toggleMonitoring = async () => {
    setBusy(true);
    try {
      await api.setMonitoring(id, !product.monitoringEnabled);
      await detail.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (
      !window.confirm(
        `Stop monitoring "${product.productName}"?\n\nIts price history and notifications will be deleted.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.deleteProduct(id);
      toast.success('Product removed.');
      navigate('/');
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link to="/" className="hover:text-ink">
          Dashboard
        </Link>
        <span className="mx-2" aria-hidden="true">
          /
        </span>
        <span className="text-ink">{product.productName}</span>
      </nav>

      {/* --- overview ---------------------------------------------------- */}
      <section className="card p-5">
        <div className="flex flex-col gap-5 sm:flex-row">
          <ProductThumb product={product} size={112} />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-xl font-semibold leading-snug">{product.productName}</h1>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  <StatusPill product={product} checking={checking} />
                  {product.seller && <span>Sold by {product.seller}</span>}
                  {product.availability && <span>{product.availability}</span>}
                  <a
                    href={product.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-accent hover:underline"
                  >
                    View on Flipkart
                  </a>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-primary" onClick={() => void runCheck()} disabled={busy || checking}>
                  {busy || checking ? 'Checking…' : 'Check now'}
                </button>
                <button type="button" className="btn" onClick={() => void toggleMonitoring()} disabled={busy}>
                  {product.monitoringEnabled ? 'Pause' : 'Resume'}
                </button>
                <button type="button" className="btn btn-danger" onClick={() => void remove()} disabled={busy}>
                  Delete
                </button>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-baseline gap-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted">Current price</div>
                <div className="text-3xl font-semibold tabular-nums">
                  {formatMoney(product.currentPrice, product.currency)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted">Latest change</div>
                <div className="mt-1">
                  <ChangeBadge change={stats.lastPriceChange} />
                </div>
              </div>
              {product.mrp !== null && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted">MRP</div>
                  <div className="mt-1 text-sm text-muted line-through tabular-nums">
                    {formatMoney(product.mrp, product.currency)}
                  </div>
                </div>
              )}
            </div>

            {product.lastStatus === 'failed' && (
              <p role="status" className="mt-4 rounded-lg border border-up/30 bg-up/5 px-3 py-2 text-xs text-up">
                Last check failed ({product.lastErrorCode}). The price shown is the last
                successfully observed value and was not modified.
                {product.lastErrorMessage ? ` Detail: ${product.lastErrorMessage}` : ''}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* --- stats ------------------------------------------------------- */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Previous" value={formatMoney(stats.previousPrice, product.currency)} />
        <StatCard label="Lowest" value={formatMoney(stats.lowestPrice, product.currency)} tone="down" />
        <StatCard label="Highest" value={formatMoney(stats.highestPrice, product.currency)} tone="up" />
        <StatCard label="Average" value={formatMoney(stats.averagePrice, product.currency)} tone="muted" />
        <StatCard label="Price changes" value={stats.totalPriceChanges} />
        <StatCard
          label="Last checked"
          value={timeAgo(stats.lastCheckedAt)}
          hint={stats.lastPriceChangeAt ? `changed ${timeAgo(stats.lastPriceChangeAt)}` : 'no changes yet'}
        />
      </section>

      {/* --- chart ------------------------------------------------------- */}
      <section className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Price movement</h2>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Chart time range">
            {HISTORY_RANGES.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setRange(option)}
                aria-pressed={range === option}
                className={`btn btn-sm ${range === option ? 'btn-primary' : ''}`}
              >
                {RANGE_LABELS[option]}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          {history.loading ? (
            <div className="flex h-72 items-center justify-center">
              <Spinner label="Loading price history" />
            </div>
          ) : (
            <PriceChart points={points} range={range} currency={product.currency} />
          )}
        </div>
      </section>

      {/* --- history table ---------------------------------------------- */}
      <section className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-lg font-semibold">Price history</h2>
          <span className="text-xs text-muted">
            {stats.totalObservations} observation{stats.totalObservations === 1 ? '' : 's'} recorded
          </span>
        </div>

        {tableRows.length === 0 ? (
          <p className="p-6 text-sm text-muted">No observations in this range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] border-collapse">
              <thead className="border-b border-border bg-surfaceAlt/50">
                <tr>
                  <th scope="col" className="th">
                    Date
                  </th>
                  <th scope="col" className="th text-right">
                    Price
                  </th>
                  <th scope="col" className="th">
                    Change
                  </th>
                  <th scope="col" className="th">
                    Availability
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {tableRows.map((point) => (
                  <tr key={`${point.id}-${point.timestamp}`} className="hover:bg-surfaceAlt/40">
                    <td className="td whitespace-nowrap">{formatDateTime(point.timestamp)}</td>
                    <td className="td text-right font-medium tabular-nums">
                      {formatMoney(point.price, point.currency)}
                    </td>
                    <td className="td">
                      {point.isBaseline && point.direction === null ? (
                        <span className="text-xs text-muted">baseline</span>
                      ) : (
                        <DeltaCell
                          signedChange={point.signedChange}
                          absoluteChange={point.absoluteChange}
                          direction={point.direction}
                          percentageChange={point.percentageChange}
                          currency={point.currency}
                        />
                      )}
                    </td>
                    <td className="td text-muted">{point.availability ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* --- check log --------------------------------------------------- */}
      <section className="card overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-lg font-semibold">Recent checks</h2>
          <p className="mt-1 text-xs text-muted">
            Failed checks are recorded here and never overwrite the stored price.
          </p>
        </div>

        {logs.data && logs.data.logs.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[38rem] border-collapse">
              <thead className="border-b border-border bg-surfaceAlt/50">
                <tr>
                  <th scope="col" className="th">
                    When
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
                  <th scope="col" className="th text-right">
                    Took
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {logs.data.logs.map((entry) => (
                  <tr key={entry.id}>
                    <td className="td whitespace-nowrap">{formatDateTime(entry.finishedAt)}</td>
                    <td className="td">
                      {entry.status === 'success' ? (
                        <span className="text-down">{entry.outcome ?? 'success'}</span>
                      ) : entry.status === 'skipped' ? (
                        <span className="text-muted">skipped</span>
                      ) : (
                        <span className="text-up" title={entry.errorMessage ?? ''}>
                          failed · {entry.errorCode}
                        </span>
                      )}
                    </td>
                    <td className="td text-right tabular-nums">
                      {entry.price === null ? '—' : formatMoney(entry.price, product.currency)}
                    </td>
                    <td className="td text-muted">{entry.triggerSource}</td>
                    <td className="td text-right text-muted">{formatDuration(entry.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="p-6 text-sm text-muted">No checks recorded yet.</p>
        )}
      </section>
    </div>
  );
}

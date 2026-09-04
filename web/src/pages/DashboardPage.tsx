import { useCallback, useMemo, useState } from 'react';
import { AddProductForm } from '../components/AddProductForm';
import { ProductTable } from '../components/ProductTable';
import { Spinner, StatCard } from '../components/indicators';
import { useToast } from '../components/Toaster';
import { usePoll } from '../hooks/usePoll';
import { api } from '../lib/api';
import { errorMessage, formatInterval } from '../lib/format';
import type { ProductDto } from '../types';

const SORT_OPTIONS = [
  { value: 'created_desc', label: 'Recently added' },
  { value: 'change_desc', label: 'Recently changed' },
  { value: 'name_asc', label: 'Name (A–Z)' },
  { value: 'price_asc', label: 'Price (low to high)' },
] as const;

const STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'monitoring', label: 'Monitoring' },
  { value: 'paused', label: 'Paused' },
] as const;

export function DashboardPage() {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<string>('created_desc');
  const [status, setStatus] = useState<string>('all');
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const toast = useToast();

  const fetcher = useCallback(
    () => api.listProducts({ search: search.trim(), sort, status }),
    [search, sort, status],
  );

  const { data, error, loading, refreshing, refresh } = usePoll(
    fetcher,
    15_000,
    `${search.trim()}|${sort}|${status}`,
  );

  const settings = usePoll(() => api.getSettings(), 60_000, 'settings');

  const products = data?.products ?? [];
  const overview = data?.overview;
  const checkingIds = useMemo(
    () => new Set(data?.checkingProductIds ?? []),
    [data?.checkingProductIds],
  );

  const withBusy = async (id: number, action: () => Promise<void>) => {
    setBusyIds((current) => new Set(current).add(id));
    try {
      await action();
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const onCheck = (product: ProductDto) =>
    void withBusy(product.id, async () => {
      try {
        const result = await api.checkProduct(product.id);

        if (result.outcome === 'changed' && result.change) {
          toast.success(
            `${result.change.direction === 'down' ? 'Price dropped' : 'Price increased'}\n${product.productName}\n${result.change.display}`,
          );
        } else if (result.outcome === 'unchanged') {
          toast.info(`Price unchanged for ${product.productName}.`);
        } else if (result.outcome === 'baseline') {
          toast.info(`Baseline price recorded for ${product.productName}.`);
        } else if (result.outcome === 'skipped') {
          toast.info('A check for this product is already running.');
        } else if (result.outcome === 'failed') {
          toast.error(
            `Check failed for ${product.productName}: ${result.error?.message ?? result.error?.code ?? 'unknown error'}\nThe last valid price was kept.`,
          );
        }
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        await refresh();
      }
    });

  const onToggleMonitoring = (product: ProductDto) =>
    void withBusy(product.id, async () => {
      try {
        await api.setMonitoring(product.id, !product.monitoringEnabled);
        toast.info(
          product.monitoringEnabled
            ? `Paused monitoring for ${product.productName}.`
            : `Resumed monitoring for ${product.productName}.`,
        );
        await refresh();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    });

  const onDelete = (product: ProductDto) => {
    const confirmed = window.confirm(
      `Stop monitoring "${product.productName}"?\n\nIts price history and notifications will be deleted. This cannot be undone.`,
    );
    if (!confirmed) return;

    void withBusy(product.id, async () => {
      try {
        await api.deleteProduct(product.id);
        toast.success(`Removed ${product.productName}.`);
        await refresh();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    });
  };

  const runAllNow = async () => {
    try {
      const result = await api.runSchedulerNow();
      if (!result.ran) {
        toast.info(result.reason ?? 'The scheduler did not run.');
      } else if (result.tick) {
        const { checked, changed, failed } = result.tick;
        toast.success(
          `Checked ${checked} product${checked === 1 ? '' : 's'} · ${changed} changed · ${failed} failed`,
        );
      }
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const scheduler = settings.data?.scheduler;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="mt-1 text-sm text-muted">
            Every price change is reported. There are no target prices or thresholds to configure.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {refreshing && <Spinner label="Refreshing" />}
          <button type="button" className="btn" onClick={() => void runAllNow()}>
            Check all now
          </button>
        </div>
      </header>

      {overview && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label="Products" value={overview.totalProducts} hint={`${overview.monitoredProducts} monitoring`} />
          <StatCard label="Changes (24h)" value={overview.changesLast24h} tone={overview.changesLast24h > 0 ? 'down' : 'default'} />
          <StatCard label="Unread alerts" value={overview.unreadNotifications} tone={overview.unreadNotifications > 0 ? 'down' : 'muted'} />
          <StatCard
            label="Failed checks (24h)"
            value={overview.failedChecksLast24h}
            tone={overview.failedChecksLast24h > 0 ? 'up' : 'muted'}
            hint={overview.failedChecksLast24h > 0 ? 'prices were retained' : undefined}
          />
          <StatCard
            label="Monitoring"
            value={scheduler?.monitoringEnabled ? 'active' : 'paused'}
            hint={
              scheduler
                ? `every ${formatInterval(scheduler.intervalMinutes)} · ${scheduler.activeChecks} running`
                : undefined
            }
            tone={scheduler?.monitoringEnabled ? 'default' : 'up'}
          />
        </div>
      )}

      {scheduler && !scheduler.monitoringEnabled && (
        <div role="status" className="card border-up/40 bg-up/5 p-4 text-sm text-up">
          Monitoring is disabled globally. Scheduled checks are paused until you re-enable it in
          Settings.
        </div>
      )}

      <AddProductForm onAdded={() => void refresh()} />

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex-1 min-w-[12rem]">
            <label htmlFor="search" className="sr-only">
              Search products
            </label>
            <input
              id="search"
              type="search"
              className="input"
              placeholder="Search by name or URL"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          <label htmlFor="status" className="sr-only">
            Filter by monitoring status
          </label>
          <select
            id="status"
            className="input w-auto"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label htmlFor="sort" className="sr-only">
            Sort products
          </label>
          <select
            id="sort"
            className="input w-auto"
            value={sort}
            onChange={(event) => setSort(event.target.value)}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {loading ? (
          <div className="card p-8 text-center">
            <Spinner label="Loading products" />
          </div>
        ) : error ? (
          <div role="alert" className="card border-up/40 bg-up/5 p-4 text-sm text-up">
            {error}
          </div>
        ) : products.length === 0 ? (
          <div className="card p-10 text-center">
            <p className="text-sm text-muted">
              {search.trim() || status !== 'all'
                ? 'No products match those filters.'
                : 'No products yet. Paste a Flipkart product URL above to start monitoring.'}
            </p>
          </div>
        ) : (
          <ProductTable
            products={products}
            actions={{ onCheck, onToggleMonitoring, onDelete, busyIds, checkingIds }}
          />
        )}
      </section>
    </div>
  );
}

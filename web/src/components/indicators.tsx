import type { CheckStatus, PriceChangeDto, ProductDto } from '../types';
import { formatMoney, formatPercent } from '../lib/format';

/**
 * Shared visual indicators.
 *
 * Colour convention: a price drop is green (good for the shopper), an increase
 * is red. Direction is never conveyed by colour alone - an arrow and a sign are
 * always present so the meaning survives for colour-blind users and in
 * high-contrast modes.
 */

export function ChangeBadge({
  change,
  size = 'md',
}: {
  change: PriceChangeDto | null;
  size?: 'sm' | 'md';
}) {
  if (!change) {
    return <span className="text-sm text-muted">—</span>;
  }

  const dropped = change.direction === 'down';
  const padding = size === 'sm' ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-1 text-sm';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md font-medium ${padding} ${
        dropped ? 'bg-down/10 text-down' : 'bg-up/10 text-up'
      }`}
      title={`${dropped ? 'Dropped' : 'Increased'} by ${formatMoney(change.absoluteChange, change.currency)} (${formatPercent(change.percentageChange)})`}
    >
      <span aria-hidden="true">{dropped ? '↓' : '↑'}</span>
      <span>{formatMoney(change.absoluteChange, change.currency)}</span>
      <span className="opacity-70">({formatPercent(change.percentageChange)})</span>
      <span className="sr-only">{dropped ? 'price decrease' : 'price increase'}</span>
    </span>
  );
}

/** Inline delta used inside the history table. */
export function DeltaCell({
  signedChange,
  absoluteChange,
  direction,
  percentageChange,
  currency,
}: {
  signedChange: number | null;
  absoluteChange: number | null;
  direction: 'up' | 'down' | null;
  percentageChange: number | null;
  currency: string;
}) {
  if (direction === null || absoluteChange === null || signedChange === null) {
    return <span className="text-muted">—</span>;
  }
  const dropped = direction === 'down';
  return (
    <span className={dropped ? 'text-down' : 'text-up'}>
      <span aria-hidden="true">{dropped ? '↓' : '↑'}</span> {formatMoney(absoluteChange, currency)}
      {percentageChange !== null && (
        <span className="ml-1 text-xs opacity-70">({formatPercent(percentageChange)})</span>
      )}
      <span className="sr-only">{dropped ? 'decrease' : 'increase'}</span>
    </span>
  );
}

const STATUS_STYLES: Record<string, string> = {
  monitoring: 'bg-accent/15 text-accent',
  paused: 'bg-surfaceAlt text-muted',
  error: 'bg-up/10 text-up',
  checking: 'bg-down/10 text-down',
};

/**
 * Monitoring status. A failed last check is surfaced here but never implies the
 * stored price changed - the previous valid price is retained.
 */
export function StatusPill({
  product,
  checking = false,
}: {
  product: Pick<ProductDto, 'monitoringEnabled' | 'lastStatus' | 'lastErrorCode' | 'consecutiveFailures'>;
  checking?: boolean;
}) {
  if (checking) {
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${STATUS_STYLES.checking}`}>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />
        Checking
      </span>
    );
  }

  if (!product.monitoringEnabled) {
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${STATUS_STYLES.paused}`}>
        <span aria-hidden="true">⏸</span> Paused
      </span>
    );
  }

  if (product.lastStatus === ('failed' satisfies CheckStatus)) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${STATUS_STYLES.error}`}
        title={`Last check failed (${product.lastErrorCode ?? 'unknown'}). The last valid price is still shown.`}
      >
        <span aria-hidden="true">!</span> Check failed
        {product.consecutiveFailures > 1 && <span className="opacity-70">×{product.consecutiveFailures}</span>}
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${STATUS_STYLES.monitoring}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      Monitoring
    </span>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'up' | 'down' | 'muted';
}) {
  const toneClass =
    tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : tone === 'muted' ? 'text-muted' : 'text-ink';

  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted">
      <span
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-accent"
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

export function ProductThumb({ product, size = 44 }: { product: ProductDto; size?: number }) {
  if (!product.imageUrl) {
    return (
      <div
        className="flex shrink-0 items-center justify-center rounded-lg border border-border bg-surfaceAlt text-xs text-muted"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        ₹
      </div>
    );
  }

  return (
    <img
      src={product.imageUrl}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className="shrink-0 rounded-lg border border-border bg-white object-contain p-1"
      style={{ width: size, height: size }}
      onError={(event) => {
        // Flipkart image URLs expire; hide a broken image rather than showing
        // the browser's placeholder.
        event.currentTarget.style.visibility = 'hidden';
      }}
    />
  );
}

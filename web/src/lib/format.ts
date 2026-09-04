/** Display helpers. Values are already rounded by the backend. */

const inrWhole = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const inrFraction = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(value: number | null | undefined, currency = 'INR'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (currency !== 'INR') {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    }).format(value);
  }
  return Number.isInteger(value) ? inrWhole.format(value) : inrFraction.format(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Number.isInteger(value) ? value : value.toFixed(2)}%`;
}

/** `2 min ago`, `5 hours ago`, `just now`. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'never';

  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 45) return 'just now';
  if (seconds < 90) return '1 min ago';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? 'day' : 'days'} ago`;

  const months = Math.round(days / 30);
  if (months < 12) return `${months} ${months === 1 ? 'month' : 'months'} ago`;

  const years = Math.round(months / 12);
  return `${years} ${years === 1 ? 'year' : 'years'} ago`;
}

/** `30 Aug, 7:30 pm` - matches the history table format in the spec. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-IN', { hour12: false });
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Human-readable label for the interval setting. */
export function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  if (Number.isInteger(hours)) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `${minutes} min`;
}

/** Turns an error-ish value into something safe to show a user. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    // Outside production, `errorHandler` (server/src/api/middleware.ts)
    // attaches the underlying error's own message as `details.message` for
    // an otherwise-generic INTERNAL_ERROR, so a genuine backend bug shows up
    // here as something more actionable than "Request failed with status
    // 500." This is never present in a production deployment - the server
    // only ever generates it when NODE_ENV is not "production" - so no
    // internal detail reaches a real user in that case.
    const details = (err as { details?: unknown }).details;
    if (details && typeof details === 'object' && 'message' in details) {
      const detailMessage = (details as { message?: unknown }).message;
      if (typeof detailMessage === 'string' && detailMessage && detailMessage !== err.message) {
        return `${err.message} (${detailMessage})`;
      }
    }
    return err.message;
  }
  if (typeof err === 'string') return err;
  return 'Something went wrong.';
}

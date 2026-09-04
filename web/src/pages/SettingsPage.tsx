import { useEffect, useState } from 'react';
import { PushNotificationControl } from '../components/PushNotificationControl';
import { Spinner } from '../components/indicators';
import { useToast } from '../components/Toaster';
import { usePoll } from '../hooks/usePoll';
import { api } from '../lib/api';
import { errorMessage, formatDateTime, formatInterval, timeAgo } from '../lib/format';
import type { AppSettings } from '../types';

const INTERVAL_PRESETS = [5, 10, 15, 30, 60, 120, 360, 720, 1440];

export function SettingsPage() {
  const { data, error, loading, refresh } = usePoll(() => api.getSettings(), 30_000, 'settings');
  const [form, setForm] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  // Seed the form once, then let the user own it until they save.
  useEffect(() => {
    if (data?.settings && form === null) setForm(data.settings);
  }, [data?.settings, form]);

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form) return;

    setSaving(true);
    try {
      const result = await api.updateSettings(form);
      setForm(result.settings);
      toast.success('Settings saved. The scheduler picked up the change immediately.');
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    if (data?.settings) setForm(data.settings);
  };

  if (loading || !form) {
    return (
      <div className="card p-8 text-center">
        {error ? <span className="text-sm text-up">{error}</span> : <Spinner label="Loading settings" />}
      </div>
    );
  }

  const scheduler = data?.scheduler;
  const dirty = data ? JSON.stringify(form) !== JSON.stringify(data.settings) : false;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted">
          Operational settings only. There is no target price or discount threshold, because every
          price change is reported.
        </p>
      </header>

      <form onSubmit={save} className="space-y-5">
        {/* --- monitoring ------------------------------------------------ */}
        <section className="card p-5">
          <h2 className="text-lg font-semibold">Monitoring</h2>

          <div className="mt-4 space-y-5">
            <div>
              <label htmlFor="interval" className="label">
                Check interval
              </label>
              <p className="hint">How often each product is re-checked. Default is 15 minutes.</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  id="interval"
                  className="input w-auto"
                  value={INTERVAL_PRESETS.includes(form.monitorIntervalMinutes) ? form.monitorIntervalMinutes : 'custom'}
                  onChange={(event) => {
                    if (event.target.value !== 'custom') {
                      update('monitorIntervalMinutes', Number(event.target.value));
                    }
                  }}
                >
                  {INTERVAL_PRESETS.map((minutes) => (
                    <option key={minutes} value={minutes}>
                      Every {formatInterval(minutes)}
                    </option>
                  ))}
                  <option value="custom">Custom…</option>
                </select>

                <input
                  type="number"
                  min={1}
                  max={1440}
                  className="input w-28"
                  value={form.monitorIntervalMinutes}
                  onChange={(event) =>
                    update('monitorIntervalMinutes', clamp(Number(event.target.value), 1, 1440))
                  }
                  aria-label="Check interval in minutes"
                />
                <span className="text-sm text-muted">minutes</span>
              </div>
            </div>

            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 rounded border-border bg-canvas"
                checked={form.monitoringEnabled}
                onChange={(event) => update('monitoringEnabled', event.target.checked)}
              />
              <span>
                <span className="label">Enable monitoring globally</span>
                <span className="hint block">
                  When off, the background scheduler stops checking every product. Manual checks
                  still work, and individual products can be paused from the dashboard.
                </span>
              </span>
            </label>
          </div>
        </section>

        {/* --- fetching -------------------------------------------------- */}
        <section className="card p-5">
          <h2 className="text-lg font-semibold">Fetching</h2>

          <div className="mt-4 grid gap-5 sm:grid-cols-2">
            <div>
              <label htmlFor="concurrency" className="label">
                Maximum concurrent checks
              </label>
              <p className="hint">How many products may be checked at the same time.</p>
              <input
                id="concurrency"
                type="number"
                min={1}
                max={20}
                className="input mt-2"
                value={form.maxConcurrentChecks}
                onChange={(event) => update('maxConcurrentChecks', clamp(Number(event.target.value), 1, 20))}
              />
            </div>

            <div>
              <label htmlFor="timeout" className="label">
                Request timeout
              </label>
              <p className="hint">Per-attempt limit in milliseconds.</p>
              <input
                id="timeout"
                type="number"
                min={1000}
                max={180000}
                step={1000}
                className="input mt-2"
                value={form.requestTimeoutMs}
                onChange={(event) => update('requestTimeoutMs', clamp(Number(event.target.value), 1000, 180000))}
              />
            </div>

            <div>
              <label htmlFor="retries" className="label">
                Attempts per strategy
              </label>
              <p className="hint">
                Only transient failures (timeout, network, 5xx) consume an attempt.
              </p>
              <input
                id="retries"
                type="number"
                min={1}
                max={10}
                className="input mt-2"
                value={form.fetchMaxRetries}
                onChange={(event) => update('fetchMaxRetries', clamp(Number(event.target.value), 1, 10))}
              />
            </div>

            <div>
              <label htmlFor="retention" className="label">
                Check log retention
              </label>
              <p className="hint">Days of check history kept. Price history is never pruned.</p>
              <input
                id="retention"
                type="number"
                min={1}
                max={365}
                className="input mt-2"
                value={form.checkLogRetentionDays}
                onChange={(event) => update('checkLogRetentionDays', clamp(Number(event.target.value), 1, 365))}
              />
            </div>
          </div>

          {data?.extraction && (
            <p className="mt-4 rounded-lg border border-border bg-canvas px-3 py-2 text-xs text-muted">
              Extraction strategy <span className="text-ink">{data.extraction.strategy}</span> (chain:{' '}
              <span className="text-ink">{data.extraction.fetcher}</span>). The strategy is set with
              the <code>FETCH_STRATEGY</code> environment variable and requires a restart.
            </p>
          )}
        </section>

        {/* --- notifications --------------------------------------------- */}
        <section className="card p-5">
          <h2 className="text-lg font-semibold">Notifications</h2>
          <p className="mt-1 text-sm text-muted">
            A notification is created for every detected price change, in both directions.
          </p>

          <label className="mt-4 flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-border bg-canvas"
              checked={form.notifyInApp}
              onChange={(event) => update('notifyInApp', event.target.checked)}
            />
            <span>
              <span className="label">In-app notifications</span>
              <span className="hint block">Show price changes in the dashboard feed.</span>
            </span>
          </label>

          <p className="mt-4 text-xs text-muted">
            Registered channels: {data?.notifications.registeredChannels.join(', ') || 'none'}.
            Additional providers (email, webhook) can be added server-side by implementing the
            <code className="mx-1">NotificationProvider</code> interface. To receive push
            notifications on this device even while the tab is closed, use the notification
            control below.
          </p>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-primary" disabled={saving || !dirty}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
          <button type="button" className="btn" onClick={reset} disabled={saving || !dirty}>
            Discard changes
          </button>
          {data?.updatedAt && (
            <span className="text-xs text-muted">Last saved {formatDateTime(data.updatedAt)}</span>
          )}
        </div>
      </form>

      <PushNotificationControl />

      {/* --- scheduler status ------------------------------------------- */}
      {scheduler && (
        <section className="card p-5">
          <h2 className="text-lg font-semibold">Price-check status</h2>
          <p className="mt-1 text-sm text-muted">
            Price checks are triggered by an external cron call to{' '}
            <code>POST /api/cron/check-prices</code> (see{' '}
            <code>.github/workflows/check-prices.yml</code>) rather than a timer inside this
            process, so checks continue even if this server restarts between runs.
          </p>

          <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <Field label="Monitoring" value={scheduler.monitoringEnabled ? 'enabled' : 'disabled'} />
            <Field label="Running checks" value={String(scheduler.activeChecks)} />
            <Field label="Sweeps completed" value={String(scheduler.totalTicks)} />
            <Field label="Checks performed" value={String(scheduler.totalChecks)} />
            <Field label="Last sweep" value={scheduler.lastTickFinishedAt ? timeAgo(scheduler.lastTickFinishedAt) : 'never'} />
          </dl>

          {scheduler.lastTick && (
            <p className="mt-4 rounded-lg border border-border bg-canvas px-3 py-2 text-xs text-muted">
              Last sweep checked {scheduler.lastTick.checked} of {scheduler.lastTick.due} due ·{' '}
              {scheduler.lastTick.changed} changed · {scheduler.lastTick.unchanged} unchanged ·{' '}
              {scheduler.lastTick.failed} failed · {scheduler.lastTick.skipped} skipped ·{' '}
              {scheduler.lastTick.notifications} notification
              {scheduler.lastTick.notifications === 1 ? '' : 's'}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

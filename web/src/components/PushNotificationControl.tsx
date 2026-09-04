import { usePushNotifications } from '../hooks/usePushNotifications';

/**
 * "Enable Notifications" control.
 *
 * Web Push notifications (Service Worker + Push API + Notifications API,
 * VAPID-authenticated server-side) are entirely separate from the in-app
 * feed above - they arrive as real browser/OS notifications and, on
 * platforms that support it, even while this tab/browser is closed. See the
 * README for exactly which platforms that applies to.
 *
 * Permission is only ever requested when the button below is clicked - never
 * automatically on page load.
 */
export function PushNotificationControl() {
  const { status, support, busy, error, enable, disable } = usePushNotifications();

  return (
    <section className="card p-5">
      <h2 className="text-lg font-semibold">Push notifications</h2>
      <p className="mt-1 text-sm text-muted">
        Get a browser/OS notification the moment a monitored product's price changes - even when
        this tab is closed, as long as your browser supports Web Push and stays running (see the
        browser compatibility notes in the README).
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {support === 'unsupported' ? (
          <p className="text-sm text-muted">
            This browser does not support Web Push notifications.
          </p>
        ) : status === 'checking' ? (
          <p className="text-sm text-muted">Checking notification status…</p>
        ) : status === 'enabled' ? (
          <>
            <span className="inline-flex items-center gap-1.5 rounded-md bg-down/10 px-2 py-1 text-xs font-medium text-down">
              <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
              Notifications: Enabled
            </span>
            <button type="button" className="btn" onClick={() => void disable()} disabled={busy}>
              {busy ? 'Disabling…' : 'Disable notifications'}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void enable()}
            disabled={busy}
          >
            {busy ? 'Enabling…' : 'Enable Notifications'}
          </button>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-up">{error}</p>}
    </section>
  );
}

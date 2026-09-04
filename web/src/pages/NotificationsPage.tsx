import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Spinner } from '../components/indicators';
import { useToast } from '../components/Toaster';
import { usePoll } from '../hooks/usePoll';
import { api } from '../lib/api';
import { errorMessage, formatDateTime, formatMoney, formatPercent, timeAgo } from '../lib/format';
import type { NotificationDto } from '../types';

/**
 * In-app notification feed.
 *
 * Every entry corresponds to one detected price change. Nothing here is
 * threshold-based: a change of one rupee produces an entry just like a large one.
 */
export function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const toast = useToast();

  const { data, error, loading, refresh } = usePoll(
    useCallback(() => api.listNotifications({ unreadOnly, limit: 100 }), [unreadOnly]),
    15_000,
    `notifications-${unreadOnly}`,
  );

  const notifications = data?.notifications ?? [];

  const markRead = async (notification: NotificationDto) => {
    if (notification.read) return;
    try {
      await api.markNotificationRead(notification.id);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const markAllRead = async () => {
    try {
      const result = await api.markAllNotificationsRead();
      toast.success(`Marked ${result.updated} notification${result.updated === 1 ? '' : 's'} as read.`);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async (notification: NotificationDto) => {
    try {
      await api.deleteNotification(notification.id);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const clearAll = async () => {
    if (!window.confirm('Delete all notifications? Price history is not affected.')) return;
    try {
      const result = await api.clearNotifications();
      toast.success(`Deleted ${result.removed} notification${result.removed === 1 ? '' : 's'}.`);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Notifications</h1>
          <p className="mt-1 text-sm text-muted">
            {data ? `${data.unreadCount} unread of ${data.total}` : 'Loading…'}
            {data?.channels.length ? ` · channels: ${data.channels.join(', ')}` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border bg-canvas"
              checked={unreadOnly}
              onChange={(event) => setUnreadOnly(event.target.checked)}
            />
            Unread only
          </label>
          <button type="button" className="btn" onClick={() => void markAllRead()} disabled={!data?.unreadCount}>
            Mark all read
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void clearAll()} disabled={!data?.total}>
            Clear all
          </button>
        </div>
      </header>

      {loading ? (
        <div className="card p-8 text-center">
          <Spinner label="Loading notifications" />
        </div>
      ) : error ? (
        <div role="alert" className="card border-up/40 bg-up/5 p-4 text-sm text-up">
          {error}
        </div>
      ) : notifications.length === 0 ? (
        <div className="card p-10 text-center text-sm text-muted">
          {unreadOnly ? 'Nothing unread.' : 'No price changes have been detected yet.'}
        </div>
      ) : (
        <ul className="space-y-2">
          {notifications.map((notification) => {
            const dropped = notification.type === 'price_drop';
            const payload = notification.payload;

            return (
              <li
                key={notification.id}
                className={`card p-4 ${notification.read ? 'opacity-70' : 'border-l-2'} ${
                  !notification.read ? (dropped ? 'border-l-down' : 'border-l-up') : ''
                }`}
              >
                <div className="flex flex-wrap items-start gap-3">
                  <span
                    className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base font-semibold ${
                      dropped ? 'bg-down/10 text-down' : 'bg-up/10 text-up'
                    }`}
                    aria-hidden="true"
                  >
                    {dropped ? '↓' : '↑'}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`font-semibold ${dropped ? 'text-down' : 'text-up'}`}>
                        {notification.title}
                      </span>
                      {!notification.read && (
                        <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                          New
                        </span>
                      )}
                      {notification.deliveryStatus === 'failed' && (
                        <span className="text-xs text-up" title={notification.deliveryError ?? ''}>
                          delivery failed
                        </span>
                      )}
                    </div>

                    {payload ? (
                      <>
                        <div className="mt-1 truncate font-medium">
                          {notification.productId ? (
                            <Link to={`/products/${notification.productId}`} className="hover:text-accent">
                              {payload.productName}
                            </Link>
                          ) : (
                            payload.productName
                          )}
                        </div>
                        <div className="mt-1 text-sm tabular-nums">
                          <span className="text-muted">{formatMoney(payload.oldPrice, payload.currency)}</span>
                          <span className="mx-2 text-muted" aria-hidden="true">
                            →
                          </span>
                          <span className="font-semibold">{formatMoney(payload.newPrice, payload.currency)}</span>
                          <span className={`ml-3 ${dropped ? 'text-down' : 'text-up'}`}>
                            <span aria-hidden="true">{dropped ? '↓' : '↑'}</span>{' '}
                            {formatMoney(payload.absoluteChange, payload.currency)} (
                            {formatPercent(payload.percentageChange)})
                          </span>
                        </div>
                      </>
                    ) : (
                      <p className="mt-1 whitespace-pre-line text-sm">{notification.message}</p>
                    )}

                    <div className="mt-2 text-xs text-muted">
                      {formatDateTime(notification.createdAt)} · {timeAgo(notification.createdAt)}
                    </div>
                  </div>

                  <div className="flex shrink-0 gap-1.5">
                    {!notification.read && (
                      <button type="button" className="btn btn-sm" onClick={() => void markRead(notification)}>
                        Mark read
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => void remove(notification)}
                      aria-label={`Delete notification for ${payload?.productName ?? notification.title}`}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

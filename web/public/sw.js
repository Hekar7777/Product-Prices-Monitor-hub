/**
 * Service worker for Web Push notifications.
 *
 * This file is served as a static asset from the site's root (Vite's
 * `public/` directory is copied to the build output unchanged), so it must
 * be registered with `navigator.serviceWorker.register('/sw.js')` - see
 * `web/src/lib/push.ts`.
 *
 * Scope: only push delivery and notification click handling. There is
 * deliberately no caching/offline behaviour here - this app's dashboard
 * always needs a live connection to the API, so an offline-first cache would
 * be misleading rather than helpful.
 */

self.addEventListener('install', () => {
  // Activate immediately rather than waiting for existing tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Fired when a push message arrives - including while every tab for this
 * site is closed, as long as the browser process is running (see the
 * browser-compatibility notes in the README for exactly what "closed" means
 * per platform).
 *
 * The payload is the JSON string built server-side in
 * `server/src/notifications/webPushProvider.ts`:
 *   { title, body, type, data: NotificationPayload }
 */
self.addEventListener('push', (event) => {
  let payload = { title: 'Price update', body: '', type: 'system', data: null };

  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { title: 'Price update', body: event.data.text(), type: 'system', data: null };
    }
  }

  const isDrop = payload.type === 'price_drop';
  const isIncrease = payload.type === 'price_increase';

  const options = {
    body: payload.body,
    icon: '/icon.png',
    badge: '/icon.png',
    tag: payload.data?.productId ? `product-${payload.data.productId}` : undefined,
    // Renotify so a second price change for the same product still alerts
    // the user instead of silently replacing the first notification.
    renotify: true,
    data: payload.data ?? null,
    ...(isDrop || isIncrease
      ? {
          // These fields are informational only in most browsers today, but
          // are harmless to include and let a future UI make use of them.
          dir: 'auto',
        }
      : {}),
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

/**
 * Clicking the notification opens (or focuses) the relevant product page.
 * Falls back to the dashboard root if no product URL is available.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data;
  const targetPath = data?.productId ? `/products/${data.productId}` : '/';

  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

      for (const client of clientsList) {
        const clientUrl = new URL(client.url);
        if (clientUrl.origin === self.location.origin) {
          await client.focus();
          if ('navigate' in client) {
            try {
              await client.navigate(targetPath);
            } catch {
              // Some browsers restrict cross-document navigate() from a SW;
              // focusing the existing tab is still a reasonable fallback.
            }
          }
          return;
        }
      }

      await self.clients.openWindow(targetPath);
    })(),
  );
});

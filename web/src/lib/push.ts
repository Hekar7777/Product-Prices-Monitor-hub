/**
 * Web Push client helpers: Service Worker registration, permission request,
 * subscribe/unsubscribe, and talking to the backend's `/api/push-subscriptions`
 * routes.
 *
 * Nothing here runs automatically on page load - every function is only
 * called from an explicit user action (the "Enable Notifications" button in
 * `usePushNotifications`), per the requirement that permission must never be
 * requested on load.
 */
import { api } from './api';

export type PushSupport = 'supported' | 'unsupported';

/** Whether this browser/context has everything Web Push needs. */
export function getPushSupport(): PushSupport {
  const supported =
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;
  return supported ? 'supported' : 'unsupported';
}

/** Converts the VAPID public key (base64url) to the Uint8Array `subscribe()` needs. */
function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register('/sw.js');
}

/**
 * Requests notification permission, registers the service worker, creates a
 * `PushSubscription`, and stores it on the backend.
 *
 * @throws Error with a user-presentable message at every failure point
 * (permission denied, unsupported browser, backend rejection).
 */
export async function enablePushNotifications(): Promise<void> {
  if (getPushSupport() === 'unsupported') {
    throw new Error('This browser does not support Web Push notifications.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notification permission was denied. Enable notifications for this site in your browser settings to try again.'
        : 'Notification permission was not granted.',
    );
  }

  const registration = await registerServiceWorker();
  await navigator.serviceWorker.ready;

  const { publicKey } = await api.getVapidPublicKey();

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(publicKey),
    }));

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('The browser returned an incomplete push subscription.');
  }

  await api.savePushSubscription({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
}

/** Removes the current subscription both from the browser and the backend. */
export async function disablePushNotifications(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();

  if (subscription) {
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe().catch(() => {
      // Continue even if the browser-side unsubscribe fails - removing the
      // backend record is the part that actually stops delivery attempts.
    });
    await api.deletePushSubscription(endpoint);
  }
}

/**
 * Current subscription state, used to render "Enabled" vs. the button on
 * page load without prompting for permission.
 */
export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  if (getPushSupport() === 'unsupported' || !('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

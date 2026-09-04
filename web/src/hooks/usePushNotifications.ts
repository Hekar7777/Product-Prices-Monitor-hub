import { useCallback, useEffect, useState } from 'react';
import {
  disablePushNotifications,
  enablePushNotifications,
  getCurrentPushSubscription,
  getPushSupport,
  type PushSupport,
} from '../lib/push';

export type PushStatus = 'checking' | 'unsupported' | 'disabled' | 'enabled';

export interface PushNotificationsState {
  status: PushStatus;
  support: PushSupport;
  busy: boolean;
  error: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}

/**
 * Drives the "Enable Notifications" control.
 *
 * Never requests permission on its own - it only inspects the *existing*
 * subscription (if any) on mount, which does not prompt the user. Permission
 * is requested exclusively inside `enable()`, which is only ever called from
 * a button click.
 */
export function usePushNotifications(): PushNotificationsState {
  const support = getPushSupport();
  const [status, setStatus] = useState<PushStatus>(support === 'unsupported' ? 'unsupported' : 'checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (support === 'unsupported') return;

    let mounted = true;
    void getCurrentPushSubscription()
      .then((sub) => {
        if (mounted) setStatus(sub ? 'enabled' : 'disabled');
      })
      .catch(() => {
        if (mounted) setStatus('disabled');
      });

    return () => {
      mounted = false;
    };
  }, [support]);

  const enable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await enablePushNotifications();
      setStatus('enabled');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not enable notifications.');
    } finally {
      setBusy(false);
    }
  }, []);

  const disable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await disablePushNotifications();
      setStatus('disabled');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disable notifications.');
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, support, busy, error, enable, disable };
}

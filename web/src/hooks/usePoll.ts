import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollState<T> {
  data: T | null;
  error: string | null;
  /** True only for the very first load, so refreshes do not flash the UI. */
  loading: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
}

/**
 * Fetches data on mount and then on an interval.
 *
 * Polling keeps the dashboard current, but monitoring itself does not depend on
 * it: the backend scheduler runs regardless of whether this page is open.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  key: string = '',
): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Keep the latest fetcher without making it a dependency of the effect,
  // which would restart polling on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const mounted = useRef(true);
  const inFlight = useRef(false);

  const load = useCallback(async (isInitial: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (!isInitial) setRefreshing(true);

    try {
      const result = await fetcherRef.current();
      if (!mounted.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : 'Request failed.');
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    setLoading(true);
    void load(true);

    const timer = window.setInterval(() => {
      // Skip polling while the tab is hidden; refresh immediately on return.
      if (document.visibilityState === 'visible') void load(false);
    }, intervalMs);

    const onVisible = () => {
      if (document.visibilityState === 'visible') void load(false);
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, key, load]);

  const refresh = useCallback(() => load(false), [load]);

  return { data, error, loading, refreshing, refresh };
}

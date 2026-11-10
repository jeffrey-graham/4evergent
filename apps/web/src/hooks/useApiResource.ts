import { useCallback, useEffect, useRef, useState } from 'react';
import { describeApiError } from '../apiErrors';

export interface UseApiResourceResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Shared hook encapsulating the fetch -> loading -> error -> data state machine.
 *
 * - Ignores stale out-of-order responses via a request-sequence token.
 * - Prevents state updates after component unmount.
 * - Sets `loading = true` on both initial mount/dependency change and `reload()`.
 * - Returns `data: T | null` so callers can distinguish "not loaded" from "loaded empty".
 */
export function useApiResource<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[] = [],
): UseApiResourceResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const execute = useCallback(() => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);

    let promise: Promise<T>;
    try {
      promise = Promise.resolve(fetcherRef.current());
    } catch (err: unknown) {
      if (mountedRef.current && seq === requestSeqRef.current) {
        setError(describeApiError(err, 'Failed to load resource'));
        setLoading(false);
      }
      return;
    }

    promise.then(
      (result) => {
        if (!mountedRef.current || seq !== requestSeqRef.current) return;
        setData(result);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!mountedRef.current || seq !== requestSeqRef.current) return;
        setError(describeApiError(err, 'Failed to load resource'));
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    execute();
    return () => {
      mountedRef.current = false;
      requestSeqRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const reload = useCallback(() => {
    if (!mountedRef.current) return;
    execute();
  }, [execute]);

  return { data, error, loading, reload };
}

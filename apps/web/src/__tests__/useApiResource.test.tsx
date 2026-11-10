import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useApiResource } from '../hooks/useApiResource';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useApiResource', () => {
  it('returns the { data, error, loading, reload } shape and distinguishes null from loaded empty', async () => {
    const deferred = createDeferred<string[]>();
    const fetcher = vi.fn(() => deferred.promise);

    const { result } = renderHook(() => useApiResource(fetcher, []));

    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(typeof result.current.reload).toBe('function');

    await act(async () => {
      deferred.resolve([]);
      await deferred.promise;
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual([]);
  });

  it('ignores stale responses when two fetches resolve out of order', async () => {
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(
      ({ id }) => useApiResource(() => fetcher(), [id]),
      { initialProps: { id: 'req-1' } },
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(true);

    // Trigger second request before first completes
    rerender({ id: 'req-2' });
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Resolve the second request first
    await act(async () => {
      second.resolve('latest-data');
      await second.promise;
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBe('latest-data');
    expect(result.current.error).toBeNull();

    // Now resolve the stale first request out of order
    await act(async () => {
      first.resolve('stale-data');
      await first.promise;
    });

    // State must still reflect the latest request only
    expect(result.current.data).toBe('latest-data');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('does not update state or emit warnings when unmounted mid-flight', async () => {
    const deferred = createDeferred<string>();
    const fetcher = vi.fn(() => deferred.promise);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { result, unmount } = renderHook(() => useApiResource(fetcher, []));
      expect(result.current.loading).toBe(true);

      // Unmount while the request is still in-flight
      unmount();

      await act(async () => {
        deferred.resolve('after-unmount');
        await deferred.promise;
      });

      expect(result.current.data).toBeNull();
      expect(result.current.loading).toBe(true);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('reload() re-invokes the fetcher and sets loading to true during reload', async () => {
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useApiResource(fetcher, []));

    await act(async () => {
      first.resolve('initial-value');
      await first.promise;
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBe('initial-value');

    // Trigger reload
    act(() => {
      result.current.reload();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(true);

    await act(async () => {
      second.resolve('reloaded-value');
      await second.promise;
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.data).toBe('reloaded-value');
    });
  });

  it('captures errors and clears error state on subsequent successful reload()', async () => {
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('Network failure'))
      .mockResolvedValueOnce('recovered');

    const { result } = renderHook(() => useApiResource(fetcher, []));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe('Network failure');
    expect(result.current.data).toBeNull();

    act(() => {
      result.current.reload();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.data).toBe('recovered');
    });
  });
});

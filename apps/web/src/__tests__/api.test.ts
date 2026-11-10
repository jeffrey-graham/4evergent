import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError, isUnauthorizedError, isForbiddenError } from '../api';
import { describeApiError } from '../apiErrors';
import * as auth from '../auth';

// `request()` is not exported from api.ts (only the `api` object and the
// helper error predicates are). We cover it indirectly through `api`, which
// all delegate to `request()`. `globalThis.fetch` is mocked per-test.

function mockFetch(
  status: number,
  body: unknown,
  opts: { jsonOnly?: boolean } = {}
): void {
  const res = {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (opts.jsonOnly === false) {
        throw new Error('not json');
      }
      return body;
    },
  };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(res as unknown as Response);
}

describe('ApiError + predicates', () => {
  it('exposes status and message', () => {
    const err = new ApiError(401, 'unauthorized');
    expect(err.status).toBe(401);
    expect(err.message).toBe('unauthorized');
    expect(err.name).toBe('ApiError');
  });

  it('isUnauthorizedError / isForbiddenError classify by status', () => {
    expect(isUnauthorizedError(new ApiError(401, 'no'))).toBe(true);
    expect(isUnauthorizedError(new ApiError(403, 'no'))).toBe(false);
    expect(isForbiddenError(new ApiError(403, 'no'))).toBe(true);
    expect(isForbiddenError(new ApiError(401, 'no'))).toBe(false);
  });
});

describe('api.request headers (via api.me / api.updateAgentStatus)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset stored token between tests.
    sessionStorage.clear();
  });

  // The request URL is `${API_BASE}${path}`. We assert it indirectly: the
  // fetch spy receives the full URL; we check it ends with the expected path
  // and is prefixed by the dev API base. API_BASE defaults to
  // http://localhost:3000.
  it('builds the URL as `${API_BASE}${path}`', async () => {
    mockFetch(200, { subject: 's1', ownerId: 'o', method: 'email', displayName: 'n', email: null });
    const { api } = await import('../api');
    await api.me();

    const call = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const url = call[0];
    const u = typeof url === 'string' ? url : url.toString();
    expect(u).toBe('http://localhost:3000/auth/me');
  });

  it('sets X-Requested-With: 4evergent on every request', async () => {
    mockFetch(200, {});
    const { api } = await import('../api');
    await api.health();

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [
      RequestInfo,
      RequestInit
    ];
    const headers = new Headers(init.headers);
    expect(headers.get('X-Requested-With')).toBe('4evergent');
  });

  it('sets Content-Type only when a body is present', async () => {
    // With a body (updateAgentStatus sends a PATCH + body)
    mockFetch(200, { id: '1', status: 'ok' });
    const { api } = await import('../api');
    await api.updateAgentStatus('agent-1', 'active');
    let headers = new Headers(
      (vi.mocked(globalThis.fetch).mock.calls[0]![1] as RequestInit).headers
    );
    expect(headers.get('Content-Type')).toBe('application/json');

    // Without a body (health is a plain GET)
    vi.mocked(globalThis.fetch).mockClear();
    mockFetch(200, { status: 'ok', signerAccountId: 'g' });
    await api.health();
    headers = new Headers((vi.mocked(globalThis.fetch).mock.calls[0]![1] as RequestInit).headers);
    expect(headers.has('Content-Type')).toBe(false);
  });

  it('attaches a stored bearer token', async () => {
    sessionStorage.setItem('4evergent.auth.token', 'secret-token-123');
    mockFetch(200, {});
    const { api } = await import('../api');
    await api.health();

    const headers = new Headers(
      (vi.mocked(globalThis.fetch).mock.calls[0]![1] as RequestInit).headers
    );
    expect(headers.get('Authorization')).toBe('Bearer secret-token-123');
  });
});

describe('api.request 401 handling (skipAuthClear)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('clears the stored token and notifies session expiry listeners on a default 401', async () => {
    sessionStorage.setItem('4evergent.auth.token', 'will-be-cleared');
    sessionStorage.setItem('4evergent.auth.subject', 'sub-1');
    mockFetch(401, { error: 'unauthorized' });

    const { api, onSessionExpired } = await import('../api');
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);

    await expect(api.updateAgentStatus('a', 'x')).rejects.toThrow(ApiError);
    expect(sessionStorage.getItem('4evergent.auth.token')).toBeNull();
    expect(sessionStorage.getItem('4evergent.auth.subject')).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('keeps the stored token and does not emit session expiry when skipAuthClear is set (api.me)', async () => {
    sessionStorage.setItem('4evergent.auth.token', 'preserve-me');
    mockFetch(401, { error: 'unauthorized' });

    const { api, onSessionExpired } = await import('../api');
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);

    await expect(api.me()).rejects.toThrow(ApiError);
    expect(sessionStorage.getItem('4evergent.auth.token')).toBe('preserve-me');
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('throws ApiError on non-401 error without clearing credentials or emitting session expiry', async () => {
    sessionStorage.setItem('4evergent.auth.token', 't');
    sessionStorage.setItem('4evergent.auth.subject', 'sub-1');
    mockFetch(500, { error: 'server broken' });

    const { api, onSessionExpired } = await import('../api');
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);

    try {
      await api.health();
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(500);
      expect((e as ApiError).message).toBe('server broken');
      expect(isUnauthorizedError(e)).toBe(false);
    }
    expect(sessionStorage.getItem('4evergent.auth.token')).toBe('t');
    expect(sessionStorage.getItem('4evergent.auth.subject')).toBe('sub-1');
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('api.request swallows non-JSON bodies without throwing', () => {
  it('returns null body for a 204 No Content', async () => {
    const res = {
      status: 204,
      ok: true,
      json: async () => {
        throw new Error('no body');
      },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res as unknown as Response);
    const { api } = await import('../api');
    const r = await api.logout();
    expect(r).toBe(null);
  });
});

// Sanity: auth module is the real one, not accidentally mocked.
describe('auth module exports real functions', () => {
  it('exposes the documented storage helpers', () => {
    expect(typeof auth.getStoredToken).toBe('function');
    expect(typeof auth.storeAuth).toBe('function');
    expect(typeof auth.clearAuth).toBe('function');
    expect(typeof auth.getStoredSubject).toBe('function');
    expect(typeof auth.storeSubject).toBe('function');
    expect(typeof auth.clearStoredSubject).toBe('function');
  });
});

describe('ApiError code', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults code to UNKNOWN', () => {
    expect(new ApiError(500, 'boom').code).toBe('UNKNOWN');
  });

  it('carries code and details from the response body', async () => {
    mockFetch(404, { code: 'AGENT_NOT_FOUND', error: 'Agent not found' });
    const { api } = await import('../api');
    const err = await api.getAgent('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('AGENT_NOT_FOUND');
    expect((err as ApiError).message).toBe('Agent not found');
  });

  it('falls back to UNKNOWN when the server sends no code', async () => {
    mockFetch(500, { error: 'oops' });
    const { api } = await import('../api');
    const err = await api.getAgent('x').catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('UNKNOWN');
  });
});

describe('describeApiError', () => {
  it('maps a known code to a context-appropriate message', () => {
    const msg = describeApiError(new ApiError(404, 'Approval not found', 'APPROVAL_NOT_FOUND'), 'fallback');
    expect(msg).toBe('This approval does not exist.');
  });

  it('uses the server message for unknown codes', () => {
    expect(describeApiError(new ApiError(400, 'bad thing', 'VALIDATION_ERROR'), 'fallback')).toBe('bad thing');
  });
});

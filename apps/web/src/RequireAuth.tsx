import { useState, useEffect, useCallback } from 'react';
import { getStoredToken, clearAuth } from './auth';
import { api, isUnauthorizedError, onSessionExpired } from './api';
import Login from './pages/Login';
import LogoMark from './components/LogoMark';

export const SESSION_EXPIRED_MESSAGE =
  'Your session has expired. Please sign in again to continue.';

/**
 * Validate the current session against the API.
 * Session cookie (HttpOnly) is the primary mechanism — no API key required.
 * A legacy stored bearer token (API-key/CLI flows) still works as fallback.
 */
export async function validateSession(): Promise<boolean> {
  try {
    await api.me();
    return true; // real browser session
  } catch (err) {
    if (isUnauthorizedError(err)) {
      // No/invalid session — try the legacy bearer path if a token exists.
      if (getStoredToken()) {
        try {
          await api.listAgents();
          return true;
        } catch {
          clearAuth();
          return false;
        }
      }
      return false;
    }
    // Network/server error: don't wipe state, but don't claim auth either.
    return false;
  }
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const check = useCallback(() => {
    validateSession().then(setAuthenticated);
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  useEffect(() => {
    return onSessionExpired(() => {
      setSessionExpired(true);
      setAuthenticated(false);
    });
  }, []);

  if (authenticated === null) {
    return (
      <div className="auth-screen">
        <div className="auth-box">
          <LogoMark className="auth-logo" size={32} />
          <h1>4evergent</h1>
          <p className="muted">Verifying session...</p>
        </div>
      </div>
    );
  }

  if (authenticated === false) {
    return (
      <>
        {sessionExpired && (
          <div className="error-banner session-expired-notice" role="alert">
            {SESSION_EXPIRED_MESSAGE}
          </div>
        )}
        <Login
          onSuccess={() => {
            setSessionExpired(false);
            setAuthenticated(true);
          }}
        />
      </>
    );
  }

  return <>{children}</>;
}

export default RequireAuth;

// Empty-string VITE_API_BASE (e.g. left blank in a deployment env panel) must
// fall back to the local dev API — '' would silently make every request a
// same-origin SPA fetch that returns index.html.
const API_BASE = import.meta.env.VITE_API_BASE?.trim() || 'http://localhost:3000';
import { getStoredToken, clearAuth } from './auth';

export class ApiError extends Error {
  status: number;
  /** Machine-readable error code from the API; 'UNKNOWN' when the server sent none. */
  code: string;
  details?: unknown;
  constructor(status: number, message: string, code = 'UNKNOWN', details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Requests carry:
 *  - credentials: include → the HttpOnly session cookie (user login)
 *  - X-Requested-With → CSRF guard for cookie-authenticated state changes
 *  - legacy Bearer token if one is stored (API-key/CLI consumers only;
 *    browser user login never sets it)
 */
async function request<T>(path: string, init?: RequestInit & { skipAuthClear?: boolean }): Promise<T> {
  const { skipAuthClear, ...fetchInit } = init ?? {};
  const headers = new Headers(fetchInit.headers);
  if (!headers.has('Content-Type') && fetchInit.body != null) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('X-Requested-With', '4evergent');
  const token = getStoredToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    keepalive: false,
    ...fetchInit,
    headers,
  });
  const body = res.status !== 204 ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const message = body?.error ?? `API error ${res.status}`;
    const error = new ApiError(res.status, message, body?.code ?? 'UNKNOWN', body?.details);
    // Probes (e.g. /auth/me during session bootstrap) must not wipe a stored
    // legacy bearer token or trigger a mid-session expiry notice — the caller
    // decides how to handle 401.
    if (isUnauthorizedError(error) && !skipAuthClear) {
      clearAuth();
      notifySessionExpired();
    }
    throw error;
  }
  return body as T;
}

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function isForbiddenError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

type SessionExpiryListener = () => void;
const sessionExpiryListeners = new Set<SessionExpiryListener>();

/** Subscribe to mid-session 401 expiry events. Returns an unsubscribe function. */
export function onSessionExpired(listener: SessionExpiryListener): () => void {
  sessionExpiryListeners.add(listener);
  return () => {
    sessionExpiryListeners.delete(listener);
  };
}

/** Notify registered listeners that a session-authenticated request failed with 401. */
export function notifySessionExpired(): void {
  for (const listener of sessionExpiryListeners) {
    listener();
  }
}

import type {
  AgentRecord,
  ActivityRecord,
  ApprovalRecord,
  SubmitPaymentIntent,
  SubmitTrustlineIntent,
  ScheduleRecord,
  ExecutionRecord,
  QueueSummary,
  PolicyRules,
} from './types';

export interface IntentResponse {
  activityId: string;
  agentId: string;
  status: string;
  policyDecision: {
    result: string;
    reason: string;
    rule: string;
    intent: any;
  };
  authorizationStatus: string;
  simulationResult: any;
  txHash: string | null;
  error: string | null;
  approvalId?: string;
}

export const api = {
  health: () => request<{ status: string; signerAccountId: string }>('/health'),

  listAgents: () => request<{ agents: AgentRecord[] }>('/agents'),

  getAgent: (agentId: string) => request<AgentRecord>(`/agents/${encodeURIComponent(agentId)}`),

  agentActivity: (agentId: string, limit = 50, offset = 0) =>
    request<{ agentId: string; activity: ActivityRecord[]; hasMore: boolean }>(
      `/agents/${encodeURIComponent(agentId)}/activity?limit=${limit}&offset=${offset}`
    ),

  activityDetail: (agentId: string, activityId: string) =>
    request<{ activity: ActivityRecord }>(`/agents/${encodeURIComponent(agentId)}/activity/${encodeURIComponent(activityId)}`),

  agentApprovals: (agentId: string, statusFilter?: string) => {
    const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
    return request<{ agentId: string; approvals: ApprovalRecord[] }>(`/agents/${encodeURIComponent(agentId)}/approvals${qs}`);
  },

  updateAgentStatus: (agentId: string, status: string) =>
    request<{ id: string; status: string }>(`/agents/${encodeURIComponent(agentId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  // ===== Policy =====

  getPolicy: (agentId: string) =>
    request<{ agentId: string; policy: PolicyRules; version: number; updatedAt: string | null }>(
      `/agents/${encodeURIComponent(agentId)}/policy`
    ),

  getAgentSpending: (agentId: string) =>
    request<{ agentId: string; spending: Record<string, { used: number; limit: string; remaining: number }> }>(
      `/agents/${encodeURIComponent(agentId)}/spending`
    ),

  updatePolicy: (agentId: string, policy: Partial<PolicyRules>) =>
    request<{ agentId: string; policy: PolicyRules; version: number }>(
      `/agents/${encodeURIComponent(agentId)}/policy`,
      {
        method: 'PUT',
        body: JSON.stringify(policy),
      },
    ),

  listApprovals: (statusFilter?: string, limit = 50, offset = 0) => {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    return request<{ approvals: ApprovalRecord[]; hasMore: boolean; truncated: boolean; total: number }>(`/approvals?${params}`);
  },

  approvalDetail: (approvalId: string) =>
    request<{ approval: ApprovalRecord }>(`/approvals/${encodeURIComponent(approvalId)}`),

  approve: (approvalId: string) =>
    request<{ approvalId: string; activityId: string; status: string; message: string }>(
      `/approvals/${encodeURIComponent(approvalId)}/approve`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  reject: (approvalId: string) =>
    request<{ approvalId: string; activityId: string; status: string; message: string }>(
      `/approvals/${encodeURIComponent(approvalId)}/reject`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  submitPayment: (agentId: string, intent: SubmitPaymentIntent) =>
    request<IntentResponse>(`/agents/${encodeURIComponent(agentId)}/intents`, {
      method: 'POST',
      body: JSON.stringify(intent),
    }),

  submitTrustline: (agentId: string, intent: SubmitTrustlineIntent) =>
    request<IntentResponse>(`/agents/${encodeURIComponent(agentId)}/intents`, {
      method: 'POST',
      body: JSON.stringify({ ...intent, type: 'trustline' }),
    }),

  createAgent: (body: { displayName: string; description?: string; capabilities?: string[]; stellarAddress?: string }) =>
    request<{ agent: AgentRecord }>('/agents', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ===== Executions =====

  listAllExecutions: (limit = 50, offset = 0) =>
    request<{ executions: ExecutionRecord[]; hasMore: boolean }>(
      `/executions?limit=${limit}&offset=${offset}`
    ),

  listActivity: (limit = 50, offset = 0) =>
    request<{ activity: ActivityRecord[]; hasMore: boolean }>(
      `/activity?limit=${limit}&offset=${offset}`
    ),

  listAgentExecutions: (agentId: string, limit = 50, offset = 0) =>
    request<{ agentId: string; executions: ExecutionRecord[]; hasMore: boolean }>(
      `/agents/${encodeURIComponent(agentId)}/executions?limit=${limit}&offset=${offset}`
    ),

  getExecution: (executionId: string) =>
    request<{ execution: ExecutionRecord }>(`/executions/${encodeURIComponent(executionId)}`),

  getQueueStatus: () =>
    request<QueueSummary>('/agent-queue'),

  getOverviewAttention: () =>
    request<{
      pendingApprovals: number;
      failedExecutions: number;
      deadLetterExecutions: number;
      retryingExecutions: number;
      stuckExecutions: number;
    }>('/overview/attention'),

  retryExecution: (executionId: string) =>
    request<{ execution: ExecutionRecord; message: string }>(
      `/executions/${encodeURIComponent(executionId)}/retry`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  cancelExecution: (executionId: string) =>
    request<{ execution: ExecutionRecord; message: string }>(
      `/executions/${encodeURIComponent(executionId)}/cancel`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  // ===== Schedules =====

  listSchedules: (agentId: string, limit = 50, offset = 0) =>
    request<{ agentId: string; schedules: ScheduleRecord[]; hasMore: boolean }>(
      `/agents/${encodeURIComponent(agentId)}/schedules?limit=${limit}&offset=${offset}`
    ),

  getSchedule: (agentId: string, scheduleId: string) =>
    request<{ schedule: ScheduleRecord }>(
      `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`
    ),

  createSchedule: (agentId: string, body: { intent: any; scheduleExpression: string; timezone?: string }) =>
    request<{ schedule: ScheduleRecord }>(`/agents/${encodeURIComponent(agentId)}/schedules`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateSchedule: (agentId: string, scheduleId: string, body: { scheduleExpression?: string }) =>
    request<{ schedule: ScheduleRecord }>(
      `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`,
      { method: 'PATCH', body: JSON.stringify(body) }
    ),

  deleteSchedule: (agentId: string, scheduleId: string) =>
    request<{ deleted: boolean }>(
      `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`,
      { method: 'DELETE' }
    ),

  pauseSchedule: (agentId: string, scheduleId: string) =>
    request<{ schedule: ScheduleRecord }>(
      `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}/pause`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  resumeSchedule: (agentId: string, scheduleId: string) =>
    request<{ schedule: ScheduleRecord }>(
      `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}/resume`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  disableSchedule: (agentId: string, scheduleId: string) =>
    request<{ schedule: ScheduleRecord }>(
      `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}/disable`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  // ===== User authentication (session cookie; no Bearer API key needed) =====

  authConfig: () =>
    request<{ email: boolean; google: boolean; stellar: boolean; registration: boolean }>(
      `/auth/config`
    ),

  me: () =>
    request<{ subject: string; ownerId: string; method: string; displayName: string; email: string | null }>(
      `/auth/me`,
      { skipAuthClear: true }
    ),

  register: (body: { email: string; password: string; displayName?: string }) =>
    request<{ subject: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(body),
      skipAuthClear: true,
    }),

  loginEmail: (body: { email: string; password: string }) =>
    request<{ subject: string }>('/auth/login/email', {
      method: 'POST',
      body: JSON.stringify(body),
      skipAuthClear: true,
    }),

  stellarChallenge: (publicKey: string) =>
    request<{ challengeId: string; message: string; expiresAt: string; network: string }>(
      '/auth/stellar/challenge',
      { method: 'POST', body: JSON.stringify({ publicKey }), skipAuthClear: true }
    ),

  stellarVerify: (body: { publicKey: string; challengeId: string; signature: string }) =>
    request<{ subject: string }>('/auth/stellar/verify', {
      method: 'POST',
      body: JSON.stringify(body),
      skipAuthClear: true,
    }),

  logout: () => request<null>('/auth/logout', { method: 'POST' }),

  /** Full-page navigation target for the Google OAuth start (server-side flow). */
  authStartUrl: () => `${API_BASE}/auth/google/start`,
};

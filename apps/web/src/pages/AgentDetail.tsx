import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { describeApiError } from '../apiErrors';
import type { AgentRecord, ActivityRecord, PolicyRules } from '../types';
import { ScheduleManagement } from './ScheduleManagement';
import { ExecutionList } from './ExecutionList';
import { StatusBadge, Skeleton, EmptyState } from '../components';
import { useApiResource } from '../hooks/useApiResource';

type SpendingData = Record<string, { used: number; limit: string; remaining: number }>;

function SpendingCard({ asset, data }: { asset: string; data: SpendingData[string] }) {
  const limitNum = parseFloat(data.limit) || 0;
  const pct = limitNum > 0 ? Math.min(100, Math.round((data.used / limitNum) * 100)) : 0;
  return (
    <div className="spending-asset">
      <div className="spending-header">
        <span className="spending-asset-name">{asset}</span>
        <span className="spending-values">{data.used} / {data.limit}</span>
      </div>
      <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
      <div className="spending-remaining">Remaining: {data.remaining}</div>
    </div>
  );
}

function StatusControls({
  agentId,
  currentStatus,
  onStatusChange,
}: {
  agentId: string;
  currentStatus: string;
  onStatusChange: (newStatus: string) => void;
}) {
  const [mutating, setMutating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleChange = async (newStatus: string) => {
    if (mutating) return;
    setMutating(newStatus);
    setError(null);
    try {
      const res = await api.updateAgentStatus(agentId, newStatus);
      onStatusChange(res.status);
    } catch (e: any) {
      setError(describeApiError(e, 'Failed to update status'));
    } finally {
      setMutating(null);
    }
  };

  if (currentStatus === 'disabled') {
    return (
      <div className="status-controls">
        <span className="muted">Disabled agents cannot be re-enabled.</span>
        {error && <div className="error" role="alert">{error}</div>}
      </div>
    );
  }

  return (
    <div className="status-controls">
      {currentStatus === 'active' && (
        <>
          <button disabled={mutating !== null} onClick={() => handleChange('paused')}>
            {mutating === 'paused' ? 'Pausing...' : 'Pause'}
          </button>
          <button disabled={mutating !== null} onClick={() => handleChange('disabled')}>
            {mutating === 'disabled' ? 'Disabling...' : 'Disable'}
          </button>
        </>
      )}
      {currentStatus === 'paused' && (
        <>
          <button disabled={mutating !== null} onClick={() => handleChange('active')}>
            {mutating === 'active' ? 'Resuming...' : 'Resume'}
          </button>
          <button disabled={mutating !== null} onClick={() => handleChange('disabled')}>
            {mutating === 'disabled' ? 'Disabling...' : 'Disable'}
          </button>
        </>
      )}
      {error && <div className="error" role="alert">{error}</div>}
    </div>
  );
}

function AgentHeader({
  agent,
  onStatusChange,
}: {
  agent: AgentRecord;
  onStatusChange: (newStatus: string) => void;
}) {
  const statusClass = agent.status === 'active' ? 'badge-ok'
    : agent.status === 'paused' ? 'badge-warn'
    : 'badge-err';
  return (
    <div className="agent-header">
      <div className="agent-header-main">
        <h1>{agent.displayName}</h1>
        <div className="agent-header-meta">
          <span className={`badge ${statusClass}`}>{agent.status}</span>
          <code className="agent-address">{agent.stellarAddress.slice(0, 12)}...</code>
          <span className="muted">ID: {agent.id.slice(0, 8)}</span>
        </div>
      </div>
      <StatusControls agentId={agent.id} currentStatus={agent.status} onStatusChange={onStatusChange} />
    </div>
  );
}

const _DEFAULT_POLICY: PolicyRules = {
  maxTxAmount: { XLM: '100' },
  dailySpendingLimit: { XLM: '500' },
  allowedAssets: ['XLM'],
  allowedDestinations: [],
  allowedContractIds: [],
  txTypeRestrictions: {
    payment: true,
    trustline: true,
    contract_call: false,
    account_settings: false,
  },
  approvalThreshold: '50',
  requireHumanApprovalForAmountAbove: '50',
};

function deepClonePolicy(policy: PolicyRules): PolicyRules {
  return {
    maxTxAmount: { ...policy.maxTxAmount },
    dailySpendingLimit: { ...policy.dailySpendingLimit },
    allowedAssets: [...policy.allowedAssets],
    allowedDestinations: [...policy.allowedDestinations],
    allowedContractIds: [...policy.allowedContractIds],
    txTypeRestrictions: { ...policy.txTypeRestrictions },
    approvalThreshold: policy.approvalThreshold,
    requireHumanApprovalForAmountAbove: policy.requireHumanApprovalForAmountAbove,
  };
}

function PolicySummary({ agentId }: { agentId: string }) {
  const { data: policy, error } = useApiResource(
    async () => {
      const res = await api.getPolicy(agentId);
      return res.policy;
    },
    [agentId],
  );

  if (error) return null;
  if (!policy) return null;

  const limits = Object.entries(policy.maxTxAmount);
  const assets = Object.entries(policy.dailySpendingLimit);

  return (
    <div className="policy-summary">
      <div className="policy-summary-grid">
        {limits.map(([asset, amount]) => (
          <div key={`tx-${asset}`} className="policy-summary-item">
            <span className="policy-summary-label">Max Tx ({asset})</span>
            <span className="policy-summary-value">{amount}</span>
          </div>
        ))}
        <div className="policy-summary-item">
          <span className="policy-summary-label">Approval Threshold</span>
          <span className="policy-summary-value">{policy.approvalThreshold}</span>
        </div>
        {assets.map(([asset, limit]) => (
          <div key={`daily-${asset}`} className="policy-summary-item">
            <span className="policy-summary-label">Daily Limit ({asset})</span>
            <span className="policy-summary-value">{limit}</span>
          </div>
        ))}
        <div className="policy-summary-item">
          <span className="policy-summary-label">Allowed Assets</span>
          <span className="policy-summary-value">{policy.allowedAssets.join(', ')}</span>
        </div>
        <div className="policy-summary-item">
          <span className="policy-summary-label">Destinations</span>
          <span className="policy-summary-value">
            {policy.allowedDestinations.length === 0 ? 'Any' : policy.allowedDestinations.length + ' whitelisted'}
          </span>
        </div>
      </div>
    </div>
  );
}

function PolicySettings({ agentId }: { agentId: string }) {
  const [policy, setPolicy] = useState<PolicyRules | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [form, setForm] = useState<PolicyRules | null>(null);

  const {
    data: loadedPolicy,
    error: loadError,
    loading,
  } = useApiResource(
    () => api.getPolicy(agentId),
    [agentId],
  );

  const [syncedPolicy, setSyncedPolicy] = useState(loadedPolicy);
  if (loadedPolicy && loadedPolicy !== syncedPolicy) {
    setSyncedPolicy(loadedPolicy);
    setPolicy(deepClonePolicy(loadedPolicy.policy));
    setForm(deepClonePolicy(loadedPolicy.policy));
    setVersion(loadedPolicy.version);
    setUpdatedAt(loadedPolicy.updatedAt);
    setSaveError(null);
  }

  const updateForm = (patch: Partial<PolicyRules>) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const updateAmountField = (
    field: 'maxTxAmount' | 'dailySpendingLimit',
    asset: string,
    value: string,
  ) => {
    setForm((prev) => {
      if (!prev) return prev;
      const next = { ...prev[field] };
      if (value.trim() === '') {
        delete next[asset];
      } else {
        next[asset] = value;
      }
      return { ...prev, [field]: next };
    });
  };

  const addListItem = (field: 'allowedAssets' | 'allowedDestinations' | 'allowedContractIds', value: string) => {
    if (!value.trim()) return;
    setForm((prev) => {
      if (!prev) return prev;
      if (prev[field].includes(value.trim())) return prev;
      return { ...prev, [field]: [...prev[field], value.trim()] };
    });
  };

  const removeListItem = (field: 'allowedAssets' | 'allowedDestinations' | 'allowedContractIds', value: string) => {
    setForm((prev) => {
      if (!prev) return prev;
      return { ...prev, [field]: prev[field].filter((v) => v !== value) };
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form || saving) return;
    setSaving(true);
    setSaveError(null);
    setSuccess(null);
    try {
      const res = await api.updatePolicy(agentId, form);
      setPolicy(deepClonePolicy(res.policy));
      setForm(deepClonePolicy(res.policy));
      setVersion(res.version);
      setUpdatedAt(new Date().toISOString());
      setSuccess(`Policy updated (version ${res.version})`);
    } catch (e: any) {
      setSaveError(e.message ?? 'Failed to save policy');
    } finally {
      setSaving(false);
    }
  };

  const error = saveError ?? loadError;

  if (loading) return <Skeleton label="Loading policy..." />;
  if (error && !form) return <div className="error" role="alert">{error}</div>;
  if (!form) return <div className="error" role="alert">Unable to load policy</div>;

  const isDirty =
    policy && JSON.stringify(form) !== JSON.stringify(policy);

  return (
    <form onSubmit={handleSave} className="policy-form">
      {error && <div className="error" role="alert">{error}</div>}
      {success && <div className="success" role="status">{success}</div>}

      <div className="policy-section">
        <h3>Limits</h3>
        <div className="form-grid">
          <label>
            <span>Max Transaction Amount (XLM)</span>
            <input
              id="policy-max-tx-xlm"
              type="number"
              step="0.0000001"
              min="0"
              value={form.maxTxAmount.XLM ?? ''}
              onChange={(e) => updateAmountField('maxTxAmount', 'XLM', e.target.value)}
              placeholder="100"
            />
            <small>Maximum amount allowed for a single intent. Transactions above this are denied.</small>
          </label>
          <label>
            <span>Daily Spending Limit (XLM)</span>
            <input
              id="policy-daily-limit-xlm"
              type="number"
              step="0.0000001"
              min="0"
              value={form.dailySpendingLimit.XLM ?? ''}
              onChange={(e) => updateAmountField('dailySpendingLimit', 'XLM', e.target.value)}
              placeholder="500"
            />
            <small>Aggregate daily spending limit enforced by backend. Once reached, further intents are denied until the next day.</small>
          </label>
          <label>
            <span>Approval Threshold (XLM)</span>
            <input
              id="policy-approval-threshold"
              type="number"
              step="0.0000001"
              min="0"
              value={form.approvalThreshold}
              onChange={(e) => updateForm({ approvalThreshold: e.target.value })}
              placeholder="50"
            />
            <small>Intents above this amount require human approval before execution.</small>
          </label>
          <label>
            <span>Require Human Approval Above (XLM)</span>
            <input
              id="policy-require-human-approval-above"
              type="number"
              step="0.0000001"
              min="0"
              value={form.requireHumanApprovalForAmountAbove}
              onChange={(e) => updateForm({ requireHumanApprovalForAmountAbove: e.target.value })}
              placeholder="50"
            />
            <small>Amount above which human approval is required. Should match approval threshold.</small>
          </label>
        </div>
      </div>

      <div className="policy-section">
        <h3>Allowed Assets</h3>
        <div className="chip-list">
          {form.allowedAssets.map((asset) => (
            <span key={asset} className="chip">
              {asset}
              <button type="button" className="chip-remove" aria-label={`Remove allowed asset ${asset}`} onClick={() => removeListItem('allowedAssets', asset)}>×</button>
            </span>
          ))}
        </div>
        <div className="inline-input">
          <input
            type="text"
            aria-label="Add allowed asset"
            placeholder="Add asset (e.g. USDC)"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addListItem('allowedAssets', (e.target as HTMLInputElement).value);
                (e.target as HTMLInputElement).value = '';
              }
            }}
          />
        </div>
        <small>Assets the agent is allowed to transact with.</small>
      </div>

      <div className="policy-section">
        <h3>Allowed Destinations</h3>
        <div className="chip-list">
          {form.allowedDestinations.length === 0 && <span className="muted">No restrictions (any destination allowed)</span>}
          {form.allowedDestinations.map((dest) => (
            <span key={dest} className="chip">
              {dest}
              <button type="button" className="chip-remove" aria-label={`Remove allowed destination ${dest}`} onClick={() => removeListItem('allowedDestinations', dest)}>×</button>
            </span>
          ))}
        </div>
        <div className="inline-input">
          <input
            type="text"
            aria-label="Add allowed destination"
            placeholder="Add destination (G...)"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addListItem('allowedDestinations', (e.target as HTMLInputElement).value);
                (e.target as HTMLInputElement).value = '';
              }
            }}
          />
        </div>
        <small>Optional whitelist of allowed destination addresses. Empty means any destination is allowed.</small>
      </div>

      <div className="policy-section">
        <h3>Allowed Operations</h3>
        <div className="checkbox-grid">
          <label className="checkbox-label">
            <input
              id="policy-op-payment"
              type="checkbox"
              checked={form.txTypeRestrictions.payment ?? false}
              onChange={(e) => updateForm({ txTypeRestrictions: { ...form.txTypeRestrictions, payment: e.target.checked } })}
            />
            <span>Payment</span>
          </label>
          <label className="checkbox-label">
            <input
              id="policy-op-trustline"
              type="checkbox"
              checked={form.txTypeRestrictions.trustline ?? false}
              onChange={(e) => updateForm({ txTypeRestrictions: { ...form.txTypeRestrictions, trustline: e.target.checked } })}
            />
            <span>Trustline</span>
          </label>
          <label className="checkbox-label">
            <input
              id="policy-op-contract-call"
              type="checkbox"
              checked={form.txTypeRestrictions.contract_call ?? false}
              onChange={(e) => updateForm({ txTypeRestrictions: { ...form.txTypeRestrictions, contract_call: e.target.checked } })}
            />
            <span>Contract Call</span>
          </label>
          <label className="checkbox-label">
            <input
              id="policy-op-account-settings"
              type="checkbox"
              checked={form.txTypeRestrictions.account_settings ?? false}
              onChange={(e) => updateForm({ txTypeRestrictions: { ...form.txTypeRestrictions, account_settings: e.target.checked } })}
            />
            <span>Account Settings</span>
          </label>
        </div>
      </div>

      <div className="policy-meta">
        {version !== null && <span className="muted">Version: {version}</span>}
        {updatedAt && <span className="muted">Last updated: {new Date(updatedAt).toLocaleString()}</span>}
      </div>

      <div className="form-actions">
        <button type="submit" disabled={saving || !isDirty}>
          {saving ? 'Saving...' : 'Save Policy'}
        </button>
        {!isDirty && <span className="muted">No changes</span>}
      </div>
    </form>
  );
}

export default function AgentDetail() {
  const agentId = useParams<{ agentId: string }>().agentId ?? '';
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [statusOverride, setStatusOverride] = useState<AgentRecord['status'] | null>(null);

  const {
    data: spending,
    error: spendingError,
  } = useApiResource(
    async () => {
      const res = await api.getAgentSpending(agentId);
      return res.spending;
    },
    [agentId],
  );

  const {
    data: agentBundle,
    error,
    loading,
    reload,
  } = useApiResource(
    async () => {
      const [a, act] = await Promise.all([
        api.getAgent(agentId),
        api.agentActivity(agentId, 20),
      ]);
      return { agent: a as AgentRecord | null, activity: act.activity as ActivityRecord[] };
    },
    [agentId],
  );

  const [syncedBundle, setSyncedBundle] = useState(agentBundle);
  if (agentBundle && agentBundle !== syncedBundle) {
    setSyncedBundle(agentBundle);
    setStatusOverride(null);
  }

  if (loading) {
    return <Skeleton label="Loading agent..." />;
  }
  if (error) {
    return <EmptyState title="Failed to load agent" message={error} error={true} actionLabel="Retry" onAction={reload} />;
  }

  const baseAgent = agentBundle?.agent ?? null;
  const activity = agentBundle?.activity ?? null;
  const agent = baseAgent
    ? { ...baseAgent, status: statusOverride ?? baseAgent.status }
    : null;

  if (!agent) {
    return (
      <div className="empty-state">
        <h2>Agent not found</h2>
        <p>This agent does not exist or you do not have access.</p>
      </div>
    );
  }

  const handleStatusChange = (newStatus: string) => {
    setStatusOverride(newStatus as AgentRecord['status']);
  };

  return (
    <section>
      <AgentHeader agent={agent} onStatusChange={handleStatusChange} />
      <div className="block">
        <h2>Financial Control</h2>
        {spending === null && spendingError === null ? (
          <Skeleton label="Loading spending..." />
        ) : spendingError ? (
          <div className="error" role="alert">{spendingError}</div>
        ) : spending && Object.keys(spending).length > 0 ? (
          <div className="spending-overview">
            {Object.entries(spending).map(([asset, data]) => (
              <SpendingCard key={asset} asset={asset} data={data} />
            ))}
          </div>
        ) : (
          <div className="empty-state"><p>No daily spending limits configured.</p></div>
        )}
      </div>
      <div className="block">
        <h2>Recent Activity</h2>
        {activity === null ? (
          <Skeleton label="Loading activity..." />
        ) : activity.length === 0 ? (
          <div className="empty-state">
            <p>This agent has no activity yet.</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr><th>ID</th><th>Type</th><th>Amount</th><th>Status</th><th>Time</th></tr>
            </thead>
            <tbody>
              {activity.map((r) => (
                <tr key={r.id}>
                  <td><code>{r.id.slice(0, 8)}</code></td>
                  <td>{r.intent.type}</td>
                  <td>{r.intent.amount || '-'} {r.intent.asset || ''}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td>{new Date(r.createdAt).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="block">
        <h2>Schedules</h2>
        {scheduleError && <div className="error" role="alert">{scheduleError}</div>}
        <ScheduleManagement agentId={agentId} onError={setScheduleError} />
      </div>
      <div className="block">
        <h2>Executions</h2>
        <ExecutionList agentId={agentId} />
      </div>
      <div className="block">
        <h2>Policy</h2>
        <PolicySummary agentId={agentId} />
        <div className="policy-edit-section">
          <PolicySettings agentId={agentId} />
        </div>
      </div>
    </section>
  );
}

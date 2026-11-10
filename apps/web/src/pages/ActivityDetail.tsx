import { Link, useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { describeApiError } from '../apiErrors';
import type { ActivityRecord, ExecutionRecord } from '../types';
import { Skeleton, EmptyState, IntentAmount, DetailCard, Section, StatusBadge, Address } from '../components';
import { useApiResource } from '../hooks/useApiResource';

export default function ActivityDetail() {
  const { agentId, activityId } = useParams<{ agentId: string; activityId: string }>();
  const navigate = useNavigate();

  const { data, error, loading, reload } = useApiResource(
    async () => {
      if (!agentId || !activityId) {
        return { activity: null as ActivityRecord | null, executions: [] as ExecutionRecord[] };
      }
      try {
        const r = await api.activityDetail(agentId, activityId);
        let executions: ExecutionRecord[] = [];
        if (r.activity) {
          try {
            const r2 = await api.listAgentExecutions(agentId);
            executions = r2.executions.filter((e: ExecutionRecord) => e.activityId === activityId);
          } catch {
            // Ignore secondary executions fetch failure
          }
        }
        return { activity: r.activity, executions };
      } catch (e: any) {
        throw new Error(describeApiError(e, 'Failed to load activity'));
      }
    },
    [agentId, activityId],
  );

  if (loading) return <Skeleton label="Loading activity..." />;
  if (error) return <EmptyState title="Failed to load activity" message={error} error={true} actionLabel="Retry" onAction={reload} />;
  const activity = data?.activity ?? null;
  const executions = data?.executions ?? [];
  if (!activity) return (
    <EmptyState title="Activity not found" message="This activity does not exist or you do not have access." />
  );

  const policyDecision = activity.policyDecision;

  return (
    <section>
      <div className="page-header">
        <div>
          <h1>Activity Detail</h1>
          <p className="muted">Agent: {agentId?.slice(0, 8)} · Activity: {activityId?.slice(0, 8)}</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>← Back</button>
      </div>

      <div className="detail-grid">
        <DetailCard title="Activity ID"><code>{activity.id}</code></DetailCard>
        <DetailCard title="Status">
          <StatusBadge status={activity.status} />
        </DetailCard>
        <DetailCard title="Intent Type">{activity.intent.type}</DetailCard>
        <DetailCard title="Amount"><IntentAmount intent={activity.intent} /></DetailCard>
        <DetailCard title="Destination">
          {activity.intent.destination
            ? <Address address={activity.intent.destination} />
            : '-'}
        </DetailCard>
        <DetailCard title="Created">{new Date(activity.createdAt).toLocaleString()}</DetailCard>
        <DetailCard title="Updated">{new Date(activity.updatedAt).toLocaleString()}</DetailCard>
      </div>

      {policyDecision && (
        <Section title="Policy Decision">
          <DetailCard title="Result">
            <span className="muted">{policyDecision.result}</span>
          </DetailCard>
          {policyDecision.reason && (
            <DetailCard title="Reason">{policyDecision.reason}</DetailCard>
          )}
          {policyDecision.rule && (
            <DetailCard title="Rule">{policyDecision.rule}</DetailCard>
          )}
        </Section>
      )}

      {activity.authorizationStatus && (
        <Section title="Authorization">
          <DetailCard title="Status">
            <span className="muted">{activity.authorizationStatus}</span>
          </DetailCard>
        </Section>
      )}

      {activity.simulationResult && (
        <Section title="Simulation">
          <DetailCard title="Success">{activity.simulationResult.success ? 'Yes' : 'No'}</DetailCard>
          {activity.simulationResult.fee && (
            <DetailCard title="Fee">{activity.simulationResult.fee} stroops</DetailCard>
          )}
          {activity.simulationResult.operations && (
            <DetailCard title="Operations">{activity.simulationResult.operations}</DetailCard>
          )}
        </Section>
      )}

      {activity.error && (
        <Section title="Error">
          <DetailCard title="Details">{activity.error}</DetailCard>
        </Section>
      )}

      {activity.txHash && (
        <Section title="Transaction">
          <DetailCard title="Transaction Hash">
            <Address address={activity.txHash} />
          </DetailCard>
        </Section>
      )}

      {executions.length > 0 && (
        <Section title={`Related Executions (${executions.length})`}>
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {executions.map((e) => (
                <tr key={e.id}>
                  <td><code>{e.id.slice(0, 8)}</code></td>
                  <td><StatusBadge status={e.status} /></td>
                  <td className="muted">{new Date(e.createdAt).toLocaleString()}</td>
                  <td>
                    <Link to={`/executions/${e.id}`} className="btn btn-ghost btn-sm">View</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </section>
  );
}

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { ActivityRecord } from '../types';
import { StatusBadge, Skeleton, EmptyState, IntentAmount, PaginationFooter } from '../components';
import { useApiResource } from '../hooks/useApiResource';

const PAGE_SIZE = 50;

export default function Activity() {
  const [extraActivity, setExtraActivity] = useState<ActivityRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const navigate = useNavigate();

  const {
    data: initialPage,
    error: initialError,
    loading,
    reload,
  } = useApiResource(
    () => api.listActivity(PAGE_SIZE, 0),
    [],
  );

  const [syncedPage, setSyncedPage] = useState(initialPage);
  if (initialPage && initialPage !== syncedPage) {
    setSyncedPage(initialPage);
    setExtraActivity([]);
    setHasMore(Boolean(initialPage.hasMore));
    setNextOffset(initialPage.activity.length);
    setLoadMoreError(null);
  }

  const loadMore = () => {
    setLoadingMore(true);
    api.listActivity(PAGE_SIZE, nextOffset)
      .then((r) => {
        setExtraActivity((prev) => prev.concat(r.activity));
        setHasMore(Boolean(r.hasMore));
        setNextOffset((prev) => prev + r.activity.length);
      })
      .catch((e: any) => {
        setLoadMoreError(e.message ?? 'Failed to load activity');
      })
      .finally(() => setLoadingMore(false));
  };

  const retry = () => {
    setLoadMoreError(null);
    reload();
  };

  const error = initialError ?? loadMoreError;
  const activity = initialPage ? [...initialPage.activity, ...extraActivity] : null;

  if (error) return <EmptyState title="Failed to load activity" message={error} error={true} actionLabel="Retry" onAction={retry} />;
  if (loading || activity === null) return <Skeleton label="Loading activity..." />;
  if (activity.length === 0) {
    return (
      <EmptyState
        title="No activity"
        message="Submit an intent to generate activity records."
      />
    );
  }

  return (
    <section>
      <div className="page-header">
        <h1>Activity</h1>
        <p className="muted">Audit trail of all agent operations.</p>
      </div>

      <div className="table-wrapper">
        <table className="table">
          <thead>
            <tr>
              <th>Activity</th>
              <th>Agent</th>
              <th>Intent</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {activity.map((r) => (
              <tr
                key={r.id}
                className="table-row-link"
                onClick={() => navigate(`/agents/${r.agentId}/activity/${r.id}`)}
              >
                <td><code>{r.id.slice(0, 8)}</code></td>
                <td><code>{r.agentId.slice(0, 8)}</code></td>
                <td>{r.intent.type}</td>
                <td><IntentAmount intent={r.intent} /></td>
                <td><StatusBadge status={r.status} /></td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PaginationFooter hasMore={hasMore} loadingMore={loadingMore} onLoadMore={loadMore} itemCount={activity.length} />
    </section>
  );
}

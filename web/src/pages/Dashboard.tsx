import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type MessagingOverview } from '../api/client';
import { Badge, Card, Empty, Stat, fmtDate, statusTone } from '../components/ui';
import { EmergencyControls } from '../components/EmergencyControls';

interface DashboardData {
  messaging: MessagingOverview;
  replyMode: { autoReplyEnabled: boolean; pauseAllOutgoing: boolean; pauseGroupReplies: boolean; pausePrivateReplies: boolean; connectionEnabled: boolean };
  counts: { pendingApprovals: number; messagesToday: number; answersSentToday: number; failedResponses: number; failedQueueJobs: number };
  ai: { spendTodayUsd: number; dailyBudgetUsd: number; spend30dUsd: number; tokens30d: number };
  recentActivity: { id: string; action: string; createdAt: string; administrator: { email: string } | null; resourceType: string | null }[];
}

export function DashboardPage() {
  const { data, error } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardData>('/api/dashboard'), refetchInterval: 15_000 });
  if (error) return <p className="text-sm text-red-600">{String(error)}</p>;
  if (!data) return <p className="text-sm text-slate-500">Loading…</p>;
  const { messaging, replyMode, counts, ai } = data;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <Badge tone={replyMode.autoReplyEnabled ? 'green' : 'amber'}>
          AI Reply Mode: {replyMode.autoReplyEnabled ? 'Automatic replies ON' : 'Admin approval required'}
        </Badge>
        {replyMode.pauseAllOutgoing && <Badge tone="red">All outgoing paused</Badge>}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Link to="/approvals">
          <Stat label="Pending approvals" value={counts.pendingApprovals} tone={counts.pendingApprovals ? 'amber' : undefined} />
        </Link>
        <Stat label="Messages today" value={counts.messagesToday} />
        <Stat label="Answers sent today" value={counts.answersSentToday} />
        <Stat label="Failed responses" value={counts.failedResponses} tone={counts.failedResponses ? 'red' : undefined} />
        <Stat label="AI spend today" value={`$${ai.spendTodayUsd.toFixed(3)}`} />
        <Stat label="AI spend 30d" value={`$${ai.spend30dUsd.toFixed(2)}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Messaging connection" actions={<Link className="text-xs text-brand-700 hover:underline" to="/messaging">Details</Link>}>
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              Adapter: <strong>{messaging.adapter ?? 'none'}</strong>
              <Badge tone={statusTone(messaging.status.state)}>{messaging.status.state}</Badge>
              {messaging.experimental && <Badge tone="amber">experimental</Badge>}
            </div>
            {messaging.lastError && <p className="text-red-600">{messaging.lastError}</p>}
            <p className="text-slate-500">
              Daily AI budget: ${ai.dailyBudgetUsd.toFixed(2)} · Tokens (30d): {ai.tokens30d.toLocaleString()} · Failed queue jobs: {counts.failedQueueJobs}
            </p>
          </div>
        </Card>
        <EmergencyControls />
      </div>

      <Card title="Recent administrator activity">
        {data.recentActivity.length === 0 ? (
          <Empty>No activity yet.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {data.recentActivity.map((a) => (
              <li key={a.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span>
                  <code className="text-xs">{a.action}</code> <span className="text-slate-500">by {a.administrator?.email ?? 'system'}</span>
                </span>
                <span className="text-xs text-slate-400">{fmtDate(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

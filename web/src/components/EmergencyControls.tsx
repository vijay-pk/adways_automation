import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Settings } from '../api/client';
import { canReview, isSuper, useAuth } from '../auth';
import { Badge, Button, Card, ErrorText } from './ui';

type Key = 'pause_all_outgoing' | 'pause_group_replies' | 'pause_private_replies' | 'auto_reply_enabled' | 'messaging_connection_enabled';

const CONTROLS: { key: Key; label: string; stopValue: boolean; stopLabel: string; resumeLabel: string }[] = [
  { key: 'pause_all_outgoing', label: 'All outgoing messages', stopValue: true, stopLabel: 'Pause all', resumeLabel: 'Resume' },
  { key: 'pause_group_replies', label: 'Group replies', stopValue: true, stopLabel: 'Pause groups', resumeLabel: 'Resume' },
  { key: 'pause_private_replies', label: 'Private replies', stopValue: true, stopLabel: 'Pause private', resumeLabel: 'Resume' },
  { key: 'auto_reply_enabled', label: 'Automatic mode', stopValue: false, stopLabel: 'Disable auto', resumeLabel: 'Enable (Reply Settings)' },
  { key: 'messaging_connection_enabled', label: 'Messaging connection', stopValue: false, stopLabel: 'Stop connection', resumeLabel: 'Reconnect' },
];

/** Emergency stops take effect on the backend immediately. Reviewers can stop; only super admins resume. */
export function EmergencyControls() {
  const { admin } = useAuth();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings') });
  const mutate = useMutation({
    mutationFn: (patch: Partial<Settings>) => api.post<Settings>('/api/settings/emergency', patch),
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s);
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      void qc.invalidateQueries({ queryKey: ['messaging'] });
    },
  });
  const s = settings.data;

  return (
    <Card title="Emergency controls">
      <div className="divide-y divide-slate-100">
        {CONTROLS.map((c) => {
          const stopped = s ? s[c.key] === c.stopValue : false;
          const resumeAllowed = c.key !== 'auto_reply_enabled' && isSuper(admin);
          return (
            <div key={c.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="flex items-center gap-2 text-sm">
                {c.label}
                {stopped ? <Badge tone="red">stopped</Badge> : <Badge tone="green">active</Badge>}
              </div>
              {stopped ? (
                <Button variant="secondary" disabled={!resumeAllowed || mutate.isPending} onClick={() => mutate.mutate({ [c.key]: !c.stopValue })}>
                  {c.resumeLabel}
                </Button>
              ) : (
                <Button variant="danger" disabled={!canReview(admin) || mutate.isPending} onClick={() => mutate.mutate({ [c.key]: c.stopValue })}>
                  {c.stopLabel}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      <ErrorText error={mutate.error} />
    </Card>
  );
}

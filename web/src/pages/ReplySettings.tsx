import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Settings } from '../api/client';
import { isSuper, useAuth } from '../auth';
import { Badge, Button, Card, ErrorText, Field, Input, Toggle } from '../components/ui';

type NumKey = {
  [K in keyof Settings]: Settings[K] extends number ? K : never;
}[keyof Settings];

const NUMBERS: { key: NumKey; label: string; hint?: string; step?: number }[] = [
  { key: 'max_response_chars', label: 'Maximum response length (characters)' },
  { key: 'context_window_minutes', label: 'Context time window (minutes)', hint: 'Same-sender messages considered part of one question.' },
  { key: 'context_max_messages', label: 'Maximum context messages' },
  { key: 'followup_window_minutes', label: 'Follow-up window (minutes)', hint: 'How long a previous answer can be referenced by "Why?" etc.' },
  { key: 'debounce_seconds', label: 'Wait for more messages (seconds)', hint: 'Combines consecutive messages into one question.' },
  { key: 'student_per_minute_limit', label: 'Student limit per minute' },
  { key: 'student_daily_limit', label: 'Student limit per day' },
  { key: 'retrieval_top_k', label: 'Transcript passages per answer' },
  { key: 'example_top_k', label: 'Approved examples per answer' },
  { key: 'daily_ai_budget_usd', label: 'Daily AI budget (USD, 0 = unlimited)', step: 0.5 },
  { key: 'message_retention_days', label: 'Message retention (days)', hint: 'Raw messages are purged after this; Approved Answer Memory is kept.' },
];

export function ReplySettingsPage() {
  const { admin } = useAuth();
  const sup = isSuper(admin);
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings') });
  const [draft, setDraft] = useState<Partial<Settings>>({});
  useEffect(() => setDraft({}), [settings.data]);
  const save = useMutation({
    mutationFn: (patch: Partial<Settings>) => api.patch<Settings>('/api/settings', patch),
    onSuccess: (s) => qc.setQueryData(['settings'], s),
  });
  const s = settings.data;
  if (!s) return <p className="text-sm text-slate-500">Loading…</p>;
  const v = { ...s, ...draft };

  return (
    <>
      <h1 className="text-xl font-semibold">Reply Settings</h1>
      {!sup && <p className="text-sm text-slate-500">Read-only: only super admins can change reply settings.</p>}
      <Card title="AI Reply Mode">
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <button
              disabled={!sup}
              onClick={() => save.mutate({ auto_reply_enabled: true })}
              className={`rounded-xl border-2 p-4 text-left ${s.auto_reply_enabled ? 'border-brand-600 bg-brand-50' : 'border-slate-200'}`}
            >
              <div className="font-semibold">Mode A — Automatic replies ON</div>
              <p className="mt-1 text-xs text-slate-600">
                Validated answers with transcript evidence are sent automatically when policies and limits allow. Answers without course evidence are held for review.
              </p>
            </button>
            <button
              disabled={!sup}
              onClick={() => save.mutate({ auto_reply_enabled: false })}
              className={`rounded-xl border-2 p-4 text-left ${!s.auto_reply_enabled ? 'border-brand-600 bg-brand-50' : 'border-slate-200'}`}
            >
              <div className="font-semibold">Mode B — Admin approval required</div>
              <p className="mt-1 text-xs text-slate-600">Drafts are stored and nothing is sent until an authorized administrator approves it.</p>
            </button>
          </div>
          <p className="text-sm">
            Current: {s.auto_reply_enabled ? <Badge tone="green">Automatic replies ON</Badge> : <Badge tone="amber">Approval required</Badge>}
          </p>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Channels & access">
          <div className="space-y-3">
            <Toggle label="Group replies" checked={s.group_replies_enabled} disabled={!sup} onChange={(x) => save.mutate({ group_replies_enabled: x })} />
            <Toggle label="Private replies" checked={s.private_replies_enabled} disabled={!sup} onChange={(x) => save.mutate({ private_replies_enabled: x })} />
            <Toggle
              label="Require active enrollment"
              description="Only students marked ACTIVE in Students & Groups get answers."
              checked={s.require_enrollment}
              disabled={!sup}
              onChange={(x) => save.mutate({ require_enrollment: x })}
            />
            <p className="text-xs text-slate-500">Allowed groups are managed in Students & Groups.</p>
          </div>
        </Card>
        <Card
          title="Limits & context"
          actions={
            <Button disabled={!sup || !Object.keys(draft).length || save.isPending} onClick={() => save.mutate(draft)}>
              Save changes
            </Button>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {NUMBERS.map((n) => (
              <Field key={n.key} label={n.label} hint={n.hint}>
                <Input
                  type="number"
                  step={n.step ?? 1}
                  disabled={!sup}
                  value={v[n.key]}
                  onChange={(e) => setDraft({ ...draft, [n.key]: Number(e.target.value) })}
                />
              </Field>
            ))}
          </div>
        </Card>
      </div>
      <ErrorText error={save.error} />
    </>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Example } from '../api/client';
import { canReview, useAuth } from '../auth';
import { Badge, Button, Card, Empty, ErrorText, Field, Input, Select, Textarea, Toggle, fmtDate } from '../components/ui';

interface Patterns {
  totalExamples: number;
  editedExamples: number;
  editRate: number;
  categories: { category: string; count: number }[];
  frequentlyRemovedTerms: { term: string; count: number }[];
  frequentlyAddedTerms: { term: string; count: number }[];
}

export function ApprovedMemoryPage() {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const params = new URLSearchParams({ take: '50' });
  if (q) params.set('q', q);
  if (filter === 'reusable') params.set('reusable', 'true');
  if (filter === 'private') params.set('reusable', 'false');
  if (filter === 'disabled') params.set('enabled', 'false');
  const list = useQuery({ queryKey: ['memory', q, filter], queryFn: () => api.get<{ items: Example[]; total: number }>(`/api/memory?${params}`) });
  const patterns = useQuery({ queryKey: ['memory-patterns'], queryFn: () => api.get<Patterns>('/api/memory/patterns') });

  return (
    <>
      <h1 className="text-xl font-semibold">Approved Answer Memory</h1>
      <p className="text-sm text-slate-500">
        Administrator-approved answers. Reusable examples are retrieved as style and correction references for similar questions; course facts still come from the transcripts. No model is trained on these.
      </p>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card
          title={`${list.data?.total ?? 0} examples`}
          actions={
            <>
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-40" />
              <Select value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="">All</option>
                <option value="reusable">Reusable</option>
                <option value="private">Private</option>
                <option value="disabled">Disabled</option>
              </Select>
            </>
          }
        >
          {!list.data?.items.length ? (
            <Empty>No approved examples yet. Approve drafts in the Approval Queue to build memory.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {list.data.items.map((e) => (
                <li key={e.id}>
                  <button onClick={() => setSelected(e.id)} className={`w-full rounded-lg px-2 py-2 text-left hover:bg-slate-50 ${selected === e.id ? 'bg-brand-50' : ''}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{e.normalizedQuestion}</span>
                      <span className="flex shrink-0 gap-1">
                        {e.reusable ? <Badge tone="green">reusable</Badge> : <Badge>private</Badge>}
                        {!e.enabled && <Badge tone="red">disabled</Badge>}
                        {e.wasEdited && <Badge tone="blue">corrected</Badge>}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500">
                      {e.topicTags.join(', ') || 'no tags'} · updated {fmtDate(e.updatedAt)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="space-y-4">
          {selected && <ExampleEditor id={selected} onDeleted={() => setSelected(null)} />}
          <Card title="Recurring correction patterns">
            {patterns.data ? (
              <div className="space-y-2 text-sm">
                <p>
                  {patterns.data.editedExamples} of {patterns.data.totalExamples} approvals were edited ({(patterns.data.editRate * 100).toFixed(0)}%).
                </p>
                <div className="flex flex-wrap gap-1">
                  {patterns.data.categories.map((c) => (
                    <Badge key={c.category} tone="blue">{c.category}: {c.count}</Badge>
                  ))}
                </div>
                {patterns.data.frequentlyRemovedTerms.length > 0 && (
                  <p className="text-xs text-slate-600">Often removed: {patterns.data.frequentlyRemovedTerms.map((t) => `${t.term} (${t.count})`).join(', ')}</p>
                )}
                {patterns.data.frequentlyAddedTerms.length > 0 && (
                  <p className="text-xs text-slate-600">Often added: {patterns.data.frequentlyAddedTerms.map((t) => `${t.term} (${t.count})`).join(', ')}</p>
                )}
              </div>
            ) : (
              <Empty>Loading…</Empty>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function ExampleEditor({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const { admin } = useAuth();
  const editable = canReview(admin);
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['memory-item', id],
    queryFn: () => api.get<{ example: Example; influencedJobs: { id: string; normalizedQuestion: string; status: string; createdAt: string }[] }>(`/api/memory/${id}`),
  });
  const [answer, setAnswer] = useState<string | null>(null);
  const [tags, setTags] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (patch: object) => api.patch<Example>(`/api/memory/${id}`, patch),
    onSuccess: () => {
      setAnswer(null);
      setTags(null);
      void qc.invalidateQueries({ queryKey: ['memory'] });
      void qc.invalidateQueries({ queryKey: ['memory-item', id] });
    },
  });
  const del = useMutation({
    mutationFn: () => api.del(`/api/memory/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['memory'] });
      onDeleted();
    },
  });
  if (!data) return null;
  const e = data.example;

  return (
    <Card title="Example">
      <div className="space-y-3 text-sm">
        <div>
          <div className="text-xs font-medium text-slate-500">Original question</div>
          <p className="whitespace-pre-wrap">{e.originalQuestion}</p>
        </div>
        <Field label="Approved answer (final)">
          <Textarea rows={6} disabled={!editable} value={answer ?? e.approvedAnswer} onChange={(ev) => setAnswer(ev.target.value)} />
        </Field>
        {e.originalDraft && e.wasEdited && (
          <details>
            <summary className="cursor-pointer text-xs text-slate-500">Original AI draft (before admin edits)</summary>
            <pre className="mt-1 whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs">{e.originalDraft}</pre>
          </details>
        )}
        <Field label="Topic tags">
          <Input disabled={!editable} value={tags ?? e.topicTags.join(', ')} onChange={(ev) => setTags(ev.target.value)} />
        </Field>
        {editable && (
          <>
            <Toggle label="Reusable for future questions" checked={e.reusable} onChange={(v) => save.mutate({ reusable: v })} />
            <Toggle label="Enabled" checked={e.enabled} onChange={(v) => save.mutate({ enabled: v })} />
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={answer === null && tags === null}
                onClick={() =>
                  save.mutate({
                    ...(answer !== null ? { approvedAnswer: answer } : {}),
                    ...(tags !== null ? { topicTags: tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
                  })
                }
              >
                Save
              </Button>
              <Button variant="danger" onClick={() => confirm('Delete this example permanently?') && del.mutate()}>Delete</Button>
            </div>
          </>
        )}
        <ErrorText error={save.error ?? del.error} />
        <div>
          <div className="text-xs font-medium text-slate-500">Drafts influenced by this example ({data.influencedJobs.length})</div>
          <ul className="mt-1 space-y-1">
            {data.influencedJobs.map((j) => (
              <li key={j.id}>
                <Link className="text-brand-700 hover:underline" to={`/approvals/${j.id}`}>{j.normalizedQuestion ?? j.id}</Link>{' '}
                <span className="text-xs text-slate-500">{j.status}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

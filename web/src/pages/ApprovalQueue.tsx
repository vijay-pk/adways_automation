import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ResponseJob, type ResponseStatus } from '../api/client';
import { canReview, useAuth } from '../auth';
import { Badge, Button, Card, Empty, ErrorText, Field, Input, Select, Textarea, Toggle, fmtDate, statusTone } from '../components/ui';

interface Detail {
  job: ResponseJob & { drafts: { id: string; content: string; reason: string; createdAt: string }[]; usage: { model: string; inputTokens: number; outputTokens: number; estimatedCost: string }[]; example: { id: string; reusable: boolean } | null };
  messages: { id: string; content: string | null; timestamp: string; isMention: boolean }[];
  chunks: { id: string; content: string; timestampStart: string | null; timestampEnd: string | null; transcript: { filename: string; moduleName: string | null; lessonTitle: string | null } }[];
  examples: { id: string; normalizedQuestion: string; approvedAnswer: string; updatedAt: string; wasEdited: boolean }[];
  sender: { displayName: string | null; enrollmentStatus: string } | null;
}

const STATUSES: ResponseStatus[] = ['PENDING_APPROVAL', 'FAILED', 'APPROVED', 'SENDING', 'SENT', 'REJECTED', 'CANCELLED', 'GENERATING'];

export function ApprovalQueuePage() {
  const { id } = useParams();
  const [status, setStatus] = useState<ResponseStatus | ''>('PENDING_APPROVAL');
  const list = useQuery({
    queryKey: ['responses', status],
    queryFn: () => api.get<{ items: ResponseJob[]; total: number }>(`/api/responses?take=50${status ? `&status=${status}` : ''}`),
    refetchInterval: 10_000,
  });

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Approval Queue</h1>
        <Select value={status} onChange={(e) => setStatus(e.target.value as ResponseStatus | '')}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </Select>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card title={`${list.data?.total ?? 0} responses`}>
          {!list.data?.items.length ? (
            <Empty>Nothing here.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {list.data.items.map((j) => (
                <li key={j.id}>
                  <Link to={`/approvals/${j.id}`} className={`block rounded-lg px-2 py-2 hover:bg-slate-50 ${j.id === id ? 'bg-brand-50' : ''}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{j.normalizedQuestion ?? '(generating…)'}</span>
                      <Badge tone={statusTone(j.status)}>{j.status}</Badge>
                    </div>
                    <div className="mt-0.5 flex gap-2 text-xs text-slate-500">
                      <span>{j.conversation.chatType === 'GROUP' ? 'Group' : 'Private'}</span>
                      <span>· {j.senderExternalId}</span>
                      <span>· {fmtDate(j.createdAt)}</span>
                      {j.evidenceSufficient === false && <Badge tone="amber">no course evidence</Badge>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {id ? <ResponseDetail id={id} /> : <Card><Empty>Select a response to review.</Empty></Card>}
      </div>
    </>
  );
}

function ResponseDetail({ id }: { id: string }) {
  const { admin } = useAuth();
  const reviewer = canReview(admin);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, error } = useQuery({ queryKey: ['response', id], queryFn: () => api.get<Detail>(`/api/responses/${id}`), refetchInterval: 8_000 });
  const [answer, setAnswer] = useState('');
  const [reusable, setReusable] = useState(false);
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');
  const [hint, setHint] = useState('');
  useEffect(() => {
    if (data) setAnswer(data.job.draftAnswer ?? '');
  }, [data?.job.draftAnswer]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: object }) => api.post(`/api/responses/${id}/${path}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['responses'] });
      void qc.invalidateQueries({ queryKey: ['response', id] });
      void qc.invalidateQueries({ queryKey: ['pending-count'] });
    },
  });

  if (error) return <ErrorText error={error} />;
  if (!data) return <Card><p className="text-sm text-slate-500">Loading…</p></Card>;
  const { job } = data;
  const pending = job.status === 'PENDING_APPROVAL';
  const edited = answer.trim() !== (job.draftAnswer ?? '').trim();
  const approve = () =>
    act.mutate(
      {
        path: 'approve',
        body: {
          ...(edited ? { editedAnswer: answer } : {}),
          reusable,
          reviewerNotes: notes || undefined,
          topicTags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        },
      },
      { onSuccess: () => navigate('/approvals') },
    );

  return (
    <div className="space-y-4">
      <Card
        title={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(job.status)}>{job.status}</Badge>
            {job.autoApproved && <Badge tone="blue">auto-approved</Badge>}
            {job.intent && <Badge>{job.intent}</Badge>}
            {job.evidenceSufficient ? <Badge tone="green">course evidence</Badge> : <Badge tone="amber">insufficient evidence</Badge>}
            {job.confidence != null && <span className="text-xs text-slate-500">confidence {(job.confidence * 100).toFixed(0)}%</span>}
          </span>
        }
      >
        <div className="space-y-3 text-sm">
          <div>
            <div className="text-xs font-medium text-slate-500">Student</div>
            {data.sender?.displayName ?? job.senderExternalId} · {job.conversation.chatType} · {job.conversation.externalChatId}
          </div>
          <div>
            <div className="text-xs font-medium text-slate-500">Correlated messages (same student, same chat)</div>
            <ul className="mt-1 space-y-1">
              {data.messages.map((m) => (
                <li key={m.id} className="rounded bg-slate-50 px-2 py-1">
                  <span className="text-xs text-slate-400">{new Date(m.timestamp).toLocaleTimeString()} </span>
                  {m.content ?? <em className="text-slate-400">(purged by retention)</em>} {m.isMention && <Badge tone="blue">mention</Badge>}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-xs font-medium text-slate-500">Normalized question</div>
            {job.normalizedQuestion}
          </div>
          {job.lastError && <p className="rounded bg-red-50 p-2 text-red-700">Error: {job.lastError}</p>}
          {job.delivery && (
            <p className="text-xs text-slate-500">
              Delivery: {job.delivery.status} · attempts {job.delivery.attempts} {job.delivery.lastError && `· ${job.delivery.lastError}`}
            </p>
          )}
        </div>
      </Card>

      <Card title={pending ? 'Proposed answer (edit before approving if needed)' : 'Answer'}>
        <div className="space-y-3">
          {pending && reviewer ? (
            <Textarea rows={10} value={answer} onChange={(e) => setAnswer(e.target.value)} />
          ) : (
            <pre className="whitespace-pre-wrap rounded bg-slate-50 p-3 text-sm">{job.approvedAnswer ?? job.draftAnswer}</pre>
          )}
          {job.approvedAnswer && job.draftAnswer && job.approvedAnswer !== job.draftAnswer && (
            <details className="text-sm">
              <summary className="cursor-pointer text-slate-500">Original AI draft</summary>
              <pre className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-3">{job.draftAnswer}</pre>
            </details>
          )}
          {job.sourceRefs?.issues?.length ? <p className="text-xs text-amber-700">Validation: {job.sourceRefs.issues.join('; ')}</p> : null}
          {job.approvedBy && <p className="text-xs text-slate-500">Approved by {job.approvedBy.email} at {fmtDate(job.approvedAt)}</p>}

          {pending && reviewer && (
            <div className="space-y-3 border-t border-slate-100 pt-3">
              <Toggle
                label="Reusable in Approved Answer Memory"
                description="Off = private to this conversation. Reusable examples guide future drafts."
                checked={reusable}
                onChange={setReusable}
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Topic tags (comma separated)">
                  <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="ctr, metrics" />
                </Field>
                <Field label="Reviewer notes">
                  <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
                </Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="success" disabled={act.isPending || !answer.trim()} onClick={approve}>
                  {edited ? 'Edit & approve' : 'Approve & send'}
                </Button>
                <Button variant="danger" disabled={act.isPending} onClick={() => act.mutate({ path: 'reject', body: { notes: notes || undefined } })}>
                  Reject
                </Button>
                <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ path: 'mark-reviewed', body: { notes: notes || undefined } })}>
                  Mark reviewed (don't send)
                </Button>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-48 flex-1">
                  <Field label="Guidance for regeneration (optional)">
                    <Input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="Simpler words, add a numeric example" />
                  </Field>
                </div>
                <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ path: 'regenerate', body: { hint: hint || undefined } })}>
                  Regenerate draft
                </Button>
                <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ path: 'request-evidence', body: { hint: hint || undefined } })}>
                  Request more evidence
                </Button>
              </div>
            </div>
          )}
          {reviewer && job.status === 'FAILED' && (
            <div className="flex gap-2">
              {job.approvedAt ? (
                <Button disabled={act.isPending} onClick={() => act.mutate({ path: 'retry-delivery' })}>Retry delivery</Button>
              ) : (
                <Button disabled={act.isPending} onClick={() => act.mutate({ path: 'regenerate' })}>Retry generation</Button>
              )}
              <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ path: 'mark-reviewed' })}>Close</Button>
            </div>
          )}
          <ErrorText error={act.error} />
        </div>
      </Card>

      <Card title={`Transcript evidence (${data.chunks.length})`}>
        {data.chunks.length === 0 ? (
          <Empty>No transcript passages matched.</Empty>
        ) : (
          <ul className="space-y-2 text-sm">
            {data.chunks.map((c, i) => (
              <li key={c.id} className="rounded border border-slate-100 p-2">
                <div className="mb-1 text-xs font-medium text-slate-500">
                  S{i + 1} · {[c.transcript.moduleName, c.transcript.lessonTitle].filter(Boolean).join(' – ') || c.transcript.filename}
                  {c.timestampStart && ` · ${c.timestampStart}${c.timestampEnd ? `–${c.timestampEnd}` : ''}`}
                </div>
                <p className="line-clamp-4 text-slate-700">{c.content}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Approved examples used (${data.examples.length})`}>
        {data.examples.length === 0 ? (
          <Empty>No approved examples influenced this draft.</Empty>
        ) : (
          <ul className="space-y-2 text-sm">
            {data.examples.map((e) => (
              <li key={e.id} className="rounded border border-slate-100 p-2">
                <div className="text-xs text-slate-500">
                  {e.normalizedQuestion} · approved {fmtDate(e.updatedAt)} {e.wasEdited && <Badge tone="blue">admin-corrected</Badge>}
                </div>
                <p className="mt-1 whitespace-pre-wrap">{e.approvedAnswer}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {data.job.drafts.length > 1 && (
        <Card title="Draft history">
          <ul className="space-y-2 text-sm">
            {data.job.drafts.map((d) => (
              <li key={d.id}>
                <div className="text-xs text-slate-500">{d.reason} · {fmtDate(d.createdAt)}</div>
                <pre className="whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs">{d.content}</pre>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <p className="text-xs text-slate-400">
        AI usage: {data.job.usage.map((u) => `${u.model} ${u.inputTokens}+${u.outputTokens} tok ($${Number(u.estimatedCost).toFixed(4)})`).join(' · ') || '—'}
      </p>
    </div>
  );
}

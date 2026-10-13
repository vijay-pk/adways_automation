import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { isSuper, useAuth } from '../auth';
import { Badge, Button, Card, Empty, ErrorText, Input, Select, fmtDate, statusTone } from '../components/ui';
import { AddTranscript } from './kb/AddTranscript';
import { TranscriptDetail } from './kb/TranscriptDetail';
import { STATUS_LABEL, type KbMeta, type Transcript, type TranscriptStatus } from './kb/types';

interface SearchHit {
  chunkId: string;
  lessonTitle: string | null;
  moduleName: string | null;
  timestampStart: string | null;
  content: string;
  rank: number;
}

export function KnowledgeBasePage() {
  const { admin } = useAuth();
  const sup = isSuper(admin);
  const qc = useQueryClient();
  const [filters, setFilters] = useState({ q: '', module: '', topic: '', status: '', sort: 'createdAt', order: 'desc' });
  const [selected, setSelected] = useState<string | null>(null);
  const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));

  const meta = useQuery({ queryKey: ['kb-meta'], queryFn: () => api.get<KbMeta>('/api/transcripts/meta') });
  const list = useQuery({
    queryKey: ['transcripts', filters],
    queryFn: () => api.get<{ items: Transcript[] }>(`/api/transcripts?${params}`),
    refetchInterval: (q) => (q.state.data?.items.some((t) => t.processingStatus === 'PENDING' || t.processingStatus === 'PROCESSING') ? 3000 : false),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['transcripts'] });
    void qc.invalidateQueries({ queryKey: ['kb-meta'] });
    void qc.invalidateQueries({ queryKey: ['transcript'] });
  };
  const action = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: 'reprocess' | 'delete' }) =>
      kind === 'delete' ? api.del(`/api/transcripts/${id}`) : api.post(`/api/transcripts/${id}/reprocess`),
    onSuccess: (_d, v) => {
      if (v.kind === 'delete' && selected === v.id) setSelected(null);
      refresh();
    },
  });
  const reembed = useMutation({ mutationFn: () => api.post<{ queued: number }>('/api/transcripts/reembed-all'), onSuccess: refresh });
  const m = meta.data;
  const setF = (k: keyof typeof filters) => (e: { target: { value: string } }) => setFilters({ ...filters, [k]: e.target.value });

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Knowledge Base</h1>
        {m && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            {(['COMPLETED', 'PROCESSING', 'PENDING', 'FAILED'] as TranscriptStatus[]).map((s) => (
              <Badge key={s} tone={statusTone(s)}>{STATUS_LABEL[s]}: {m.statusCounts[s] ?? 0}</Badge>
            ))}
            <span>Storage: {m.storage}</span>
            <span>
              Semantic search: {m.embeddings.enabled ? `${m.embeddings.model} (${m.embeddings.vectorBackend})` : 'off — full-text only'}
            </span>
          </div>
        )}
      </div>

      {sup && <AddTranscript meta={m} onAdded={refresh} />}

      <Card
        title={`Classes (${list.data?.items.length ?? 0})`}
        actions={
          sup && m?.embeddings.enabled ? (
            <Button variant="secondary" disabled={reembed.isPending} onClick={() => confirm('Reprocess and re-embed every transcript?') && reembed.mutate()}>
              Re-embed all
            </Button>
          ) : undefined
        }
      >
        <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
          <Input className="lg:col-span-2" placeholder="Search title, topic, description…" value={filters.q} onChange={setF('q')} />
          <Select value={filters.module} onChange={setF('module')}>
            <option value="">All modules</option>
            {m?.modules.map((x) => <option key={x} value={x}>{x}</option>)}
          </Select>
          <Select value={filters.topic} onChange={setF('topic')}>
            <option value="">All topics</option>
            {m?.topics.map((x) => <option key={x} value={x}>{x}</option>)}
          </Select>
          <Select value={filters.status} onChange={setF('status')}>
            <option value="">All statuses</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Select value={`${filters.sort}:${filters.order}`} onChange={(e) => { const [sort, order] = e.target.value.split(':'); setFilters({ ...filters, sort, order }); }}>
            <option value="createdAt:desc">Newest first</option>
            <option value="createdAt:asc">Oldest first</option>
            <option value="title:asc">Title A–Z</option>
            <option value="module:asc">Module</option>
            <option value="status:asc">Status</option>
          </Select>
        </div>

        {!list.data?.items.length ? (
          <Empty>{list.isLoading ? 'Loading…' : 'No transcripts match. Add your first class above.'}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="py-2">Class</th>
                  <th>Module</th>
                  <th>Topic</th>
                  <th>Status</th>
                  <th>Chunks</th>
                  <th>Uploaded</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.items.map((t) => (
                  <tr key={t.id} className={selected === t.id ? 'bg-brand-50' : ''}>
                    <td className="max-w-xs py-2">
                      <button className="text-left font-medium hover:underline" onClick={() => setSelected(t.id)}>{t.lessonTitle}</button>
                      <div className="truncate text-xs text-slate-500">{t.description ?? (t.sourceType === 'paste' ? 'Pasted text' : t.filename)}</div>
                    </td>
                    <td className="text-xs">{t.moduleName ?? '—'}</td>
                    <td className="text-xs">{t.topic ?? '—'}</td>
                    <td>
                      <Badge tone={statusTone(t.processingStatus)}>{STATUS_LABEL[t.processingStatus]}</Badge>
                      {t.processingError && <div className="max-w-xs truncate text-xs text-red-600" title={t.processingError}>{t.processingError}</div>}
                    </td>
                    <td className="text-xs">{t.chunkCount}{m?.embeddings.enabled && ` (${t.embeddedChunkCount} emb.)`}</td>
                    <td className="whitespace-nowrap text-xs text-slate-500">{fmtDate(t.createdAt)}</td>
                    <td className="space-x-1 whitespace-nowrap text-right">
                      <Button variant="ghost" onClick={() => setSelected(t.id)}>{sup ? 'View / edit' : 'View'}</Button>
                      {sup && (
                        <>
                          <Button variant="ghost" disabled={t.processingStatus === 'PROCESSING'} onClick={() => action.mutate({ id: t.id, kind: 'reprocess' })}>Reprocess</Button>
                          <Button variant="ghost" className="text-red-600" onClick={() => confirm(`Delete "${t.lessonTitle}"? It will no longer be used in answers.`) && action.mutate({ id: t.id, kind: 'delete' })}>
                            Delete
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ErrorText error={action.error ?? reembed.error} />
      </Card>

      {selected && <TranscriptDetail id={selected} meta={m} onChanged={refresh} onClose={() => setSelected(null)} />}
      <SearchCard />
    </>
  );
}

/** Lets admins check what the tutor would retrieve for a question. */
function SearchCard() {
  const [q, setQ] = useState('');
  const search = useMutation({ mutationFn: (query: string) => api.get<{ results: SearchHit[] }>(`/api/transcripts/search?q=${encodeURIComponent(query)}`) });
  return (
    <Card title="Test retrieval">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim()) search.mutate(q); }}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask like a student, e.g. how do I calculate ROAS?" />
        <Button type="submit">Search</Button>
      </form>
      {search.data && (
        <ul className="mt-3 space-y-2 text-sm">
          {search.data.results.length === 0 && <Empty>No matching passages — the tutor would say the course material does not cover this.</Empty>}
          {search.data.results.map((h) => (
            <li key={h.chunkId} className="rounded border border-slate-100 p-2">
              <div className="text-xs text-slate-500">
                {[h.moduleName, h.lessonTitle].filter(Boolean).join(' – ')} {h.timestampStart && `· ${h.timestampStart}`} · score {h.rank.toFixed(4)}
              </div>
              <p className="line-clamp-3">{h.content}</p>
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={search.error} />
    </Card>
  );
}

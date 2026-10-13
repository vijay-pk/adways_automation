import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { canReview, isSuper, useAuth } from '../../auth';
import { Badge, Button, Card, ErrorText, Field, Input, fmtDate, statusTone } from '../../components/ui';
import { STATUS_LABEL, fmtSize, type Chunk, type KbMeta, type Transcript } from './types';

/** Preview of extracted text and chunks, metadata editing and file replacement. */
export function TranscriptDetail({ id, meta, onChanged, onClose }: { id: string; meta?: KbMeta; onChanged: () => void; onClose: () => void }) {
  const { admin } = useAuth();
  const sup = isSuper(admin);
  const detail = useQuery({
    queryKey: ['transcript', id],
    queryFn: () => api.get<{ transcript: Transcript; chunks: Chunk[] }>(`/api/transcripts/${id}`),
    refetchInterval: (q) => (['PENDING', 'PROCESSING'].includes(q.state.data?.transcript.processingStatus ?? '') ? 3000 : false),
  });
  const t = detail.data?.transcript;
  const [form, setForm] = useState({ title: '', moduleName: '', topic: '', description: '' });
  const [view, setView] = useState<'text' | 'chunks'>('text');
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (t) setForm({ title: t.lessonTitle ?? '', moduleName: t.moduleName ?? '', topic: t.topic ?? '', description: t.description ?? '' });
  }, [t?.id, t?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({ mutationFn: () => api.patch(`/api/transcripts/${id}`, form), onSuccess: onChanged });
  const replace = useMutation({
    mutationFn: async () => {
      const f = fileRef.current?.files?.[0];
      if (!f) throw new Error('Choose a replacement file');
      if (meta && f.size > meta.maxUploadMb * 1024 * 1024) throw new Error(`File is larger than ${meta.maxUploadMb} MB`);
      const fd = new FormData();
      fd.append('file', f);
      return api.upload(`/api/transcripts/${id}/replace`, fd);
    },
    onSuccess: () => {
      if (fileRef.current) fileRef.current.value = '';
      onChanged();
      void detail.refetch();
    },
  });

  if (!t) return <Card><p className="text-sm text-slate-500">Loading…</p></Card>;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <Card
      title={<span className="flex items-center gap-2">{t.lessonTitle} <Badge tone={statusTone(t.processingStatus)}>{STATUS_LABEL[t.processingStatus]}</Badge></span>}
      actions={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      <div className="space-y-4 text-sm">
        <p className="text-xs text-slate-500">
          {t.sourceType === 'paste' ? 'Pasted text' : t.filename} · {fmtSize(t.sizeBytes)} · stored in {t.storageProvider} · added {fmtDate(t.createdAt)}
          {t.processedAt && ` · processed ${fmtDate(t.processedAt)}`} · {t.chunkCount} chunks ({t.embeddedChunkCount} with embeddings)
        </p>
        {t.processingError && <p className="rounded bg-red-50 p-2 text-red-700">{t.processingError}</p>}

        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Class title"><Input value={form.title} onChange={set('title')} disabled={!sup} /></Field>
          <Field label="Course module"><Input list="kb-modules" value={form.moduleName} onChange={set('moduleName')} disabled={!sup} /></Field>
          <Field label="Topic"><Input list="kb-topics" value={form.topic} onChange={set('topic')} disabled={!sup} /></Field>
          <Field label="Description"><Input value={form.description} onChange={set('description')} disabled={!sup} /></Field>
        </div>
        {sup && (
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={save.isPending} onClick={() => save.mutate()}>Save details</Button>
            <span className="mx-2 h-5 w-px bg-slate-200" />
            <input ref={fileRef} type="file" accept=".txt,.pdf,.docx,.srt,.vtt,.md,.markdown" className="text-xs" />
            <Button variant="secondary" disabled={replace.isPending} onClick={() => confirm('Replace the file? The old content is removed from answers immediately.') && replace.mutate()}>
              Replace file
            </Button>
          </div>
        )}
        {canReview(admin) && (
          <a className="inline-block text-xs text-brand-700 hover:underline" href={`/api/transcripts/${id}/original`}>Download original</a>
        )}
        <ErrorText error={save.error ?? replace.error} />

        <div>
          <div className="mb-2 flex gap-2">
            <Button variant={view === 'text' ? 'primary' : 'secondary'} onClick={() => setView('text')}>Extracted text</Button>
            <Button variant={view === 'chunks' ? 'primary' : 'secondary'} onClick={() => setView('chunks')}>Chunks ({detail.data?.chunks.length ?? 0})</Button>
          </div>
          {view === 'text' ? (
            <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs leading-relaxed">
              {t.extractedText ?? (t.processingStatus === 'COMPLETED' ? '' : 'Text will appear here once processing completes.')}
            </pre>
          ) : (
            <ul className="max-h-[32rem] space-y-2 overflow-auto">
              {detail.data?.chunks.map((c) => (
                <li key={c.id} className="rounded border border-slate-100 p-2">
                  <div className="text-xs text-slate-500">
                    #{c.chunkIndex} · ~{c.tokenEstimate} tokens {c.timestampStart && `· ${c.timestampStart}–${c.timestampEnd ?? ''}`} {c.embeddingModel ? <Badge tone="green">embedded</Badge> : <Badge>text only</Badge>}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-xs">{c.content}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

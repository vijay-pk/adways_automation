import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Badge, Button, Card, ErrorText, Field, Input, Textarea } from '../../components/ui';
import type { KbMeta } from './types';

interface UploadResult {
  filename: string;
  ok: boolean;
  status?: string;
  error?: string;
}

/** Upload files or paste a transcript. Processing continues in the background. */
export function AddTranscript({ meta, onAdded }: { meta?: KbMeta; onAdded: () => void }) {
  const [mode, setMode] = useState<'upload' | 'paste'>('upload');
  const [form, setForm] = useState({ title: '', moduleName: '', topic: '', description: '' });
  const [text, setText] = useState('');
  const [fileCount, setFileCount] = useState(0);
  const [results, setResults] = useState<UploadResult[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = useMutation({
    mutationFn: async (): Promise<UploadResult[]> => {
      const fields = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim()));
      if (mode === 'paste') {
        if (!form.title.trim()) throw new Error('Class title is required');
        if (!text.trim()) throw new Error('Paste the transcript text');
        await api.post('/api/transcripts/text', { ...fields, text });
        return [{ filename: form.title, ok: true, status: 'PENDING' }];
      }
      const files = fileRef.current?.files;
      if (!files?.length) throw new Error('Choose at least one file');
      const oversized = Array.from(files).find((f) => meta && f.size > meta.maxUploadMb * 1024 * 1024);
      if (oversized) throw new Error(`${oversized.name} is larger than ${meta?.maxUploadMb} MB`);
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append('files', f);
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      return (await api.upload<{ results: UploadResult[] }>('/api/transcripts', fd)).results;
    },
    onSuccess: (r) => {
      setResults(r);
      if (r.some((x) => x.ok)) {
        setForm({ title: '', moduleName: form.moduleName, topic: '', description: '' });
        setText('');
        if (fileRef.current) fileRef.current.value = '';
        setFileCount(0);
      }
      onAdded();
    },
  });

  return (
    <Card
      title="Add a class transcript"
      actions={
        <div className="flex rounded-lg border border-slate-300 p-0.5 text-sm">
          {(['upload', 'paste'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`rounded-md px-3 py-1 ${mode === m ? 'bg-brand-600 text-white' : 'text-slate-600'}`}>
              {m === 'upload' ? 'Upload file' : 'Paste text'}
            </button>
          ))}
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label={mode === 'paste' ? 'Class title *' : 'Class title'} hint={mode === 'upload' ? 'Single file only; defaults to the file name' : undefined}>
            <Input value={form.title} onChange={set('title')} placeholder="Class 5: Conversion tracking" disabled={mode === 'upload' && fileCount > 1} />
          </Field>
          <Field label="Course module">
            <Input list="kb-modules" value={form.moduleName} onChange={set('moduleName')} placeholder="Module 2" />
            <datalist id="kb-modules">{meta?.modules.map((m) => <option key={m} value={m} />)}</datalist>
          </Field>
          <Field label="Topic">
            <Input list="kb-topics" value={form.topic} onChange={set('topic')} placeholder="Tracking & attribution" />
            <datalist id="kb-topics">{meta?.topics.map((t) => <option key={t} value={t} />)}</datalist>
          </Field>
        </div>
        <Field label="Description (optional)">
          <Input value={form.description} onChange={set('description')} placeholder="What this class covers" />
        </Field>
        {mode === 'upload' ? (
          <Field label="Files" hint={`TXT, PDF or DOCX (also SRT, VTT, Markdown) · up to ${meta?.maxUploadMb ?? '…'} MB each · up to 20 files at once`}>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".txt,.pdf,.docx,.srt,.vtt,.md,.markdown"
              className="block text-sm"
              onChange={(e) => setFileCount(e.target.files?.length ?? 0)}
            />
          </Field>
        ) : (
          <Field label="Transcript text" hint={`${text.length.toLocaleString()} characters`}>
            <Textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the full class transcript here. Timestamps like [00:12:30] are kept." />
          </Field>
        )}
        <div className="flex items-center gap-3">
          <Button disabled={submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? 'Uploading…' : mode === 'upload' ? 'Upload & process' : 'Save & process'}
          </Button>
          <span className="text-xs text-slate-500">Processing runs in the background; you can keep working.</span>
        </div>
        <ErrorText error={submit.error} />
        {results.length > 0 && (
          <ul className="space-y-1 text-sm">
            {results.map((r, i) => (
              <li key={i}>
                {r.ok ? <Badge tone="amber">queued</Badge> : <Badge tone="red">rejected</Badge>} {r.filename}
                {r.error && <span className="text-red-600"> — {r.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

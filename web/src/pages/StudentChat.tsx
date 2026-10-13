import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, ErrorText, Field, Input, Textarea } from '../components/ui';

interface ChatMessage {
  id: string;
  from: 'student' | 'tutor';
  text: string;
  at: string;
}

async function call<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'tutor-web' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status });
  return data as T;
}

/** Website chat fallback for enrolled students. */
export function StudentChatPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = async () => {
    try {
      const r = await call<{ messages: ChatMessage[]; pending: boolean }>('GET', '/api/chat/messages');
      setMessages(r.messages);
      setPending(r.pending);
      setAuthed(true);
    } catch (err) {
      if ((err as { status?: number }).status === 401) setAuthed(false);
      else setError(err);
    }
  };

  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (!authed) return;
    const t = setInterval(() => void load(), pending ? 4000 : 15000);
    return () => clearInterval(t);
  }, [authed, pending]);

  if (authed === null) return <div className="p-8 text-sm text-slate-500">Loading…</div>;
  if (!authed) return <ChatLogin onDone={load} />;
  return <ChatWindow messages={messages} pending={pending} error={error} onSent={load} onLogout={async () => { await call('POST', '/api/chat/logout', {}); setAuthed(false); }} />;
}

function ChatLogin({ onDone }: { onDone: () => Promise<void> }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await call('POST', '/api/chat/login', { phone, code });
      await onDone();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Course Tutor</h1>
        <p className="text-xs text-slate-500">Sign in with your registered phone number and the access code from your course team.</p>
        <Field label="Phone number"><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91…" required /></Field>
        <Field label="Access code"><Input value={code} onChange={(e) => setCode(e.target.value)} required /></Field>
        <ErrorText error={error} />
        <Button type="submit" className="w-full">Sign in</Button>
        <p className="text-[11px] leading-snug text-slate-400">
          Privacy: your questions are stored to answer them and may be reviewed by course staff. Messages are deleted after the course retention period. Do not share personal or payment information.
        </p>
      </form>
    </div>
  );
}

function ChatWindow({ messages, pending, error, onSent, onLogout }: { messages: ChatMessage[]; pending: boolean; error: unknown; onSent: () => Promise<void>; onLogout: () => void }) {
  const [text, setText] = useState('');
  const [sendError, setSendError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages.length]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSendError(null);
    setNotice(null);
    try {
      const r = await call<{ outcome: string }>('POST', '/api/chat/messages', { text });
      setText('');
      if (r.outcome === 'rate_limited') setNotice('You have reached the question limit for now. Please try again later.');
      else if (r.outcome === 'replies_disabled') setNotice('The tutor is not answering right now.');
      await onSent();
    } catch (err) {
      setSendError(err);
    }
  };

  return (
    <div className="mx-auto flex h-screen max-w-2xl flex-col p-4">
      <header className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Course Tutor</h1>
        <button onClick={onLogout} className="text-xs text-slate-500 hover:underline">Sign out</button>
      </header>
      <div className="flex-1 space-y-2 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4">
        {messages.length === 0 && <p className="text-center text-sm text-slate-400">Ask anything about the course.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.from === 'student' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${m.from === 'student' ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-800'}`}>{m.text}</div>
          </div>
        ))}
        {pending && <p className="text-xs text-slate-400">The tutor is preparing an answer (it may be reviewed by staff first)…</p>}
        <div ref={endRef} />
      </div>
      <form onSubmit={send} className="mt-3 flex gap-2">
        <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Type your question…" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) void send(e); }} />
        <Button type="submit">Send</Button>
      </form>
      {notice && <p className="mt-2 text-xs text-amber-700">{notice}</p>}
      <ErrorText error={sendError ?? error} />
    </div>
  );
}

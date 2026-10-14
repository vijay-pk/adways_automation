import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Capabilities, type InboundLogEntry, type MessagingOverview, type Settings } from '../api/client';
import { isSuper, useAuth } from '../auth';
import { Badge, Button, Card, ErrorText, Field, Input, Select, Toggle, statusTone } from '../components/ui';
import { EmergencyControls } from '../components/EmergencyControls';

const CAP_LABELS: [keyof Capabilities, string][] = [
  ['receivePrivateMessages', 'Receive private messages'],
  ['sendPrivateMessages', 'Send private messages'],
  ['receiveGroupMessages', 'Receive group messages'],
  ['sendGroupMessages', 'Send group messages'],
  ['nativeMentions', 'Native @mentions'],
  ['quotedReplies', 'Quoted replies'],
  ['messageHistory', 'Message history access'],
];

function CapabilityList({ caps }: { caps: Capabilities }) {
  return (
    <div className="space-y-2">
      <ul className="grid gap-1 text-sm sm:grid-cols-2">
        {CAP_LABELS.map(([k, label]) => (
          <li key={k} className="flex items-center gap-2">
            {caps[k] ? <Badge tone="green">supported</Badge> : <Badge tone="red">unavailable</Badge>}
            {label}
          </li>
        ))}
      </ul>
      {caps.notes.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-slate-500">
          {caps.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MessagingPage() {
  const { admin } = useAuth();
  const qc = useQueryClient();
  const overview = useQuery({
    queryKey: ['messaging'],
    queryFn: () => api.get<MessagingOverview>('/api/settings/messaging'),
    // Poll faster while a device login is in progress so the QR and "connected" show up promptly.
    refetchInterval: (q) => (q.state.data?.login.supported && q.state.data.status.state !== 'connected' ? 3_000 : 10_000),
  });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings') });
  const save = useMutation({
    mutationFn: (patch: Partial<Settings>) => api.patch<Settings>('/api/settings', patch),
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s);
      void qc.invalidateQueries({ queryKey: ['messaging'] });
    },
  });
  const o = overview.data;
  const s = settings.data;
  const sup = isSuper(admin);
  const groupGap = o?.capabilities && (!o.capabilities.receiveGroupMessages || !o.capabilities.sendGroupMessages || !o.capabilities.nativeMentions);

  return (
    <>
      <h1 className="text-xl font-semibold">Messaging</h1>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Current adapter">
          {o && (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{o.adapter ?? 'none'}</strong>
                <Badge tone={statusTone(o.status.state)}>{o.status.state}</Badge>
                {o.experimental && <Badge tone="amber">experimental</Badge>}
                {o.status.botId && <code className="text-xs text-slate-500">bot id: {o.status.botId}</code>}
              </div>
              {o.status.detail && <p className="text-slate-500">{o.status.detail}</p>}
              {o.lastError && <p className="rounded bg-red-50 p-2 text-red-700">Diagnostics: {o.lastError}</p>}
              {s && (
                <Field label="Active adapter" hint="Switching keeps all transcripts, approved answers, settings and history (stored in the database).">
                  <Select value={s.messaging_adapter} disabled={!sup || save.isPending} onChange={(e) => save.mutate({ messaging_adapter: e.target.value as Settings['messaging_adapter'] })}>
                    <option value="mock">Mock (development / testing)</option>
                    <option value="whatsapp_cloud">WhatsApp Business Platform (official Cloud API)</option>
                    <option value="whatsapp_web">WhatsApp Web (experimental, QR login)</option>
                  </Select>
                </Field>
              )}
              {s && (
                <div className="space-y-2 rounded-lg bg-slate-50 p-3">
                  <Toggle
                    label="WhatsApp Business Platform policy checklist reviewed"
                    description="Confirms eligibility, approved number, template rules and that message data is not used for AI training."
                    checked={s.cloud_api_policy_acknowledged}
                    disabled={!sup}
                    onChange={(v) => save.mutate({ cloud_api_policy_acknowledged: v })}
                  />
                  <Toggle
                    label="WhatsApp Web automation risk acknowledged"
                    description="Unofficial automation may violate WhatsApp terms and risk number bans. Only use where authorized."
                    checked={s.whatsapp_web_risk_acknowledged}
                    disabled={!sup}
                    onChange={(v) => save.mutate({ whatsapp_web_risk_acknowledged: v })}
                  />
                  <p className="text-xs text-slate-500">
                    Use of platform message data for AI model training: <Badge tone="red">prohibited (locked off)</Badge>
                  </p>
                </div>
              )}
              <ErrorText error={save.error} />
            </div>
          )}
        </Card>
        {o?.adapter === 'whatsapp_web' && <WhatsAppWebLogin overview={o} canManage={sup} />}
        {o?.adapter === 'whatsapp_cloud' && <CloudApiSetup overview={o} canManage={sup} />}
        <Card title="Supported capabilities">
          {o?.capabilities ? <CapabilityList caps={o.capabilities} /> : <p className="text-sm text-slate-500">No adapter active.</p>}
          {groupGap && (
            <p className="mt-3 rounded bg-amber-50 p-2 text-xs text-amber-800">
              Group features are not available on this adapter. Students should use the website chat{s?.web_chat_url ? ` (${s.web_chat_url})` : ' (/chat)'} instead.
            </p>
          )}
        </Card>
        <Card title="Private-message & invocation settings">
          {s && (
            <div className="space-y-3">
              <Toggle label="Private replies enabled" checked={s.private_replies_enabled} disabled={!sup} onChange={(v) => save.mutate({ private_replies_enabled: v })} />
              <Toggle label="Group replies enabled" description="Groups still require a genuine mention." checked={s.group_replies_enabled} disabled={!sup} onChange={(v) => save.mutate({ group_replies_enabled: v })} />
              <Toggle
                label="Text-command mode"
                description="Also treat messages starting with the command as invocations (display-name text is never a mention)."
                checked={s.text_command_mode_enabled}
                disabled={!sup}
                onChange={(v) => save.mutate({ text_command_mode_enabled: v })}
              />
              <div className="grid grid-cols-2 gap-3">
                <Field label="Text command">
                  <Input defaultValue={s.text_command} disabled={!sup} onBlur={(e) => e.target.value !== s.text_command && save.mutate({ text_command: e.target.value })} />
                </Field>
                <Field label="Tutor display name">
                  <Input defaultValue={s.bot_display_name} disabled={!sup} onBlur={(e) => e.target.value !== s.bot_display_name && save.mutate({ bot_display_name: e.target.value })} />
                </Field>
              </div>
              <Toggle label="Website chat fallback enabled" checked={s.web_chat_enabled} disabled={!sup} onChange={(v) => save.mutate({ web_chat_enabled: v })} />
            </div>
          )}
        </Card>
        <EmergencyControls />
        <Card title="Queue">
          <ul className="space-y-1 text-sm">
            {(o?.queue ?? []).map((q) => (
              <li key={`${q.type}-${q.status}`} className="flex justify-between">
                <span>
                  {q.type} <Badge tone={statusTone(q.status)}>{q.status}</Badge>
                </span>
                <span>{q.count}</span>
              </li>
            ))}
          </ul>
        </Card>
        {sup && <InboundDiagnostics />}
        {o?.adapter === 'mock' && <MockSimulator />}
      </div>
    </>
  );
}

/** Super-admin diagnostics: why each captured inbound message was accepted, held, or blocked. */
function InboundDiagnostics() {
  const log = useQuery({
    queryKey: ['messaging-inbound-log'],
    queryFn: () => api.get<{ items: InboundLogEntry[] }>('/api/settings/messaging/inbound-log'),
    refetchInterval: 10_000,
  });
  const items = log.data?.items ?? [];
  const tone = (s: string) => (s === 'QUEUED' || s === 'CONSUMED' ? 'green' : s === 'BLOCKED' || s === 'IGNORED' ? 'red' : 'amber');
  return (
    <Card title="Recent inbound (diagnostics)">
      <div className="space-y-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-slate-500">Why each captured message was accepted, kept as context, or blocked. Message text is never shown here.</p>
          <Button variant="secondary" disabled={log.isFetching} onClick={() => void log.refetch()}>
            Refresh
          </Button>
        </div>
        {items.length === 0 ? (
          <p className="text-slate-500">No inbound messages captured yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2 py-2">
                <Badge tone={tone(m.status)}>{m.status}</Badge>
                <code className="text-xs text-slate-500">{m.sender}</code>
                <span className="text-xs text-slate-400">
                  {m.chatType}
                  {m.isMention ? ' · mention' : ''}
                  {m.via ? ` · ${m.via}` : ''}
                </span>
                <span className="text-slate-600">{m.reason}</span>
                <span className="ml-auto text-xs text-slate-400">{new Date(m.at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
        <ErrorText error={log.error} />
      </div>
    </Card>
  );
}

/** QR login for the experimental WhatsApp Web adapter. The QR image is fetched only while one is waiting. */
function WhatsAppWebLogin({ overview, canManage }: { overview: MessagingOverview; canManage: boolean }) {
  const qc = useQueryClient();
  const waiting = canManage && overview.login.qrAvailable;
  const qr = useQuery({
    queryKey: ['messaging-qr'],
    queryFn: () => api.get<{ qr: string | null }>('/api/settings/messaging/qr'),
    enabled: waiting,
    refetchInterval: waiting ? 3_000 : false,
    gcTime: 0,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['messaging'] });
  const connect = useMutation({ mutationFn: () => api.post('/api/settings/messaging/connect'), onSuccess: refresh });
  const logout = useMutation({ mutationFn: () => api.post('/api/settings/messaging/logout'), onSuccess: refresh });
  const state = overview.status.state;

  return (
    <Card title="WhatsApp Web login">
      <div className="space-y-3 text-sm">
        <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">
          Unofficial automation can violate WhatsApp terms and get the number banned. Use a separate test number, not your business number.
        </p>
        {state === 'connected' ? (
          <p>
            Linked as <code className="text-xs">{overview.status.botId}</code>.
          </p>
        ) : waiting && qr.data?.qr ? (
          <div className="space-y-2">
            <img src={qr.data.qr} alt="WhatsApp login QR code" className="h-56 w-56 rounded border border-slate-200" />
            <p className="text-xs text-slate-500">On the phone: WhatsApp → Settings → Linked devices → Link a device, then scan. The code refreshes automatically.</p>
          </div>
        ) : (
          <p className="text-slate-500">{state === 'connecting' ? 'Waiting for a QR code…' : 'Not linked.'}</p>
        )}
        {canManage && (
          <div className="flex flex-wrap gap-2">
            {state !== 'connected' && (
              <Button variant="secondary" disabled={connect.isPending} onClick={() => connect.mutate()}>
                {state === 'connecting' ? 'Restart connection' : 'Connect / show QR'}
              </Button>
            )}
            <Button
              variant="danger"
              disabled={logout.isPending}
              onClick={() => window.confirm('Unlink this device and delete the saved WhatsApp session?') && logout.mutate()}
            >
              Log out device
            </Button>
          </div>
        )}
        <ErrorText error={connect.error ?? logout.error} />
      </div>
    </Card>
  );
}

/** Configuration checklist for the official Cloud API. Secrets live in server environment variables only. */
function CloudApiSetup({ overview, canManage }: { overview: MessagingOverview; canManage: boolean }) {
  const qc = useQueryClient();
  const connect = useMutation({ mutationFn: () => api.post('/api/settings/messaging/connect'), onSuccess: () => void qc.invalidateQueries({ queryKey: ['messaging'] }) });
  const c = overview.cloud;
  const row = (label: string, ok: boolean, value?: string | null) => (
    <li className="flex items-center gap-2">
      {ok ? <Badge tone="green">set</Badge> : <Badge tone="red">missing</Badge>}
      {label}
      {value && <code className="text-xs text-slate-500">{value}</code>}
    </li>
  );
  return (
    <Card title="WhatsApp Business Platform setup">
      <div className="space-y-3 text-sm">
        <ul className="space-y-1">
          {row('Phone number ID', !!c.phoneNumberId, c.phoneNumberId)}
          {row('Access token', c.accessTokenSet)}
          {row('App secret (webhook signatures)', c.appSecretSet)}
          {row('Webhook verify token', c.verifyTokenSet)}
          <li className="text-xs text-slate-500">Business account ID: {c.businessAccountId ?? 'not set (optional)'} · Graph API {c.apiVersion}</li>
        </ul>
        {overview.cloudWebhookUrl && (
          <Field label="Webhook callback URL (paste into Meta → WhatsApp → Configuration, subscribe to “messages”)">
            <Input readOnly value={overview.cloudWebhookUrl} onFocus={(e) => e.target.select()} />
          </Field>
        )}
        <p className="text-xs text-slate-500">
          Values are set in the server environment (WHATSAPP_CLOUD_*), never in the browser. Restart the server after changing them.
        </p>
        {canManage && (
          <Button variant="secondary" disabled={connect.isPending || c.missing.length > 0} onClick={() => connect.mutate()}>
            Check connection
          </Button>
        )}
        <ErrorText error={connect.error} />
      </div>
    </Card>
  );
}

/** Development helper (requires ENABLE_DEV_ROUTES=true on the server). */
function MockSimulator() {
  const [form, setForm] = useState({ chatType: 'PRIVATE', chatId: 'student1@c.us', senderId: 'student1', text: '', mentionBot: false });
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const send = async () => {
    setError(null);
    try {
      await api.post('/api/dev/mock/inbound', form);
      setLog((l) => [`→ ${form.senderId}: ${form.text}`, ...l].slice(0, 10));
      setForm({ ...form, text: '' });
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Card title="Mock adapter simulator (development)">
      <div className="space-y-2">
        <div className="grid grid-cols-3 gap-2">
          <Select value={form.chatType} onChange={(e) => setForm({ ...form, chatType: e.target.value })}>
            <option value="PRIVATE">Private</option>
            <option value="GROUP">Group</option>
          </Select>
          <Input value={form.chatId} onChange={(e) => setForm({ ...form, chatId: e.target.value })} placeholder="chat id" />
          <Input value={form.senderId} onChange={(e) => setForm({ ...form, senderId: e.target.value })} placeholder="sender id" />
        </div>
        <Input value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder="Message text" onKeyDown={(e) => e.key === 'Enter' && void send()} />
        <Toggle label="Native @mention of the tutor" checked={form.mentionBot} onChange={(v) => setForm({ ...form, mentionBot: v })} />
        <div className="flex gap-2">
          <Button onClick={() => void send()} disabled={!form.text}>Send inbound</Button>
          <Button variant="secondary" onClick={() => void api.post('/api/dev/jobs/run').then((r) => setLog((l) => [`ran jobs: ${JSON.stringify(r)}`, ...l]))}>
            Run due jobs now
          </Button>
        </div>
        <ErrorText error={error} />
        <ul className="text-xs text-slate-500">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>
      </div>
    </Card>
  );
}

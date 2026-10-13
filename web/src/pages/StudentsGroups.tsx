import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { canReview, isSuper, useAuth } from '../auth';
import { Badge, Button, Card, Empty, ErrorText, Input, Select, Textarea, Toggle, fmtDate, statusTone } from '../components/ui';

interface Student {
  id: string;
  channel: string;
  platformUserId: string;
  normalizedPhone: string | null;
  displayName: string | null;
  enrollmentStatus: string;
  dailyLimitOverride: number | null;
  questionsLast24h: number;
  createdAt: string;
}
interface Group {
  id: string;
  channel: string;
  externalChatId: string;
  name: string | null;
  enabled: boolean;
  createdAt: string;
}

const STATUSES = ['ACTIVE', 'PENDING', 'SUSPENDED', 'REMOVED'];

export function StudentsGroupsPage() {
  return (
    <>
      <h1 className="text-xl font-semibold">Students & Groups</h1>
      <GroupsCard />
      <StudentsCard />
    </>
  );
}

function GroupsCard() {
  const { admin } = useAuth();
  const sup = isSuper(admin);
  const qc = useQueryClient();
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api.get<{ items: Group[] }>('/api/groups') });
  const [form, setForm] = useState({ channel: 'MOCK', externalChatId: '', name: '' });
  const save = useMutation({
    mutationFn: (p: { id?: string; body: object }) => (p.id ? api.patch(`/api/groups/${p.id}`, p.body) : api.post('/api/groups', p.body)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['groups'] }),
  });
  return (
    <Card title="Group allowlist">
      <p className="mb-3 text-xs text-slate-500">
        The tutor only processes mentions in enabled groups. Groups the connection sees are added here automatically as disabled.
      </p>
      {!groups.data?.items.length ? (
        <Empty>No groups yet.</Empty>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm">
          {groups.data.items.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-medium">{g.name ?? g.externalChatId}</span> <code className="text-xs text-slate-500">{g.channel} · {g.externalChatId}</code>
              </span>
              <Toggle label={g.enabled ? 'Enabled' : 'Disabled'} checked={g.enabled} disabled={!sup} onChange={(v) => save.mutate({ id: g.id, body: { enabled: v } })} />
            </li>
          ))}
        </ul>
      )}
      {sup && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
            <option value="MOCK">MOCK</option>
            <option value="WHATSAPP_WEB">WHATSAPP_WEB</option>
            <option value="WHATSAPP_CLOUD">WHATSAPP_CLOUD</option>
          </Select>
          <Input className="max-w-xs" placeholder="Group id (e.g. 1203...@g.us)" value={form.externalChatId} onChange={(e) => setForm({ ...form, externalChatId: e.target.value })} />
          <Input className="max-w-xs" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Button disabled={!form.externalChatId} onClick={() => save.mutate({ body: { ...form, name: form.name || undefined, enabled: true } })}>Add enabled group</Button>
        </div>
      )}
      <ErrorText error={save.error} />
    </Card>
  );
}

function StudentsCard() {
  const { admin } = useAuth();
  const reviewer = canReview(admin);
  const sup = isSuper(admin);
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [csv, setCsv] = useState('');
  const [issued, setIssued] = useState<{ name: string; code: string; phone: string | null } | null>(null);
  const params = new URLSearchParams({ take: '100' });
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  const students = useQuery({ queryKey: ['students', q, status], queryFn: () => api.get<{ items: Student[]; total: number }>(`/api/students?${params}`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['students'] });
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: object }) => api.patch(`/api/students/${id}`, body), onSuccess: refresh });
  const importCsv = useMutation({
    mutationFn: () => api.postText<{ created: number; updated: number; errors: { line: number; error: string }[] }>('/api/students/import', csv),
    onSuccess: refresh,
  });
  const issueCode = useMutation({
    mutationFn: (s: Student) => api.post<{ code: string; phone: string | null }>(`/api/students/${s.id}/web-access-code`).then((r) => ({ ...r, name: s.displayName ?? s.platformUserId })),
    onSuccess: setIssued,
  });
  const wipe = useMutation({ mutationFn: (id: string) => api.del(`/api/students/${id}/data`), onSuccess: refresh });

  return (
    <Card
      title={`Students (${students.data?.total ?? 0})`}
      actions={
        <>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / id / phone" className="w-48" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {STATUSES.map((s) => <option key={s}>{s}</option>)}
          </Select>
          <a href="/api/students/export.csv" className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">Export CSV</a>
        </>
      }
    >
      {issued && (
        <p className="mb-3 rounded bg-emerald-50 p-2 text-sm text-emerald-800">
          Website chat code for {issued.name}: <strong className="font-mono">{issued.code}</strong> (phone {issued.phone ?? 'not set — add a phone first'}). Shown once.
        </p>
      )}
      {!students.data?.items.length ? (
        <Empty>No students yet. They appear when they message the tutor, or import a CSV below.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-2">Student</th>
                <th>Status</th>
                <th>Questions 24h</th>
                <th>Daily limit</th>
                <th>Since</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {students.data.items.map((s) => (
                <tr key={s.id}>
                  <td className="py-2">
                    <div className="font-medium">{s.displayName ?? '—'}</div>
                    <code className="text-xs text-slate-500">{s.channel} · {s.platformUserId} {s.normalizedPhone && `· ${s.normalizedPhone}`}</code>
                  </td>
                  <td>
                    {reviewer ? (
                      <Select value={s.enrollmentStatus} onChange={(e) => update.mutate({ id: s.id, body: { enrollmentStatus: e.target.value } })}>
                        {STATUSES.map((x) => <option key={x}>{x}</option>)}
                      </Select>
                    ) : (
                      <Badge tone={statusTone(s.enrollmentStatus)}>{s.enrollmentStatus}</Badge>
                    )}
                  </td>
                  <td>{s.questionsLast24h}</td>
                  <td>
                    <Input
                      type="number"
                      className="w-20"
                      disabled={!reviewer}
                      defaultValue={s.dailyLimitOverride ?? ''}
                      placeholder="default"
                      onBlur={(e) => update.mutate({ id: s.id, body: { dailyLimitOverride: e.target.value === '' ? null : Number(e.target.value) } })}
                    />
                  </td>
                  <td className="text-xs text-slate-500">{fmtDate(s.createdAt)}</td>
                  <td className="space-x-1 whitespace-nowrap text-right">
                    {reviewer && (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          const phone = s.normalizedPhone ?? prompt('Phone number for website chat login (with country code):');
                          if (!phone) return;
                          const go = () => issueCode.mutate(s);
                          if (!s.normalizedPhone) update.mutate({ id: s.id, body: { phone } }, { onSuccess: go });
                          else go();
                        }}
                      >
                        Web chat code
                      </Button>
                    )}
                    {sup && (
                      <Button variant="ghost" className="text-red-600" onClick={() => confirm('Delete this student and all their messages and derived data?') && wipe.mutate(s.id)}>
                        Delete data
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorText error={update.error ?? issueCode.error ?? wipe.error} />
      {reviewer && (
        <div className="mt-4 space-y-2 border-t border-slate-100 pt-4">
          <div className="text-sm font-medium">Import enrollment records</div>
          <p className="text-xs text-slate-500">CSV columns: channel,platform_user_id,phone,display_name,enrollment_status — only import records you are permitted to hold.</p>
          <Textarea rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'channel,platform_user_id,phone,display_name,enrollment_status\nWHATSAPP_WEB,919800000000@c.us,+919800000000,Asha,ACTIVE'} />
          <Button variant="secondary" disabled={!csv.trim() || importCsv.isPending} onClick={() => importCsv.mutate()}>Import</Button>
          {importCsv.data && (
            <p className="text-xs">
              Created {importCsv.data.created}, updated {importCsv.data.updated}
              {importCsv.data.errors.length > 0 && `, ${importCsv.data.errors.length} errors: ${importCsv.data.errors.map((e) => `line ${e.line}: ${e.error}`).join('; ')}`}
            </p>
          )}
          <ErrorText error={importCsv.error} />
        </div>
      )}
    </Card>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Admin, type Role } from '../api/client';
import { isSuper, useAuth } from '../auth';
import { Badge, Button, Card, Empty, ErrorText, Input, Select, fmtDate } from '../components/ui';
import { EmergencyControls } from '../components/EmergencyControls';

interface SystemInfo {
  database: { ok: boolean; migrations: { migration_name: string; finished_at: string | null }[] };
  ai: { provider: string; answerModel: string; fastModel: string; apiKey: string | null };
  backups: { note: string; lastBackupAt: string | null };
  nodeEnv: string;
}
interface AuditItem {
  id: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: unknown;
  createdAt: string;
  administrator: { email: string } | null;
}

export function AdministrationPage() {
  const { admin } = useAuth();
  const sup = isSuper(admin);
  return (
    <>
      <h1 className="text-xl font-semibold">Administration</h1>
      <div className="grid gap-4 lg:grid-cols-2">
        {sup ? <AdminsCard /> : <Card title="Administrators"><p className="text-sm text-slate-500">Only super admins manage roles.</p></Card>}
        <div className="space-y-4">
          <SystemCard />
          <EmergencyControls />
          <Card title="Your account">
            <Link to="/account" className="text-sm text-brand-700 hover:underline">Change password / two-factor settings</Link>
          </Card>
        </div>
      </div>
      <AuditCard />
    </>
  );
}

function AdminsCard() {
  const { admin: me } = useAuth();
  const qc = useQueryClient();
  const admins = useQuery({ queryKey: ['admins'], queryFn: () => api.get<{ items: Admin[] }>('/api/admin/admins') });
  const [form, setForm] = useState({ email: '', role: 'REVIEWER' as Role, temporaryPassword: '' });
  const [token, setToken] = useState<{ email: string; token: string } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admins'] });
  const create = useMutation({ mutationFn: () => api.post('/api/admin/admins', form), onSuccess: () => { setForm({ email: '', role: 'REVIEWER', temporaryPassword: '' }); refresh(); } });
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: object }) => api.patch(`/api/admin/admins/${id}`, body), onSuccess: refresh });
  const reset = useMutation({
    mutationFn: (a: Admin) => api.post<{ token: string }>(`/api/admin/admins/${a.id}/reset-token`).then((r) => ({ email: a.email, token: r.token })),
    onSuccess: setToken,
  });

  return (
    <Card title="Administrators & roles">
      <ul className="divide-y divide-slate-100 text-sm">
        {admins.data?.items.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div>
              <div className="font-medium">
                {a.email} {a.id === me?.id && <Badge tone="blue">you</Badge>} {!a.isActive && <Badge tone="red">inactive</Badge>} {a.totpEnabled && <Badge tone="green">2FA</Badge>}
              </div>
              <div className="text-xs text-slate-500">Last login {fmtDate(a.lastLoginAt)}</div>
            </div>
            <div className="flex flex-wrap gap-1">
              <Select value={a.role} onChange={(e) => update.mutate({ id: a.id, body: { role: e.target.value } })}>
                <option value="SUPER_ADMIN">Super admin</option>
                <option value="REVIEWER">Reviewer</option>
                <option value="VIEWER">Viewer</option>
              </Select>
              <Button variant="ghost" onClick={() => update.mutate({ id: a.id, body: { isActive: !a.isActive } })}>{a.isActive ? 'Deactivate' : 'Activate'}</Button>
              <Button variant="ghost" onClick={() => reset.mutate(a)}>Reset token</Button>
            </div>
          </li>
        ))}
      </ul>
      {token && (
        <p className="mt-2 break-all rounded bg-emerald-50 p-2 text-xs text-emerald-800">
          One-time reset token for {token.email} (60 min): <code>{token.token}</code> — share it securely; they use it at /reset-password.
        </p>
      )}
      <div className="mt-4 space-y-2 border-t border-slate-100 pt-4">
        <div className="text-sm font-medium">Add administrator</div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Input placeholder="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            <option value="REVIEWER">Reviewer</option>
            <option value="VIEWER">Viewer</option>
            <option value="SUPER_ADMIN">Super admin</option>
          </Select>
          <Input type="password" placeholder="temporary password" value={form.temporaryPassword} onChange={(e) => setForm({ ...form, temporaryPassword: e.target.value })} />
        </div>
        <p className="text-xs text-slate-400">They must change the temporary password at first login.</p>
        <Button disabled={create.isPending} onClick={() => create.mutate()}>Create</Button>
      </div>
      <ErrorText error={create.error ?? update.error ?? reset.error} />
    </Card>
  );
}

function SystemCard() {
  const sys = useQuery({ queryKey: ['system'], queryFn: () => api.get<SystemInfo>('/api/admin/system') });
  const s = sys.data;
  return (
    <Card title="Provider configuration & system status">
      {!s ? (
        <Empty>Loading…</Empty>
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">Database</dt>
          <dd>{s.database.ok ? <Badge tone="green">connected</Badge> : <Badge tone="red">error</Badge>} {s.database.migrations.length} migrations applied</dd>
          <dt className="text-slate-500">AI provider</dt>
          <dd>{s.ai.provider} · {s.ai.answerModel} / {s.ai.fastModel}</dd>
          <dt className="text-slate-500">API key</dt>
          <dd><code>{s.ai.apiKey ?? 'not set'}</code></dd>
          <dt className="text-slate-500">Backups</dt>
          <dd>{s.backups.lastBackupAt ? fmtDate(s.backups.lastBackupAt) : <span className="text-amber-700">no backup marker — see docs/DEPLOYMENT.md</span>}</dd>
          <dt className="text-slate-500">Environment</dt>
          <dd>{s.nodeEnv}</dd>
        </dl>
      )}
    </Card>
  );
}

function AuditCard() {
  const [action, setAction] = useState('');
  const [skip, setSkip] = useState(0);
  const audit = useQuery({
    queryKey: ['audit', action, skip],
    queryFn: () => api.get<{ items: AuditItem[]; total: number }>(`/api/admin/audit?take=50&skip=${skip}${action ? `&action=${encodeURIComponent(action)}` : ''}`),
  });
  return (
    <Card title={`Audit log (${audit.data?.total ?? 0})`} actions={<Input className="w-48" placeholder="Filter by action prefix" value={action} onChange={(e) => { setAction(e.target.value); setSkip(0); }} />}>
      {!audit.data?.items.length ? (
        <Empty>No entries.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr><th className="py-2">When</th><th>Who</th><th>Action</th><th>Resource</th><th>Details</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {audit.data.items.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap py-1.5 text-xs text-slate-500">{fmtDate(a.createdAt)}</td>
                  <td className="text-xs">{a.administrator?.email ?? 'system'}</td>
                  <td><code className="text-xs">{a.action}</code></td>
                  <td className="text-xs text-slate-500">{a.resourceType} {a.resourceId?.slice(0, 8)}</td>
                  <td className="max-w-xs truncate text-xs text-slate-500">{a.metadata ? JSON.stringify(a.metadata) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <Button variant="secondary" disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - 50))}>Newer</Button>
        <Button variant="secondary" disabled={!audit.data || skip + 50 >= audit.data.total} onClick={() => setSkip(skip + 50)}>Older</Button>
      </div>
    </Card>
  );
}

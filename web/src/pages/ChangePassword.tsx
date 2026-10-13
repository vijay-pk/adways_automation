import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth';
import { Badge, Button, Card, ErrorText, Field, Input } from '../components/ui';

export function ChangePasswordPage({ forced }: { forced?: boolean }) {
  const { admin, refresh, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setOk(false);
    if (next !== confirm) return setError(new Error('New passwords do not match'));
    try {
      await api.post('/api/auth/change-password', { currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setOk(true);
      await refresh();
    } catch (err) {
      setError(err);
    }
  };

  const form = (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Current password">
        <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </Field>
      <Field label="New password" hint="At least 12 characters with letters and numbers.">
        <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
      </Field>
      <Field label="Confirm new password">
        <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </Field>
      <ErrorText error={error} />
      {ok && <p className="text-sm text-emerald-700">Password changed. Other sessions were signed out.</p>}
      <Button type="submit">Change password</Button>
    </form>
  );

  if (forced) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold">Set a new password</h1>
          <p className="mb-4 text-xs text-slate-500">You must change the initial password before continuing.</p>
          {form}
          <button onClick={() => void logout()} className="mt-3 text-xs text-slate-500 hover:underline">
            Sign out
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Change password">{form}</Card>
      <TotpCard enabled={!!admin?.totpEnabled} onChange={refresh} />
    </div>
  );
}

function TotpCard({ enabled, onChange }: { enabled: boolean; onChange: () => Promise<void> }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Card title={<span className="flex items-center gap-2">Two-factor authentication {enabled ? <Badge tone="green">on</Badge> : <Badge>off</Badge>}</span>}>
      <div className="space-y-3 text-sm">
        {enabled ? (
          <>
            <p className="text-slate-600">Disable two-factor by confirming your password.</p>
            <Input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <Button variant="danger" onClick={() => run(async () => { await api.post('/api/auth/totp/disable', { password }); await onChange(); })}>
              Disable 2FA
            </Button>
          </>
        ) : setup ? (
          <>
            <p className="text-slate-600">Add this secret to an authenticator app (manual entry), then enter the 6-digit code.</p>
            <code className="block break-all rounded bg-slate-100 p-2 text-xs">{setup.secret}</code>
            <code className="block break-all rounded bg-slate-50 p-2 text-[11px] text-slate-500">{setup.otpauthUrl}</code>
            <Input inputMode="numeric" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
            <Button onClick={() => run(async () => { await api.post('/api/auth/totp/enable', { code }); setSetup(null); await onChange(); })}>
              Enable 2FA
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={() => run(async () => setSetup(await api.post('/api/auth/totp/setup')))}>
            Set up authenticator
          </Button>
        )}
        <ErrorText error={error} />
      </div>
    </Card>
  );
}

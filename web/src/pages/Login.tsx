import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth';
import { Button, ErrorText, Field, Input } from '../components/ui';

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-lg font-semibold">{title}</h1>
        <p className="mb-5 text-xs text-slate-500">Course Tutor admin console</p>
        {children}
      </div>
    </div>
  );
}

export function LoginPage() {
  const { login, totpRequired, refresh, logout } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (totpRequired) {
        await api.post('/api/auth/totp/verify', { code });
        await refresh();
      } else {
        await login(email, password);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title={totpRequired ? 'Two-factor verification' : 'Sign in'}>
      <form onSubmit={submit} className="space-y-3">
        {totpRequired ? (
          <Field label="Authenticator code">
            <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          </Field>
        ) : (
          <>
            <Field label="Email">
              <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </Field>
            <Field label="Password">
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
          </>
        )}
        <ErrorText error={error} />
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Please wait…' : totpRequired ? 'Verify' : 'Sign in'}
        </Button>
        {totpRequired ? (
          <button type="button" onClick={() => void logout()} className="w-full text-xs text-slate-500 hover:underline">
            Use a different account
          </button>
        ) : (
          <Link to="/reset-password" className="block text-center text-xs text-slate-500 hover:underline">
            Have a reset token?
          </Link>
        )}
      </form>
    </Shell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const [token, setToken] = useState(params.get('token') ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) return setError(new Error('Passwords do not match'));
    try {
      await api.post('/api/auth/reset-password', { token: token.trim(), newPassword: password });
      setDone(true);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Shell title="Reset password">
      {done ? (
        <div className="space-y-3 text-sm">
          <p>Password updated. Sign in with your new password.</p>
          <Button onClick={() => navigate('/')}>Go to sign in</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <p className="text-xs text-slate-500">
            Ask a super admin for a one-time reset token, or run <code>npm run admin:reset-password -- you@example.com</code> on the server.
          </p>
          <Field label="Reset token">
            <Input value={token} onChange={(e) => setToken(e.target.value)} required />
          </Field>
          <Field label="New password" hint="At least 12 characters with letters and numbers.">
            <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Field label="Confirm new password">
            <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </Field>
          <ErrorText error={error} />
          <Button type="submit" className="w-full">
            Reset password
          </Button>
        </form>
      )}
    </Shell>
  );
}

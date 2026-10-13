import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth';
import { api } from '../api/client';
import { Badge } from './ui';

const NAV = [
  { to: '/', label: 'Dashboard' },
  { to: '/approvals', label: 'Approval Queue', badge: true },
  { to: '/messaging', label: 'Messaging' },
  { to: '/reply-settings', label: 'Reply Settings' },
  { to: '/knowledge', label: 'Knowledge Base' },
  { to: '/memory', label: 'Approved Answer Memory' },
  { to: '/students', label: 'Students & Groups' },
  { to: '/admin', label: 'Administration' },
];

export function Layout({ children }: { children: ReactNode }) {
  const { admin, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const pending = useQuery({
    queryKey: ['pending-count'],
    queryFn: () => api.get<{ total: number }>('/api/responses?status=PENDING_APPROVAL&take=1'),
    refetchInterval: 15_000,
  });

  return (
    <div className="min-h-screen lg:flex">
      <aside className={`${open ? 'block' : 'hidden'} border-b border-slate-200 bg-white lg:block lg:min-h-screen lg:w-60 lg:border-b-0 lg:border-r`}>
        <div className="hidden px-5 py-5 lg:block">
          <div className="text-sm font-semibold text-slate-900">Course Tutor</div>
          <div className="text-xs text-slate-500">Admin console</div>
        </div>
        <nav className="space-y-0.5 px-3 pb-4">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `flex items-center justify-between rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-100'}`
              }
            >
              {n.label}
              {n.badge && !!pending.data?.total && <Badge tone="amber">{pending.data.total}</Badge>}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="flex-1">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
          <button className="text-sm text-slate-600 lg:hidden" onClick={() => setOpen(!open)} aria-label="Toggle navigation">
            ☰ Menu
          </button>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <NavLink to="/account" className="text-slate-600 hover:underline">
              {admin?.email}
            </NavLink>
            <Badge tone="blue">{admin?.role.replace('_', ' ').toLowerCase()}</Badge>
            <button onClick={() => void logout()} className="text-slate-500 hover:text-slate-900">
              Sign out
            </button>
          </div>
        </header>
        <main className="mx-auto max-w-7xl space-y-4 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}

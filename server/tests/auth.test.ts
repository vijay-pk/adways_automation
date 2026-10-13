import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import { prisma } from '../src/db/prisma.js';
import { bootstrapInitialAdmin, issueResetToken } from '../src/auth/authService.js';
import { verifyPassword } from '../src/auth/password.js';
import { app, createAdmin, login, PASSWORD, setupWorld } from './helpers.js';

beforeEach(async () => {
  await setupWorld();
});

describe('initial admin bootstrap', () => {
  it('creates the first super admin once, hashed with Argon2id, requiring a password change', async () => {
    const r1 = await bootstrapInitialAdmin('Owner@Example.com', 'Initial-Pass-123');
    expect(r1.created).toBe(true);
    const admin = await prisma.administrator.findUniqueOrThrow({ where: { email: 'owner@example.com' } });
    expect(admin.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(admin.passwordHash).not.toContain('Initial-Pass-123');
    expect(admin.mustChangePassword).toBe(true);
    expect(admin.role).toBe('SUPER_ADMIN');
    const r2 = await bootstrapInitialAdmin('other@example.com', 'Another-Pass-123');
    expect(r2.created).toBe(false);
    expect(await prisma.administrator.count()).toBe(1);
  });

  it('rejects weak initial passwords and missing variables', async () => {
    await expect(bootstrapInitialAdmin('a@b.co', 'short')).rejects.toThrow();
    await expect(bootstrapInitialAdmin(undefined, undefined)).rejects.toThrow();
  });

  it('forces a password change before any protected endpoint can be used', async () => {
    await bootstrapInitialAdmin('owner@example.com', 'Initial-Pass-123');
    const agent = request.agent(app);
    const loginRes = await agent.post('/api/auth/login').send({ email: 'owner@example.com', password: 'Initial-Pass-123' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.admin.mustChangePassword).toBe(true);
    const csrf = loginRes.body.csrfToken;
    expect((await agent.get('/api/dashboard')).status).toBe(403);
    const change = await agent
      .post('/api/auth/change-password')
      .set('x-csrf-token', csrf)
      .send({ currentPassword: 'Initial-Pass-123', newPassword: 'Brand-New-Pass-456' });
    expect(change.status).toBe(200);
    expect((await agent.get('/api/dashboard')).status).toBe(200);
  });
});

describe('login security', () => {
  it('has no public registration route', async () => {
    expect((await request(app).post('/api/auth/register').send({})).status).toBe(404);
  });

  it('protects every admin endpoint', async () => {
    for (const url of ['/api/dashboard', '/api/settings', '/api/responses', '/api/memory', '/api/transcripts', '/api/students', '/api/admin/audit']) {
      expect((await request(app).get(url)).status).toBe(401);
    }
  });

  it('sets a secure HttpOnly session cookie and logs out', async () => {
    const admin = await createAdmin();
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/login').send({ email: admin.email, password: PASSWORD });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/tutor_sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await agent.post('/api/auth/logout').set('x-csrf-token', res.body.csrfToken)).status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('locks the account after repeated failures', async () => {
    const admin = await createAdmin();
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post('/api/auth/login').send({ email: admin.email, password: 'wrong-password-1' })).status).toBe(401);
    }
    const locked = await request(app).post('/api/auth/login').send({ email: admin.email, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(await prisma.auditLog.count({ where: { action: 'auth.lockout' } })).toBe(1);
  });

  it('rejects unknown users with the same message', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: 'nobody@x.dev', password: 'whatever-123' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('Invalid email or password');
  });

  it('expired sessions are rejected', async () => {
    const s = await login();
    await prisma.adminSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await s.get('/api/dashboard')).status).toBe(401);
  });

  it('password reset tokens are single-use and end other sessions', async () => {
    const s = await login();
    const token = await issueResetToken(s.admin.id);
    const ok = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'Reset-Password-789' });
    expect(ok.status).toBe(200);
    expect((await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'Reset-Password-000' })).status).toBe(400);
    expect((await s.get('/api/dashboard')).status).toBe(401);
    const a = await prisma.administrator.findUniqueOrThrow({ where: { id: s.admin.id } });
    expect(await verifyPassword(a.passwordHash, 'Reset-Password-789')).toBe(true);
  });

  it('supports optional TOTP two-factor authentication', async () => {
    const s = await login();
    const setup = await s.post('/api/auth/totp/setup');
    expect(setup.status).toBe(200);
    const secret = setup.body.secret as string;
    expect((await s.post('/api/auth/totp/enable', { code: '000000' })).status).toBe(400);
    expect((await s.post('/api/auth/totp/enable', { code: authenticator.generate(secret) })).status).toBe(200);
    const stored = await prisma.administrator.findUniqueOrThrow({ where: { id: s.admin.id } });
    expect(stored.totpSecret).not.toContain(secret); // encrypted at rest

    const agent = request.agent(app);
    const res = await agent.post('/api/auth/login').send({ email: s.admin.email, password: PASSWORD });
    expect(res.body.totpRequired).toBe(true);
    expect((await agent.get('/api/dashboard')).status).toBe(401);
    const verify = await agent.post('/api/auth/totp/verify').set('x-csrf-token', res.body.csrfToken).send({ code: authenticator.generate(secret) });
    expect(verify.status).toBe(200);
    expect((await agent.get('/api/dashboard')).status).toBe(200);
  });
});

describe('roles and audit', () => {
  it('only super admins manage administrators; the last super admin cannot be removed', async () => {
    const sup = await login('SUPER_ADMIN');
    const reviewer = await login('REVIEWER');
    expect((await reviewer.get('/api/admin/admins')).status).toBe(403);
    const created = await sup.post('/api/admin/admins', { email: 'new@x.dev', role: 'VIEWER', temporaryPassword: 'Temp-Password-123' });
    expect(created.status).toBe(201);
    expect(created.body.mustChangePassword).toBe(true);
    expect((await sup.patch(`/api/admin/admins/${sup.admin.id}`, { role: 'VIEWER' })).status).toBe(400);
    const audit = await sup.get('/api/admin/audit');
    expect(audit.body.items.some((a: { action: string }) => a.action === 'admin.create')).toBe(true);
  });

  it('never exposes password hashes or full secrets', async () => {
    const sup = await login('SUPER_ADMIN');
    const admins = await sup.get('/api/admin/admins');
    expect(JSON.stringify(admins.body)).not.toMatch(/argon2|passwordHash|totpSecret/);
    const sys = await sup.get('/api/admin/system');
    expect(sys.status).toBe(200);
    expect(sys.body.database.ok).toBe(true);
  });
});

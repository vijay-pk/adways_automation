import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { parseBody } from '../lib/validate.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { audit } from '../audit/auditService.js';
import { requireAuth } from './middleware.js';
import { clearSessionCookie, createSession, destroyAllSessions, destroySession, setSessionCookie } from './sessions.js';
import { authenticate, changePassword, publicAdmin, resetPasswordWithToken } from './authService.js';
import { generateTotpSecret, totpUri, verifyTotp } from './totp.js';
import { open, seal } from '../lib/secretBox.js';
import { verifyPassword } from './password.js';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.NODE_ENV === 'test' ? 1000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later' },
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const body = parseBody(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), req.body);
  const admin = await authenticate(body.email, body.password);
  const { token, session } = await createSession(admin.id, {
    totpPending: admin.totpEnabled,
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  setSessionCookie(res, token);
  await audit(admin.id, 'auth.login', 'administrator', admin.id, { ip: req.ip });
  res.json({ admin: publicAdmin(admin), csrfToken: session.csrfToken, totpRequired: admin.totpEnabled });
});

authRouter.post('/totp/verify', loginLimiter, requireAuth({ allowTotpPending: true, allowPasswordChange: true }), async (req, res) => {
  const { code } = parseBody(z.object({ code: z.string().min(6).max(10) }), req.body);
  const { admin, session } = req.auth!;
  if (!admin.totpEnabled || !admin.totpSecret) throw badRequest('Two-factor is not enabled');
  if (!verifyTotp(open(admin.totpSecret), code)) {
    await audit(admin.id, 'auth.totp_failed', 'administrator', admin.id);
    throw unauthorized('Invalid code');
  }
  await prisma.adminSession.update({ where: { id: session.id }, data: { totpPending: false } });
  res.json({ ok: true });
});

authRouter.post('/logout', requireAuth({ allowPasswordChange: true, allowTotpPending: true }), async (req, res) => {
  await destroySession(req.auth!.session.id);
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth({ allowPasswordChange: true, allowTotpPending: true }), (req, res) => {
  const { admin, session } = req.auth!;
  res.json({ admin: publicAdmin(admin), csrfToken: session.csrfToken, totpRequired: session.totpPending });
});

authRouter.post('/change-password', requireAuth({ allowPasswordChange: true }), async (req, res) => {
  const body = parseBody(z.object({ currentPassword: z.string(), newPassword: z.string() }), req.body);
  const { admin, session } = req.auth!;
  await changePassword(admin, body.currentPassword, body.newPassword);
  await destroyAllSessions(admin.id, session.id);
  await audit(admin.id, 'auth.password_changed', 'administrator', admin.id);
  res.json({ ok: true });
});

authRouter.post('/reset-password', loginLimiter, async (req, res) => {
  const body = parseBody(z.object({ token: z.string().min(10), newPassword: z.string() }), req.body);
  await resetPasswordWithToken(body.token, body.newPassword);
  res.json({ ok: true });
});

// TOTP enrollment: setup returns a secret (shown once), enable confirms with a valid code.
authRouter.post('/totp/setup', requireAuth(), async (req, res) => {
  const { admin } = req.auth!;
  if (admin.totpEnabled) throw badRequest('Two-factor already enabled');
  const secret = generateTotpSecret();
  await prisma.administrator.update({ where: { id: admin.id }, data: { totpSecret: seal(secret) } });
  res.json({ secret, otpauthUrl: totpUri(admin.email, secret) });
});

authRouter.post('/totp/enable', requireAuth(), async (req, res) => {
  const { code } = parseBody(z.object({ code: z.string() }), req.body);
  const { admin } = req.auth!;
  if (!admin.totpSecret || !verifyTotp(open(admin.totpSecret), code)) throw badRequest('Invalid code');
  await prisma.administrator.update({ where: { id: admin.id }, data: { totpEnabled: true } });
  await audit(admin.id, 'auth.totp_enabled', 'administrator', admin.id);
  res.json({ ok: true });
});

authRouter.post('/totp/disable', requireAuth(), async (req, res) => {
  const { password } = parseBody(z.object({ password: z.string() }), req.body);
  const { admin } = req.auth!;
  if (!(await verifyPassword(admin.passwordHash, password))) throw badRequest('Password is incorrect');
  await prisma.administrator.update({ where: { id: admin.id }, data: { totpEnabled: false, totpSecret: null } });
  await audit(admin.id, 'auth.totp_disabled', 'administrator', admin.id);
  res.json({ ok: true });
});

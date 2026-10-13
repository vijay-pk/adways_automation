import { Router } from 'express';
import { z } from 'zod';
import { AdminRole } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { requireRole, SUPER } from '../auth/middleware.js';
import { parseBody } from '../lib/validate.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit } from '../audit/auditService.js';
import { hashPassword, passwordPolicy } from '../auth/password.js';
import { issueResetToken, publicAdmin } from '../auth/authService.js';
import { maskSecret } from '../lib/crypto.js';
import { destroyAllSessions } from '../auth/sessions.js';
import { integrationHealth } from './health.js';

export const adminRouter = Router();

adminRouter.get('/admins', requireRole(...SUPER), async (_req, res) => {
  const admins = await prisma.administrator.findMany({ orderBy: { createdAt: 'asc' } });
  res.json({ items: admins.map(publicAdmin) });
});

adminRouter.post('/admins', requireRole(...SUPER), async (req, res) => {
  const body = parseBody(
    z.object({ email: z.string().email(), role: z.nativeEnum(AdminRole), temporaryPassword: passwordPolicy }),
    req.body,
  );
  const email = body.email.trim().toLowerCase();
  if (await prisma.administrator.findUnique({ where: { email } })) throw conflict('An administrator with this email exists');
  const admin = await prisma.administrator.create({
    data: { email, role: body.role, passwordHash: await hashPassword(body.temporaryPassword), mustChangePassword: true },
  });
  await audit(req.auth!.admin.id, 'admin.create', 'administrator', admin.id, { role: admin.role });
  res.status(201).json(publicAdmin(admin));
});

adminRouter.patch('/admins/:id', requireRole(...SUPER), async (req, res) => {
  const body = parseBody(z.object({ role: z.nativeEnum(AdminRole).optional(), isActive: z.boolean().optional() }), req.body);
  const id = req.params.id as string;
  const target = await prisma.administrator.findUnique({ where: { id } });
  if (!target) throw notFound();
  const demoting = target.role === 'SUPER_ADMIN' && ((body.role && body.role !== 'SUPER_ADMIN') || body.isActive === false);
  if (demoting) {
    const supers = await prisma.administrator.count({ where: { role: 'SUPER_ADMIN', isActive: true } });
    if (supers <= 1) throw badRequest('Cannot remove the last active super admin');
  }
  const updated = await prisma.administrator.update({ where: { id }, data: body });
  if (body.isActive === false || body.role) await destroyAllSessions(id);
  await audit(req.auth!.admin.id, 'admin.update', 'administrator', id, body);
  res.json(publicAdmin(updated));
});

/** Permanently removes an administrator. Their audit entries and approvals remain (actor set to null). */
adminRouter.delete('/admins/:id', requireRole(...SUPER), async (req, res) => {
  const id = req.params.id as string;
  if (id === req.auth!.admin.id) throw badRequest('You cannot remove your own account');
  const target = await prisma.administrator.findUnique({ where: { id } });
  if (!target) throw notFound();
  if (target.role === 'SUPER_ADMIN' && target.isActive) {
    const supers = await prisma.administrator.count({ where: { role: 'SUPER_ADMIN', isActive: true } });
    if (supers <= 1) throw badRequest('Cannot remove the last active super admin');
  }
  await audit(req.auth!.admin.id, 'admin.delete', 'administrator', id, { email: target.email, role: target.role });
  await prisma.administrator.delete({ where: { id } });
  res.json({ ok: true });
});

/** Issues a one-time password reset token for another administrator (shown once). */
adminRouter.post('/admins/:id/reset-token', requireRole(...SUPER), async (req, res) => {
  const id = req.params.id as string;
  if (!(await prisma.administrator.findUnique({ where: { id } }))) throw notFound();
  const token = await issueResetToken(id);
  await audit(req.auth!.admin.id, 'admin.reset_token_issued', 'administrator', id);
  res.json({ token, expiresInMinutes: 60 });
});

adminRouter.get('/audit', async (req, res) => {
  const q = z
    .object({ action: z.string().max(100).optional(), skip: z.coerce.number().int().min(0).default(0), take: z.coerce.number().int().min(1).max(200).default(50) })
    .parse(req.query);
  const where = q.action ? { action: { startsWith: q.action } } : {};
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: q.skip, take: q.take, include: { administrator: { select: { email: true } } } }),
    prisma.auditLog.count({ where }),
  ]);
  res.json({ items, total });
});

adminRouter.get('/health', async (req, res) => {
  const checks = await integrationHealth(req.query.refresh === '1' && req.auth!.admin.role === 'SUPER_ADMIN');
  res.json({ ok: checks.every((c) => c.ok), checks });
});

/** Provider configuration and system status. Secrets are never returned in full. */
adminRouter.get('/system', async (_req, res) => {
  let dbOk = false;
  let migrations: { migration_name: string; finished_at: Date | null }[] = [];
  try {
    migrations = await prisma.$queryRaw`SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at`;
    dbOk = true;
  } catch {
    dbOk = false;
  }
  res.json({
    database: { ok: dbOk, migrations },
    ai: {
      provider: env.AI_PROVIDER,
      answerModel: env.AI_PROVIDER === 'groq' ? env.GROQ_ANSWER_MODEL : 'mock',
      fastModel: env.AI_PROVIDER === 'groq' ? env.GROQ_FAST_MODEL : 'mock',
      apiKey: maskSecret(env.GROQ_API_KEY),
    },
    backups: {
      note: 'Backups run outside the app (see docs/DEPLOYMENT.md). Last backup marker:',
      lastBackupAt: process.env.LAST_BACKUP_AT ?? null,
    },
    nodeEnv: env.NODE_ENV,
  });
});

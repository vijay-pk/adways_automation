import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { Channel, EnrollmentStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { requireRole, CAN_REVIEW, SUPER } from '../auth/middleware.js';
import { parseBody } from '../lib/validate.js';
import { audit } from '../audit/auditService.js';
import { notFound } from '../lib/errors.js';
import { hashPassword } from '../auth/password.js';
import { randomToken } from '../lib/crypto.js';
import { deleteStudentData, exportCsv, importCsv } from './service.js';

export const studentRouter = Router();
export const groupRouter = Router();

studentRouter.get('/', async (req, res) => {
  const q = z
    .object({
      q: z.string().max(100).optional(),
      status: z.nativeEnum(EnrollmentStatus).optional(),
      skip: z.coerce.number().int().min(0).default(0),
      take: z.coerce.number().int().min(1).max(200).default(50),
    })
    .parse(req.query);
  const where = {
    ...(q.status ? { enrollmentStatus: q.status } : {}),
    ...(q.q
      ? {
          OR: [
            { displayName: { contains: q.q, mode: 'insensitive' as const } },
            { platformUserId: { contains: q.q } },
            { normalizedPhone: { contains: q.q } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.student.findMany({ where, orderBy: { createdAt: 'desc' }, skip: q.skip, take: q.take, omit: { webAccessCodeHash: true } }),
    prisma.student.count({ where }),
  ]);
  const since = new Date(Date.now() - 86_400_000);
  const usage = await prisma.responseJob.groupBy({
    by: ['senderExternalId'],
    where: { senderExternalId: { in: items.map((s) => s.platformUserId) }, createdAt: { gte: since } },
    _count: true,
  });
  const usageMap = new Map(usage.map((u) => [u.senderExternalId, u._count]));
  res.json({ items: items.map((s) => ({ ...s, questionsLast24h: usageMap.get(s.platformUserId) ?? 0 })), total });
});

studentRouter.post('/', requireRole(...CAN_REVIEW), async (req, res) => {
  const body = parseBody(
    z.object({
      channel: z.nativeEnum(Channel).default('MOCK'),
      platformUserId: z.string().min(3).max(100),
      displayName: z.string().max(100).optional(),
      phone: z.string().max(30).optional(),
      enrollmentStatus: z.nativeEnum(EnrollmentStatus).default('ACTIVE'),
    }),
    req.body,
  );
  const s = await prisma.student.create({
    data: {
      channel: body.channel,
      platformUserId: body.platformUserId,
      displayName: body.displayName,
      normalizedPhone: body.phone?.replace(/[^\d+]/g, ''),
      enrollmentStatus: body.enrollmentStatus,
    },
    omit: { webAccessCodeHash: true },
  });
  await audit(req.auth!.admin.id, 'student.create', 'student', s.id);
  res.status(201).json(s);
});

studentRouter.patch('/:id', requireRole(...CAN_REVIEW), async (req, res) => {
  const body = parseBody(
    z.object({
      displayName: z.string().max(100).nullable().optional(),
      enrollmentStatus: z.nativeEnum(EnrollmentStatus).optional(),
      dailyLimitOverride: z.number().int().min(0).max(1000).nullable().optional(),
      phone: z.string().max(30).nullable().optional(),
    }),
    req.body,
  );
  const { phone, ...rest } = body;
  const s = await prisma.student.update({
    where: { id: req.params.id as string },
    data: { ...rest, ...(phone !== undefined ? { normalizedPhone: phone ? phone.replace(/[^\d+]/g, '') : null } : {}) },
    omit: { webAccessCodeHash: true },
  });
  await audit(req.auth!.admin.id, 'student.update', 'student', s.id, { fields: Object.keys(body) });
  res.json(s);
});

/** Issues a website-chat access code; shown once, stored hashed. */
studentRouter.post('/:id/web-access-code', requireRole(...CAN_REVIEW), async (req, res) => {
  const s = await prisma.student.findUnique({ where: { id: req.params.id as string } });
  if (!s) throw notFound();
  const code = randomToken(6).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
  await prisma.student.update({ where: { id: s.id }, data: { webAccessCodeHash: await hashPassword(code) } });
  await audit(req.auth!.admin.id, 'student.web_code_issued', 'student', s.id);
  res.json({ code, phone: s.normalizedPhone });
});

studentRouter.delete('/:id/data', requireRole(...SUPER), async (req, res) => {
  const result = await deleteStudentData(req.params.id as string);
  await audit(req.auth!.admin.id, 'student.delete_data', 'student', req.params.id as string, result);
  res.json(result);
});

studentRouter.get('/export.csv', async (_req, res) => {
  res.type('text/csv').attachment('students.csv').send(await exportCsv());
});

studentRouter.post('/import', requireRole(...CAN_REVIEW), express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }), async (req, res) => {
  const result = await importCsv(String(req.body ?? ''));
  await audit(req.auth!.admin.id, 'student.import', 'student', undefined, { created: result.created, updated: result.updated });
  res.json(result);
});

// ---- Groups (allowlist) ----

groupRouter.get('/', async (_req, res) => {
  res.json({ items: await prisma.group.findMany({ orderBy: { createdAt: 'desc' } }) });
});

groupRouter.post('/', requireRole(...SUPER), async (req, res) => {
  const body = parseBody(
    z.object({ channel: z.nativeEnum(Channel), externalChatId: z.string().min(3).max(200), name: z.string().max(200).optional(), enabled: z.boolean().default(true) }),
    req.body,
  );
  const g = await prisma.group.upsert({
    where: { channel_externalChatId: { channel: body.channel, externalChatId: body.externalChatId } },
    create: body,
    update: { name: body.name, enabled: body.enabled },
  });
  await audit(req.auth!.admin.id, 'group.upsert', 'group', g.id, { enabled: g.enabled });
  res.status(201).json(g);
});

groupRouter.patch('/:id', requireRole(...SUPER), async (req, res) => {
  const body = parseBody(z.object({ enabled: z.boolean().optional(), name: z.string().max(200).optional() }), req.body);
  const g = await prisma.group.update({ where: { id: req.params.id as string }, data: body });
  await audit(req.auth!.admin.id, 'group.update', 'group', g.id, body);
  res.json(g);
});

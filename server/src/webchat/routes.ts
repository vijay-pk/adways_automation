import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { env, isProd } from '../config/env.js';
import { parseBody } from '../lib/validate.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { safeEqual } from '../lib/crypto.js';
import { dummyVerify, verifyPassword } from '../auth/password.js';
import { getSettings } from '../settings/settingsService.js';
import { ingestMessage } from '../messaging/ingest.js';
import { randomUUID } from 'node:crypto';

/**
 * Website chat fallback for enrolled students (used when a WhatsApp feature is unavailable).
 * Students sign in with their phone number and an admin-issued access code.
 */
export const webChatRouter = Router();
const COOKIE = 'tutor_student';
const TTL_MS = 7 * 86_400_000;

const sign = (payload: string) => createHmac('sha256', `webchat:${env.SESSION_SECRET}`).update(payload).digest('base64url');

function issueToken(studentId: string) {
  const payload = `${studentId}.${Date.now() + TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

function readToken(token?: string): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  if (!safeEqual(sig, sign(`${id}.${exp}`)) || Number(exp) < Date.now()) return null;
  return id;
}

async function requireStudent(req: Request, _res: Response, next: NextFunction) {
  const settings = await getSettings();
  if (!settings.web_chat_enabled) return next(forbidden('Website chat is disabled'));
  // Simple CSRF defence: custom header can't be sent cross-site without CORS approval.
  if (req.method !== 'GET' && req.get('x-requested-with') !== 'tutor-web') return next(forbidden('Missing request header'));
  const id = readToken(req.cookies?.[COOKIE]);
  if (!id) return next(unauthorized());
  const student = await prisma.student.findUnique({ where: { id } });
  if (!student || student.enrollmentStatus !== 'ACTIVE') return next(unauthorized('Access not active'));
  res_locals.set(req, student.id);
  next();
}
const res_locals = new WeakMap<Request, string>();

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: env.NODE_ENV === 'test' ? 1000 : 10, standardHeaders: 'draft-7', legacyHeaders: false });

webChatRouter.post('/login', loginLimiter, async (req, res) => {
  const settings = await getSettings();
  if (!settings.web_chat_enabled) throw forbidden('Website chat is disabled');
  const body = parseBody(z.object({ phone: z.string().min(5).max(30), code: z.string().min(4).max(20) }), req.body);
  const phone = body.phone.replace(/[^\d+]/g, '');
  const candidates = await prisma.student.findMany({
    where: { normalizedPhone: phone, enrollmentStatus: 'ACTIVE', webAccessCodeHash: { not: null } },
  });
  let match = null;
  for (const s of candidates) if (await verifyPassword(s.webAccessCodeHash!, body.code.trim().toUpperCase())) match = s;
  if (!match) {
    if (!candidates.length) await dummyVerify(body.code);
    throw unauthorized('Invalid phone number or access code');
  }
  res.cookie(COOKIE, issueToken(match.id), { httpOnly: true, secure: isProd, sameSite: 'strict', maxAge: TTL_MS, path: '/api/chat' });
  res.json({ displayName: match.displayName });
});

webChatRouter.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE, { path: '/api/chat' });
  res.json({ ok: true });
});

webChatRouter.get('/messages', requireStudent, async (req, res) => {
  const studentId = res_locals.get(req)!;
  const conversation = await prisma.conversation.findUnique({
    where: { channel_externalChatId: { channel: 'WEB', externalChatId: `web:${studentId}` } },
  });
  if (!conversation) return res.json({ messages: [] });
  const [incoming, answers] = await Promise.all([
    prisma.incomingMessage.findMany({
      where: { conversationId: conversation.id, content: { not: null } },
      orderBy: { timestamp: 'desc' },
      take: 50,
      select: { id: true, content: true, timestamp: true },
    }),
    prisma.responseJob.findMany({
      where: { conversationId: conversation.id, status: 'SENT' },
      orderBy: { sentAt: 'desc' },
      take: 50,
      select: { id: true, approvedAnswer: true, sentAt: true },
    }),
  ]);
  const pending = await prisma.responseJob.count({
    where: { conversationId: conversation.id, status: { in: ['GENERATING', 'PENDING_APPROVAL', 'APPROVED', 'SENDING'] } },
  });
  const messages = [
    ...incoming.map((m) => ({ id: m.id, from: 'student' as const, text: m.content!, at: m.timestamp })),
    ...answers.map((a) => ({ id: a.id, from: 'tutor' as const, text: a.approvedAnswer ?? '', at: a.sentAt! })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  res.json({ messages, pending: pending > 0 });
});

webChatRouter.post('/messages', requireStudent, async (req, res) => {
  const studentId = res_locals.get(req)!;
  const { text } = parseBody(z.object({ text: z.string().min(1).max(2000) }), req.body);
  const outcome = await ingestMessage(
    {
      channel: 'WEB',
      externalMessageId: `web-in-${randomUUID()}`,
      chatId: `web:${studentId}`,
      chatType: 'PRIVATE',
      senderId: `web:${studentId}`,
      text,
      timestamp: new Date(),
      fromMe: false,
      mentionedIds: [],
      knownStudentId: studentId,
    },
    { botId: 'tutor@web', supportsNativeMentions: false },
  );
  res.status(outcome === 'queued' ? 202 : 200).json({ outcome });
});

import type { Response } from 'express';
import { prisma } from '../db/prisma.js';
import { env, isProd } from '../config/env.js';
import { randomToken, sha256 } from '../lib/crypto.js';

export const SESSION_COOKIE = 'tutor_sid';

export async function createSession(adminId: string, opts: { totpPending: boolean; ip?: string; userAgent?: string }) {
  const token = randomToken();
  const csrfToken = randomToken(24);
  const session = await prisma.adminSession.create({
    data: {
      tokenHash: sha256(token),
      csrfToken,
      adminId,
      totpPending: opts.totpPending,
      ip: opts.ip,
      userAgent: opts.userAgent?.slice(0, 300),
      expiresAt: new Date(Date.now() + env.SESSION_TTL_HOURS * 3600_000),
    },
  });
  return { token, session };
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: env.SESSION_TTL_HOURS * 3600_000,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function findSession(token: string) {
  const session = await prisma.adminSession.findUnique({
    where: { tokenHash: sha256(token) },
    include: { admin: true },
  });
  if (!session) return null;
  if (session.expiresAt < new Date() || !session.admin.isActive) {
    await prisma.adminSession.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  // Sliding idle expiry.
  const now = Date.now();
  if (now - session.lastSeenAt.getTime() > 60_000) {
    await prisma.adminSession.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date(now), expiresAt: new Date(now + env.SESSION_TTL_HOURS * 3600_000) },
    });
  }
  return session;
}

export const destroySession = (id: string) => prisma.adminSession.deleteMany({ where: { id } });
export const destroyAllSessions = (adminId: string, exceptId?: string) =>
  prisma.adminSession.deleteMany({ where: { adminId, ...(exceptId ? { NOT: { id: exceptId } } : {}) } });

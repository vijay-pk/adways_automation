import type { Administrator } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { dummyVerify, hashPassword, passwordPolicy, verifyPassword } from './password.js';
import { badRequest, HttpError, unauthorized } from '../lib/errors.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { audit } from '../audit/auditService.js';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

export async function authenticate(email: string, password: string): Promise<Administrator> {
  const admin = await prisma.administrator.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!admin || !admin.isActive) {
    await dummyVerify(password);
    throw unauthorized('Invalid email or password');
  }
  if (admin.lockedUntil && admin.lockedUntil > new Date()) {
    throw new HttpError(429, 'Account temporarily locked after repeated failed logins', 'locked');
  }
  const ok = await verifyPassword(admin.passwordHash, password);
  if (!ok) {
    const failed = admin.failedLogins + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await prisma.administrator.update({
      where: { id: admin.id },
      data: {
        failedLogins: lock ? 0 : failed,
        lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : admin.lockedUntil,
      },
    });
    await audit(admin.id, lock ? 'auth.lockout' : 'auth.login_failed', 'administrator', admin.id);
    throw unauthorized('Invalid email or password');
  }
  return prisma.administrator.update({
    where: { id: admin.id },
    data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
}

export async function changePassword(admin: Administrator, current: string, next: string) {
  if (!(await verifyPassword(admin.passwordHash, current))) throw badRequest('Current password is incorrect');
  const parsed = passwordPolicy.safeParse(next);
  if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
  if (current === next) throw badRequest('New password must differ from the current password');
  await prisma.administrator.update({
    where: { id: admin.id },
    data: { passwordHash: await hashPassword(next), mustChangePassword: false },
  });
}

/** Issues a one-time reset token (shown once to a super admin or printed by CLI). */
export async function issueResetToken(adminId: string, ttlMinutes = 60) {
  const token = randomToken();
  await prisma.passwordResetToken.create({
    data: { adminId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMinutes * 60_000) },
  });
  return token;
}

export async function resetPasswordWithToken(token: string, newPassword: string) {
  const parsed = passwordPolicy.safeParse(newPassword);
  if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction(async (tx) => {
    const row = await tx.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.usedAt || row.expiresAt < new Date()) throw badRequest('Invalid or expired reset token');
    const used = await tx.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (used.count !== 1) throw badRequest('Invalid or expired reset token');
    await tx.administrator.update({
      where: { id: row.adminId },
      data: { passwordHash, mustChangePassword: false, failedLogins: 0, lockedUntil: null },
    });
    await tx.adminSession.deleteMany({ where: { adminId: row.adminId } });
    await audit(row.adminId, 'auth.password_reset', 'administrator', row.adminId, undefined, tx);
  });
}

/** Creates the initial super admin only when no administrator exists. */
export async function bootstrapInitialAdmin(email: string | undefined, password: string | undefined) {
  if (!email || !password) throw new Error('INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD must be set');
  const count = await prisma.administrator.count();
  if (count > 0) return { created: false as const };
  const parsed = passwordPolicy.safeParse(password);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const admin = await prisma.administrator.create({
    data: {
      email: email.trim().toLowerCase(),
      passwordHash: await hashPassword(password),
      role: 'SUPER_ADMIN',
      mustChangePassword: true,
    },
  });
  await audit(admin.id, 'admin.bootstrap', 'administrator', admin.id);
  return { created: true as const, admin };
}

export const publicAdmin = (a: Administrator) => ({
  id: a.id,
  email: a.email,
  role: a.role,
  mustChangePassword: a.mustChangePassword,
  totpEnabled: a.totpEnabled,
  isActive: a.isActive,
  createdAt: a.createdAt,
  lastLoginAt: a.lastLoginAt,
});

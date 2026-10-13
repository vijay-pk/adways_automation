import type { NextFunction, Request, Response } from 'express';
import type { AdminRole, Administrator, AdminSession } from '@prisma/client';
import { findSession, SESSION_COOKIE } from './sessions.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { safeEqual } from '../lib/crypto.js';

export interface AuthContext {
  admin: Administrator;
  session: AdminSession;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Loads the session. Options allow the few routes needed while a password change
 * or TOTP verification is still outstanding.
 */
export function requireAuth(opts: { allowPasswordChange?: boolean; allowTotpPending?: boolean } = {}) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return next(unauthorized());
    const session = await findSession(token);
    if (!session) return next(unauthorized('Session expired'));
    if (session.totpPending && !opts.allowTotpPending) return next(unauthorized('Two-factor verification required'));
    if (session.admin.mustChangePassword && !opts.allowPasswordChange) {
      return next(forbidden('Password change required'));
    }
    if (!SAFE_METHODS.has(req.method)) {
      const header = req.get('x-csrf-token') ?? '';
      if (!header || !safeEqual(header, session.csrfToken)) return next(forbidden('Invalid CSRF token'));
    }
    const { admin, ...rest } = session;
    req.auth = { admin, session: rest as AdminSession };
    next();
  };
}

export function requireRole(...roles: AdminRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.admin.role)) return next(forbidden('Insufficient role'));
    next();
  };
}

export const CAN_REVIEW: AdminRole[] = ['SUPER_ADMIN', 'REVIEWER'];
export const SUPER: AdminRole[] = ['SUPER_ADMIN'];

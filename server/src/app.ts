import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import multer from 'multer';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { HttpError } from './lib/errors.js';
import { requireAuth } from './auth/middleware.js';
import { authRouter } from './auth/routes.js';
import { adminRouter } from './admin/routes.js';
import { settingsRouter } from './settings/routes.js';
import { transcriptRouter } from './transcripts/routes.js';
import { responseRouter } from './responses/routes.js';
import { memoryRouter } from './memory/routes.js';
import { groupRouter, studentRouter } from './students/routes.js';
import { dashboardRouter } from './dashboard/routes.js';
import { webChatRouter } from './webchat/routes.js';
import { devRouter } from './messaging/devRoutes.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: env.NODE_ENV === 'production' ? undefined : false }));
  if (env.NODE_ENV !== 'test') {
    app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));
  }
  // Pasted transcripts use their own larger JSON limit (see transcripts/routes.ts).
  const json = express.json({ limit: '1mb' });
  app.use((req, res, next) => (req.path === '/api/transcripts/text' ? next() : json(req, res, next)));
  app.use(cookieParser());
  // Hard per-request timeout so a hung dependency cannot pin a connection forever.
  app.use((_req, res, next) => {
    res.setTimeout(120_000, () => {
      if (!res.headersSent) res.status(503).json({ error: 'Request timed out' });
    });
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api/auth', authRouter);
  app.use('/api/chat', webChatRouter);

  const authed = requireAuth();
  app.use('/api/dashboard', authed, dashboardRouter);
  app.use('/api/settings', authed, settingsRouter);
  app.use('/api/transcripts', authed, transcriptRouter);
  app.use('/api/responses', authed, responseRouter);
  app.use('/api/memory', authed, memoryRouter);
  app.use('/api/students', authed, studentRouter);
  app.use('/api/groups', authed, groupRouter);
  app.use('/api/admin', authed, adminRouter);
  if (env.ENABLE_DEV_ROUTES) app.use('/api/dev', authed, devRouter);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Optionally serve the built admin dashboard from the same origin.
  if (env.SERVE_WEB_DIST) {
    const dist = resolve(env.SERVE_WEB_DIST);
    if (existsSync(dist)) {
      app.use(express.static(dist, { index: false, maxAge: '1h' }));
      app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(resolve(dist, 'index.html')));
    }
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err instanceof ZodError) {
      return res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
    const code = typeof err === 'object' && err && 'code' in err ? (err as { code: unknown }).code : undefined;
    if (code === 'P2025') return res.status(404).json({ error: 'Not found' });
    const type = typeof err === 'object' && err && 'type' in err ? (err as { type: unknown }).type : undefined;
    if (type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    logger.error({ err, url: req.url }, 'unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

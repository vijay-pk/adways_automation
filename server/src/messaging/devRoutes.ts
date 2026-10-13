import { Router } from 'express';
import { z } from 'zod';
import { requireRole, SUPER } from '../auth/middleware.js';
import { parseBody } from '../lib/validate.js';
import { badRequest } from '../lib/errors.js';
import { getActiveAdapter, getMockAdapter } from './registry.js';
import { runDueJobs } from '../jobs/worker.js';

/**
 * Development-only routes for driving the mock adapter from the dashboard.
 * Mounted only when ENABLE_DEV_ROUTES=true (refused in production by env validation).
 */
export const devRouter = Router();
devRouter.use(requireRole(...SUPER));

devRouter.post('/mock/inbound', async (req, res) => {
  if (getActiveAdapter()?.name !== 'mock') throw badRequest('Mock adapter is not active');
  const body = parseBody(
    z.object({
      chatId: z.string().min(1).max(100),
      chatType: z.enum(['GROUP', 'PRIVATE']),
      senderId: z.string().min(1).max(100),
      senderName: z.string().max(100).optional(),
      text: z.string().min(1).max(4000),
      mentionBot: z.boolean().default(false),
      chatName: z.string().max(100).optional(),
    }),
    req.body,
  );
  const mock = getMockAdapter();
  const msg = await mock.simulateInbound({
    chatId: body.chatId,
    chatType: body.chatType,
    chatName: body.chatName,
    senderId: body.senderId,
    senderName: body.senderName,
    text: body.text,
    mentionedIds: body.mentionBot ? [mock.botId()] : [],
  });
  res.json({ externalMessageId: msg.externalMessageId });
});

devRouter.get('/mock/outbox', (_req, res) => {
  res.json({ items: getMockAdapter().outbox.slice(-50).reverse() });
});

devRouter.post('/jobs/run', async (_req, res) => {
  res.json({ processed: await runDueJobs(50) });
});

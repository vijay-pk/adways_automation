import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { getSettings } from '../settings/settingsService.js';
import { adapterOverview } from '../messaging/registry.js';
import { spentTodayUsd } from '../ai/index.js';

export const dashboardRouter = Router();

dashboardRouter.get('/', async (_req, res) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const monthAgo = new Date(Date.now() - 30 * 86_400_000);
  const [settings, messaging, pending, processedToday, sentToday, failed, spendToday, spend30, recent, queueFailed] =
    await Promise.all([
      getSettings(),
      adapterOverview(),
      prisma.responseJob.count({ where: { status: 'PENDING_APPROVAL' } }),
      prisma.incomingMessage.count({ where: { createdAt: { gte: start } } }),
      prisma.responseJob.count({ where: { status: 'SENT', sentAt: { gte: start } } }),
      prisma.responseJob.count({ where: { status: 'FAILED' } }),
      spentTodayUsd(),
      prisma.aiUsage.aggregate({ _sum: { estimatedCost: true, inputTokens: true, outputTokens: true }, where: { createdAt: { gte: monthAgo } } }),
      prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 10, include: { administrator: { select: { email: true } } } }),
      prisma.job.count({ where: { status: 'FAILED' } }),
    ]);
  res.json({
    messaging,
    replyMode: {
      autoReplyEnabled: settings.auto_reply_enabled,
      pauseAllOutgoing: settings.pause_all_outgoing,
      pauseGroupReplies: settings.pause_group_replies,
      pausePrivateReplies: settings.pause_private_replies,
      connectionEnabled: settings.messaging_connection_enabled,
    },
    counts: { pendingApprovals: pending, messagesToday: processedToday, answersSentToday: sentToday, failedResponses: failed, failedQueueJobs: queueFailed },
    ai: {
      spendTodayUsd: spendToday,
      dailyBudgetUsd: settings.daily_ai_budget_usd,
      spend30dUsd: Number(spend30._sum.estimatedCost ?? 0),
      tokens30d: (spend30._sum.inputTokens ?? 0) + (spend30._sum.outputTokens ?? 0),
    },
    recentActivity: recent,
  });
});

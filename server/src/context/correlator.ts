import type { ChatType, IncomingMessage } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import type { Settings } from '../settings/settingsService.js';
import type { PriorExchange } from '../ai/types.js';

/**
 * Candidate context for one question: unconsumed incoming messages from the SAME sender
 * in the SAME chat inside the configured time window. Messages from other students and
 * the tutor's own messages are never included (they are filtered by the query itself).
 *
 * Groups: only messages up to the latest invoking message (the mention).
 * Private chats: every message in the debounce burst, up to now.
 */
export async function collectCandidates(params: {
  conversationId: string;
  senderExternalId: string;
  chatType: ChatType;
  trigger: IncomingMessage;
  settings: Settings;
}): Promise<IncomingMessage[]> {
  const { conversationId, senderExternalId, chatType, trigger, settings } = params;
  const windowStart = new Date(trigger.timestamp.getTime() - settings.context_window_minutes * 60_000);
  const upper = chatType === 'GROUP' ? trigger.timestamp : new Date(Math.max(Date.now(), trigger.timestamp.getTime()));

  const rows = await prisma.incomingMessage.findMany({
    where: {
      conversationId,
      senderExternalId,
      consumedByJobId: null,
      content: { not: null },
      timestamp: { gte: windowStart, lte: upper },
      processingStatus: { in: ['CONTEXT_ONLY', 'QUEUED', 'RECEIVED'] },
    },
    orderBy: { timestamp: 'desc' },
    take: settings.context_max_messages,
  });
  // Always keep the trigger even if the max-messages cap would drop it.
  if (!rows.some((r) => r.id === trigger.id) && !trigger.consumedByJobId) rows.unshift(trigger);
  return rows.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

/**
 * Most recent answered exchange with this sender in this chat within the follow-up window.
 * Used so "Why?" or "another example" can refer to the previous tutor answer.
 */
export async function findPriorExchange(params: {
  conversationId: string;
  senderExternalId: string;
  before: Date;
  settings: Settings;
}): Promise<PriorExchange | null> {
  const since = new Date(params.before.getTime() - params.settings.followup_window_minutes * 60_000);
  const job = await prisma.responseJob.findFirst({
    where: {
      conversationId: params.conversationId,
      senderExternalId: params.senderExternalId,
      status: { in: ['SENT', 'APPROVED', 'SENDING'] },
      approvedAt: { gte: since },
      approvedAnswer: { not: null },
    },
    orderBy: { approvedAt: 'desc' },
  });
  if (!job?.approvedAnswer) return null;
  return {
    jobId: job.id,
    question: job.normalizedQuestion ?? '',
    answer: job.approvedAnswer,
    at: job.approvedAt ?? job.createdAt,
  };
}

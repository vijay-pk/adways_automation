import type { Job } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { getSettings } from '../settings/settingsService.js';
import { getSenderForChannel } from '../messaging/registry.js';
import { DeferError } from '../jobs/worker.js';
import { logger } from '../lib/logger.js';

const PAUSE_RECHECK_MS = 30_000;

/**
 * Sends one approved response. Emergency pauses are checked at send time, so a pause
 * stops messages that were approved earlier but not yet sent.
 */
export async function deliverResponse(queueJob: Job) {
  const { responseJobId } = queueJob.payload as { responseJobId: string };
  const job = await prisma.responseJob.findUnique({
    where: { id: responseJobId },
    include: { conversation: true, delivery: true },
  });
  if (!job || !job.delivery) return;
  if (job.status !== 'APPROVED' || job.delivery.status === 'SENT') return; // nothing to do (idempotent)
  if (!job.approvedAnswer) throw new Error('Approved answer missing');

  const settings = await getSettings();
  const isGroup = job.conversation.chatType === 'GROUP';
  if (settings.pause_all_outgoing || (isGroup ? settings.pause_group_replies : settings.pause_private_replies)) {
    throw new DeferError(PAUSE_RECHECK_MS, 'Outgoing messages paused by emergency control');
  }

  const adapter = getSenderForChannel(job.conversation.channel);
  if (!adapter) {
    return markFailed(job.id, job.delivery.id, `No connected adapter for channel ${job.conversation.channel}`, true);
  }
  const canSend = isGroup ? adapter.capabilities.sendGroupMessages : adapter.capabilities.sendPrivateMessages;
  if (!canSend) {
    return markFailed(job.id, job.delivery.id, `Adapter ${adapter.name} cannot send ${isGroup ? 'group' : 'private'} messages`, true);
  }

  // Claim: APPROVED -> SENDING. A concurrent worker gets count 0 and stops.
  const claimed = await prisma.responseJob.updateMany({ where: { id: job.id, status: 'APPROVED' }, data: { status: 'SENDING' } });
  if (claimed.count !== 1) return;
  await prisma.messageDelivery.update({
    where: { id: job.delivery.id },
    data: { status: 'SENDING', attempts: { increment: 1 } },
  });

  const trigger = job.triggeringMessageId
    ? await prisma.incomingMessage.findUnique({ where: { id: job.triggeringMessageId } })
    : null;

  try {
    const result = await adapter.sendMessage(
      {
        channel: job.conversation.channel,
        chatId: job.conversation.externalChatId,
        chatType: job.conversation.chatType,
        replyToMessageId: trigger?.externalMessageId,
        mentionIds: isGroup ? [job.senderExternalId] : undefined,
      },
      job.approvedAnswer,
    );
    const now = new Date();
    await prisma.$transaction([
      prisma.messageDelivery.update({
        where: { id: job.delivery.id },
        data: { status: 'SENT', externalMessageId: result.externalMessageId, sentAt: now, lastError: null },
      }),
      prisma.responseJob.update({ where: { id: job.id }, data: { status: 'SENT', sentAt: now, lastError: null } }),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const final = queueJob.attempts >= queueJob.maxAttempts;
    logger.warn({ responseJobId: job.id, attempt: queueJob.attempts, final, err: message }, 'delivery failed');
    await markFailed(job.id, job.delivery.id, message, final);
    if (!final) throw err; // queue retries with exponential backoff
  }
}

async function markFailed(jobId: string, deliveryId: string, error: string, final: boolean) {
  await prisma.$transaction([
    prisma.messageDelivery.update({ where: { id: deliveryId }, data: { status: final ? 'FAILED' : 'QUEUED', lastError: error } }),
    // Non-final failures return to APPROVED so the retry can claim it again.
    prisma.responseJob.update({ where: { id: jobId }, data: { status: final ? 'FAILED' : 'APPROVED', lastError: error } }),
  ]);
}

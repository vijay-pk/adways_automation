import type { Job } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { getSettings } from '../../settings/settingsService.js';
import { collectCandidates, findPriorExchange } from '../../context/correlator.js';
import { buildDraft } from '../../responses/draftService.js';
import { routeAfterDraft } from '../../responses/approvalService.js';
import { logger } from '../../lib/logger.js';

interface Payload {
  conversationId: string;
  senderExternalId: string;
  triggerMessageId: string;
}

/**
 * Turns one debounced burst of messages into exactly one response job.
 * Messages are claimed (consumed_by_job_id) in the same transaction that creates the
 * response job, so the same question is never answered twice.
 */
export async function processQuestion(queueJob: Job) {
  const p = queueJob.payload as unknown as Payload;
  const settings = await getSettings();
  const conversation = await prisma.conversation.findUnique({ where: { id: p.conversationId } });
  const trigger = await prisma.incomingMessage.findUnique({ where: { id: p.triggerMessageId } });
  if (!conversation || !trigger || trigger.consumedByJobId) return;

  const candidates = await collectCandidates({
    conversationId: conversation.id,
    senderExternalId: p.senderExternalId,
    chatType: conversation.chatType,
    trigger,
    settings,
  });
  if (!candidates.length) return;
  const prior = await findPriorExchange({
    conversationId: conversation.id,
    senderExternalId: p.senderExternalId,
    before: trigger.timestamp,
    settings,
  });

  const responseJob = await prisma.$transaction(async (tx) => {
    const rj = await tx.responseJob.create({
      data: {
        conversationId: conversation.id,
        senderExternalId: p.senderExternalId,
        triggeringMessageId: trigger.id,
        contextMessageIds: candidates.map((c) => c.id),
        previousJobId: prior?.jobId,
        status: 'GENERATING',
      },
    });
    const claimed = await tx.incomingMessage.updateMany({
      where: { id: { in: candidates.map((c) => c.id) }, consumedByJobId: null },
      data: { consumedByJobId: rj.id, processingStatus: 'CONSUMED' },
    });
    if (claimed.count === 0) throw new AlreadyClaimed();
    const ids = await tx.incomingMessage.findMany({ where: { consumedByJobId: rj.id }, select: { id: true } });
    return tx.responseJob.update({ where: { id: rj.id }, data: { contextMessageIds: ids.map((i) => i.id) } });
  }).catch((err) => {
    if (err instanceof AlreadyClaimed) return null;
    throw err;
  });
  if (!responseJob) return;

  try {
    await buildDraft(responseJob.id, { initial: true });
    await routeAfterDraft(responseJob.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ responseJobId: responseJob.id, err: message }, 'draft generation failed');
    // Keep the job visible to admins; they can regenerate once the provider recovers.
    await prisma.responseJob.update({ where: { id: responseJob.id }, data: { status: 'FAILED', lastError: message } });
  }
}

class AlreadyClaimed extends Error {}

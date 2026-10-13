import { prisma, type Tx } from '../db/prisma.js';
import { getSettings } from '../settings/settingsService.js';
import { enqueue } from '../jobs/queue.js';
import { audit } from '../audit/auditService.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { buildDraft } from './draftService.js';
import { createExampleFromJob } from '../memory/approvedExamples.js';

/**
 * Approval state machine:
 *   GENERATING -> PENDING_APPROVAL -> APPROVED -> SENDING -> SENT
 *   terminal alternatives: REJECTED, CANCELLED, FAILED
 * Every transition is a conditional UPDATE on the expected current status, so
 * concurrent or repeated requests cannot double-approve or double-send.
 */

async function scheduleDelivery(tx: Tx, jobId: string) {
  await tx.messageDelivery.create({ data: { responseJobId: jobId, status: 'QUEUED' } });
  await enqueue('deliverMessage', { responseJobId: jobId }, { maxAttempts: 5 }, tx);
}

/** Called after the first draft is generated. Enforces the AI Reply Mode on the backend. */
export async function routeAfterDraft(jobId: string) {
  const settings = await getSettings();
  const job = await prisma.responseJob.findUniqueOrThrow({ where: { id: jobId }, include: { conversation: true } });
  if (job.status !== 'GENERATING') return job.status;

  const chatPaused = job.conversation.chatType === 'GROUP' ? settings.pause_group_replies : settings.pause_private_replies;
  const evidenceOk = job.evidenceSufficient === true || job.intent === 'needs_clarification';
  const auto = settings.auto_reply_enabled && !settings.pause_all_outgoing && !chatPaused && evidenceOk && !!job.draftAnswer;

  if (auto) {
    return prisma.$transaction(async (tx) => {
      const r = await tx.responseJob.updateMany({
        where: { id: jobId, status: 'GENERATING' },
        data: { status: 'APPROVED', autoApproved: true, approvedAnswer: job.draftAnswer, approvedAt: new Date() },
      });
      if (r.count !== 1) return 'CONFLICT' as const;
      await scheduleDelivery(tx, jobId);
      return 'APPROVED' as const;
    });
  }
  await prisma.responseJob.updateMany({ where: { id: jobId, status: 'GENERATING' }, data: { status: 'PENDING_APPROVAL' } });
  return 'PENDING_APPROVAL' as const;
}

export interface ApproveInput {
  editedAnswer?: string;
  reusable?: boolean;
  reviewerNotes?: string;
  topicTags?: string[];
  moduleName?: string;
}

export async function approveJob(jobId: string, adminId: string, input: ApproveInput) {
  return prisma.$transaction(async (tx) => {
    const job = await tx.responseJob.findUnique({ where: { id: jobId }, include: { conversation: true } });
    if (!job) throw notFound('Response job not found');
    const finalAnswer = (input.editedAnswer ?? job.draftAnswer ?? '').trim();
    if (!finalAnswer) throw badRequest('Approved answer cannot be empty');
    if (finalAnswer.length > 4000) throw badRequest('Approved answer is too long');

    const r = await tx.responseJob.updateMany({
      where: { id: jobId, status: 'PENDING_APPROVAL' },
      data: {
        status: 'APPROVED',
        approvedAnswer: finalAnswer,
        approvedById: adminId,
        approvedAt: new Date(),
        reviewerNotes: input.reviewerNotes,
      },
    });
    if (r.count !== 1) throw conflict(`Response is no longer pending approval (status: ${job.status})`);
    await scheduleDelivery(tx, jobId);
    const example = await createExampleFromJob(tx, job, finalAnswer, input);
    await audit(adminId, finalAnswer !== job.draftAnswer ? 'response.edit_approve' : 'response.approve', 'response_job', jobId,
      { exampleId: example.id, reusable: !!input.reusable }, tx);
    return { status: 'APPROVED' as const, exampleId: example.id };
  });
}

async function closeJob(jobId: string, adminId: string, to: 'REJECTED' | 'CANCELLED', action: string, notes?: string) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.responseJob.updateMany({
      where: { id: jobId, status: { in: ['PENDING_APPROVAL', 'FAILED'] } },
      data: { status: to, reviewerNotes: notes },
    });
    if (r.count !== 1) throw conflict('Response cannot be closed in its current state');
    await audit(adminId, action, 'response_job', jobId, notes ? { notes } : undefined, tx);
    return { status: to };
  });
}

export const rejectJob = (jobId: string, adminId: string, notes?: string) =>
  closeJob(jobId, adminId, 'REJECTED', 'response.reject', notes);

export const markReviewedWithoutSending = (jobId: string, adminId: string, notes?: string) =>
  closeJob(jobId, adminId, 'CANCELLED', 'response.mark_reviewed', notes);

/** Regenerates the draft (optionally with more evidence or reviewer guidance). Never sends. */
export async function regenerateJob(jobId: string, adminId: string, opts: { hint?: string; moreEvidence?: boolean }) {
  const job = await prisma.responseJob.findUnique({ where: { id: jobId } });
  if (!job) throw notFound('Response job not found');
  if (job.status === 'FAILED' && !job.approvedAt) {
    // Generation previously failed: move back to GENERATING so it can be re-drafted.
    await prisma.responseJob.updateMany({ where: { id: jobId, status: 'FAILED' }, data: { status: 'GENERATING' } });
  } else if (job.status !== 'PENDING_APPROVAL') {
    throw conflict('Only pending drafts can be regenerated');
  }
  await buildDraft(jobId, { adminHint: opts.hint, moreEvidence: opts.moreEvidence, reason: opts.moreEvidence ? 'more_evidence' : 'regenerate' });
  // A regenerated draft always waits for a human decision.
  await prisma.responseJob.updateMany({ where: { id: jobId, status: 'GENERATING' }, data: { status: 'PENDING_APPROVAL' } });
  await audit(adminId, opts.moreEvidence ? 'response.request_evidence' : 'response.regenerate', 'response_job', jobId, opts.hint ? { hint: opts.hint } : undefined);
  return prisma.responseJob.findUniqueOrThrow({ where: { id: jobId } });
}

/** Safe retry of a failed delivery: keeps the approval record and the single delivery row. */
export async function retryDelivery(jobId: string, adminId: string) {
  return prisma.$transaction(async (tx) => {
    const delivery = await tx.messageDelivery.findUnique({ where: { responseJobId: jobId } });
    if (!delivery) throw conflict('This response was never approved for delivery');
    if (delivery.status === 'SENT') throw conflict('Already sent');
    const r = await tx.responseJob.updateMany({
      where: { id: jobId, status: 'FAILED', approvedAt: { not: null } },
      data: { status: 'APPROVED', lastError: null },
    });
    if (r.count !== 1) throw conflict('Only failed deliveries can be retried');
    await tx.messageDelivery.update({ where: { id: delivery.id }, data: { status: 'QUEUED' } });
    await enqueue('deliverMessage', { responseJobId: jobId }, { maxAttempts: 5 }, tx);
    await audit(adminId, 'response.retry_delivery', 'response_job', jobId, undefined, tx);
    return { status: 'APPROVED' as const };
  });
}

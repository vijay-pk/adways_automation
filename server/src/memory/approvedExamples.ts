import type { Conversation, ResponseJob } from '@prisma/client';
import { prisma, type Tx } from '../db/prisma.js';
import type { ApproveInput } from '../responses/approvalService.js';
import { summarizeEdit } from './editDiff.js';

/** Strips the server-rendered "Sources:" footer so stored examples hold only the explanation. */
export const stripSourcesFooter = (s: string) => s.replace(/\n+Sources: [^\n]*$/s, '').trim();

/**
 * Saves an administrator-approved answer to Approved Answer Memory.
 * Kept separate from raw message logs (retention never deletes it). Only explicit
 * admin approvals create examples; auto-sent or rejected drafts never do.
 * `reusable` defaults to false (private to the original conversation) until an admin opts in.
 */
export async function createExampleFromJob(
  tx: Tx,
  job: ResponseJob & { conversation: Conversation },
  finalAnswer: string,
  input: ApproveInput,
) {
  const messages = await tx.incomingMessage.findMany({
    where: { id: { in: job.contextMessageIds } },
    orderBy: { timestamp: 'asc' },
    select: { id: true, content: true, timestamp: true },
  });
  const draft = job.draftAnswer ?? '';
  const wasEdited = draft.trim() !== finalAnswer.trim();
  const sources = (job.sourceRefs as { sources?: unknown[] } | null)?.sources ?? [];
  return tx.approvedAnswerExample.create({
    data: {
      responseJobId: job.id,
      originalQuestion: messages.map((m) => m.content ?? '').join('\n') || job.normalizedQuestion || '',
      contextSnapshot: messages.map((m) => ({ text: m.content, at: m.timestamp })) as never,
      normalizedQuestion: job.normalizedQuestion ?? '',
      approvedAnswer: stripSourcesFooter(finalAnswer),
      originalDraft: draft,
      wasEdited,
      editSummary: wasEdited ? (summarizeEdit(stripSourcesFooter(draft), stripSourcesFooter(finalAnswer)) as never) : undefined,
      reviewerNotes: input.reviewerNotes,
      transcriptSources: sources as never,
      moduleName: input.moduleName,
      topicTags: input.topicTags ?? [],
      language: 'en',
      channel: job.conversation.channel,
      reusable: input.reusable ?? false,
      enabled: true,
      qualityStatus: wasEdited ? 'corrected' : 'approved',
    },
  });
}

export async function listExamples(params: { q?: string; reusable?: boolean; enabled?: boolean; skip?: number; take?: number }) {
  const where = {
    ...(params.reusable !== undefined ? { reusable: params.reusable } : {}),
    ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
    ...(params.q
      ? {
          OR: [
            { normalizedQuestion: { contains: params.q, mode: 'insensitive' as const } },
            { approvedAnswer: { contains: params.q, mode: 'insensitive' as const } },
            { topicTags: { has: params.q.toLowerCase() } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.approvedAnswerExample.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: params.skip ?? 0, take: Math.min(params.take ?? 25, 100) }),
    prisma.approvedAnswerExample.count({ where }),
  ]);
  return { items, total };
}

/** Which response jobs (drafts) were influenced by a given example. */
export const jobsInfluencedBy = (exampleId: string) =>
  prisma.responseJob.findMany({
    where: { exampleIdsUsed: { has: exampleId } },
    select: { id: true, normalizedQuestion: true, status: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

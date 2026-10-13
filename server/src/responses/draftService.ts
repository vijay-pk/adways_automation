import { prisma } from '../db/prisma.js';
import { getSettings } from '../settings/settingsService.js';
import { getAI, recordUsage, spentTodayUsd } from '../ai/index.js';
import { searchTranscripts } from '../retrieval/transcriptSearch.js';
import { searchExamples } from '../retrieval/exampleSearch.js';
import { validateAnswer } from '../ai/validateAnswer.js';
import type { ContextMessage, PriorExchange } from '../ai/types.js';

export interface DraftOptions {
  initial?: boolean;
  adminHint?: string;
  moreEvidence?: boolean;
  reason?: string;
}

export class BudgetExceededError extends Error {}

/**
 * Correlates the job's messages into one question, retrieves transcript passages and
 * approved examples, generates and validates a draft, and stores it on the job.
 */
export async function buildDraft(jobId: string, opts: DraftOptions = {}) {
  const settings = await getSettings();
  const job = await prisma.responseJob.findUniqueOrThrow({ where: { id: jobId }, include: { conversation: true } });

  if (settings.daily_ai_budget_usd > 0 && (await spentTodayUsd()) >= settings.daily_ai_budget_usd) {
    throw new BudgetExceededError('Daily AI budget reached; raise the limit in Reply Settings or wait until tomorrow');
  }

  const rows = await prisma.incomingMessage.findMany({
    where: { id: { in: job.contextMessageIds } },
    orderBy: { timestamp: 'asc' },
  });
  const messages: ContextMessage[] = rows.map((m) => ({ id: m.id, text: m.content ?? '', timestamp: m.timestamp }));
  const prior = await loadPrior(job.previousJobId);
  const triggerId = job.triggeringMessageId ?? messages[messages.length - 1]?.id ?? '';
  const ai = getAI();

  const corr = await ai.correlate({ messages, triggerMessageId: triggerId, prior, botName: settings.bot_display_name });
  await recordUsage(corr.usage, 'correlate', job.id);

  const known = new Set(messages.map((m) => m.id));
  const relevant = new Set(corr.data.relevantMessageIds.filter((id) => known.has(id)));
  if (triggerId) relevant.add(triggerId);
  const relevantMessages = messages.filter((m) => relevant.has(m.id));

  if (opts.initial) {
    // Messages judged unrelated go back to plain context so they are not attributed to this answer.
    const irrelevant = messages.filter((m) => !relevant.has(m.id)).map((m) => m.id);
    if (irrelevant.length) {
      await prisma.incomingMessage.updateMany({
        where: { id: { in: irrelevant }, consumedByJobId: job.id },
        data: { consumedByJobId: null, processingStatus: 'CONTEXT_ONLY' },
      });
    }
  }

  const question = corr.data.normalizedQuestion.trim() || relevantMessages.map((m) => m.text).join(' ');
  const effectivePrior = corr.data.usesPrior ? prior : null;

  let text: string;
  let sources: unknown[] = [];
  let evidenceSufficient = false;
  let confidence = 0;
  let chunkIds: string[] = [];
  let exampleIds: string[] = [];
  let intent: string = corr.data.intent;
  let issues: string[] = [];

  if (corr.data.needsClarification) {
    intent = 'needs_clarification';
    text = corr.data.clarificationQuestion || 'Could you share a little more detail about your question?';
  } else {
    const k = settings.retrieval_top_k * (opts.moreEvidence ? 2 : 1);
    const passages = await searchTranscripts(question, corr.data.searchTerms, k, {
      minSimilarity: settings.semantic_min_similarity,
      responseJobId: job.id,
    });
    const examples = await searchExamples(question, corr.data.searchTerms, settings.example_top_k);
    const gen = await ai.generate({
      question,
      intent: corr.data.intent,
      contextMessages: relevantMessages,
      prior: effectivePrior,
      passages,
      examples,
      maxChars: settings.max_response_chars,
      language: corr.data.language,
      adminHint: opts.adminHint,
    });
    await recordUsage(gen.usage, 'answer', job.id);
    const v = validateAnswer(gen.data, passages, settings.max_response_chars);
    text = v.text;
    sources = v.sources;
    evidenceSufficient = v.evidenceSufficient;
    confidence = v.confidence;
    issues = v.issues;
    chunkIds = passages.map((p) => p.chunkId);
    exampleIds = examples.map((e) => e.exampleId);
  }

  await prisma.$transaction([
    prisma.responseJob.update({
      where: { id: job.id },
      data: {
        normalizedQuestion: question,
        intent,
        contextMessageIds: [...relevant],
        previousJobId: effectivePrior?.jobId ?? null,
        retrievedChunkIds: chunkIds,
        exampleIdsUsed: exampleIds,
        draftAnswer: text,
        sourceRefs: { sources, issues } as never,
        evidenceSufficient,
        confidence,
        lastError: null,
      },
    }),
    prisma.responseDraft.create({ data: { responseJobId: job.id, content: text, reason: opts.reason ?? 'initial' } }),
  ]);
  return { text, evidenceSufficient, intent };
}

async function loadPrior(previousJobId: string | null): Promise<PriorExchange | null> {
  if (!previousJobId) return null;
  const p = await prisma.responseJob.findUnique({ where: { id: previousJobId } });
  if (!p?.approvedAnswer) return null;
  return { jobId: p.id, question: p.normalizedQuestion ?? '', answer: p.approvedAnswer, at: p.approvedAt ?? p.createdAt };
}

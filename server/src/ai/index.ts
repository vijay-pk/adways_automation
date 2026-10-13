import { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma, type Db } from '../db/prisma.js';
import { GroqTutorAI } from './groq.js';
import { MockTutorAI } from './mock.js';
import type { TutorAI, Usage } from './types.js';

let instance: TutorAI | null = null;

export function getAI(): TutorAI {
  instance ??= env.AI_PROVIDER === 'groq' ? new GroqTutorAI() : new MockTutorAI();
  return instance;
}

/** Test hook. */
export const setAI = (ai: TutorAI) => {
  instance = ai;
};

export function estimateCost(usage: Usage): number {
  if (usage.provider === 'mock') return 0;
  if (usage.provider.startsWith('embedding:')) return (usage.inputTokens * env.EMBEDDING_PRICE_PER_M) / 1_000_000;
  return (usage.inputTokens * env.AI_PRICE_INPUT_PER_M + usage.outputTokens * env.AI_PRICE_OUTPUT_PER_M) / 1_000_000;
}

export async function recordUsage(usage: Usage, purpose: string, responseJobId: string | null, db: Db = prisma) {
  await db.aiUsage.create({
    data: {
      responseJobId,
      provider: usage.provider,
      model: usage.model,
      purpose,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCost: new Prisma.Decimal(estimateCost(usage).toFixed(6)),
    },
  });
}

export async function spentTodayUsd(): Promise<number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const agg = await prisma.aiUsage.aggregate({ _sum: { estimatedCost: true }, where: { createdAt: { gte: start } } });
  return Number(agg._sum.estimatedCost ?? 0);
}

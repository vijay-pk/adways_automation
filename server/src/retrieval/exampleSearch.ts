import { prisma } from '../db/prisma.js';
import { buildTsQuery, questionKey } from './query.js';
import type { ExampleRef } from '../ai/types.js';

interface Row {
  id: string;
  normalized_question: string;
  approved_answer: string;
  was_edited: boolean;
  updated_at: Date;
  rank: number;
}

/**
 * Retrieves reusable, enabled, admin-approved examples. When several examples answer
 * the same question, only the most recently approved one is kept so newer corrections
 * win over stale explanations.
 */
export async function searchExamples(question: string, searchTerms: string[], limit: number): Promise<ExampleRef[]> {
  if (limit <= 0) return [];
  const tsq = buildTsQuery(question, searchTerms);
  if (!tsq) return [];
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT e.id, e.normalized_question, e.approved_answer, e.was_edited, e.updated_at,
           ts_rank_cd(e.search_tsv, q, 1)::float8 AS rank
    FROM approved_answer_examples e, to_tsquery('english', ${tsq}) q
    WHERE e.reusable = true AND e.enabled = true AND e.search_tsv @@ q
    ORDER BY rank DESC, e.updated_at DESC
    LIMIT ${limit * 4}`;

  const byKey = new Map<string, Row>();
  for (const r of rows) {
    const key = questionKey(r.normalized_question);
    const existing = byKey.get(key);
    if (!existing || existing.updated_at < r.updated_at) byKey.set(key, r);
  }
  const top = [...byKey.values()]
    .sort((a, b) => b.rank - a.rank || b.updated_at.getTime() - a.updated_at.getTime())
    .slice(0, limit)
    // Present newest first to the model.
    .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
  return top.map((r, i) => ({
    ref: `E${i + 1}`,
    exampleId: r.id,
    question: r.normalized_question,
    answer: r.approved_answer,
    updatedAt: r.updated_at,
    wasEdited: r.was_edited,
  }));
}

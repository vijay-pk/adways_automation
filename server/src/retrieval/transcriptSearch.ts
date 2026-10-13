import { prisma } from '../db/prisma.js';
import { buildTsQuery } from './query.js';
import type { Passage } from '../ai/types.js';
import { embedAll, getEmbedder } from '../embeddings/index.js';
import { semanticSearch } from '../embeddings/vectorStore.js';
import { logger } from '../lib/logger.js';

interface Row {
  id: string;
  transcript_id: string;
  content: string;
  timestamp_start: string | null;
  timestamp_end: string | null;
  filename: string;
  module_name: string | null;
  lesson_title: string | null;
  rank: number;
}

export interface SearchOptions {
  moduleName?: string;
  /** Minimum cosine similarity for chunks found only by semantic search. */
  minSimilarity?: number;
  responseJobId?: string | null;
}

const RRF_K = 60;

async function fullText(question: string, searchTerms: string[], limit: number, moduleName?: string): Promise<Row[]> {
  const tsq = buildTsQuery(question, searchTerms);
  if (!tsq) return [];
  return prisma.$queryRaw<Row[]>`
    SELECT c.id, c.transcript_id, c.content, c.timestamp_start, c.timestamp_end,
           t.filename, t.module_name, t.lesson_title,
           ts_rank_cd(c.search_tsv, q, 1)::float8 AS rank
    FROM transcript_chunks c
    JOIN transcripts t ON t.id = c.transcript_id,
         to_tsquery('english', ${tsq}) q
    WHERE t.processing_status = 'COMPLETED'
      AND c.search_tsv @@ q
      AND (${moduleName ?? null}::text IS NULL OR t.module_name = ${moduleName ?? null})
    ORDER BY rank DESC, c.chunk_index ASC
    LIMIT ${limit}`;
}

async function semantic(question: string, searchTerms: string[], limit: number, opts: SearchOptions) {
  const embedder = await getEmbedder();
  if (!embedder) return [];
  try {
    const query = [question, ...searchTerms].join(' ').slice(0, 4000);
    const [vector] = await embedAll(embedder, [query], opts.responseJobId ?? null);
    const hits = await semanticSearch(vector, embedder.id, limit);
    return hits.filter((h) => h.similarity >= (opts.minSimilarity ?? 0.3));
  } catch (err) {
    // Retrieval degrades to full-text search rather than failing the answer.
    logger.warn({ err: err instanceof Error ? err.message : err }, 'semantic search unavailable; using full-text only');
    return [];
  }
}

/**
 * Hybrid retrieval over COMPLETED transcripts: Postgres full-text search plus embedding
 * similarity (when an embedding provider is configured), merged with reciprocal rank fusion.
 * Deleted, replaced or reprocessing transcripts are never returned.
 */
export async function searchTranscripts(question: string, searchTerms: string[], limit: number, opts: SearchOptions = {}): Promise<Passage[]> {
  const [ftsRows, semanticHits] = await Promise.all([
    fullText(question, searchTerms, limit * 2, opts.moduleName),
    semantic(question, searchTerms, limit * 2, opts),
  ]);

  const scores = new Map<string, number>();
  ftsRows.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (RRF_K + i + 1)));
  semanticHits.forEach((h, i) => scores.set(h.id, (scores.get(h.id) ?? 0) + 1 / (RRF_K + i + 1)));

  const rows = new Map(ftsRows.map((r) => [r.id, r]));
  const missing = semanticHits.map((h) => h.id).filter((id) => !rows.has(id));
  if (missing.length) {
    const extra = await prisma.transcriptChunk.findMany({
      where: {
        id: { in: missing },
        transcript: { processingStatus: 'COMPLETED', ...(opts.moduleName ? { moduleName: opts.moduleName } : {}) },
      },
      include: { transcript: { select: { filename: true, moduleName: true, lessonTitle: true } } },
    });
    for (const c of extra) {
      rows.set(c.id, {
        id: c.id,
        transcript_id: c.transcriptId,
        content: c.content,
        timestamp_start: c.timestampStart,
        timestamp_end: c.timestampEnd,
        filename: c.transcript.filename,
        module_name: c.transcript.moduleName,
        lesson_title: c.transcript.lessonTitle,
        rank: 0,
      });
    }
  }

  return [...scores.entries()]
    .filter(([id]) => rows.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score], i) => {
      const r = rows.get(id)!;
      return {
        ref: `S${i + 1}`,
        chunkId: r.id,
        transcriptId: r.transcript_id,
        filename: r.filename,
        moduleName: r.module_name,
        lessonTitle: r.lesson_title,
        timestampStart: r.timestamp_start,
        timestampEnd: r.timestamp_end,
        content: r.content,
        rank: score,
      };
    });
}

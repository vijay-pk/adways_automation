import { prisma, type Db } from '../db/prisma.js';

/**
 * The embedding column is pgvector "vector" where the extension exists (Supabase) and
 * real[] elsewhere (see the knowledge_base migration). SQL is built per backend; the
 * pgvector type and operator are schema-qualified so search_path does not matter.
 */
export type VectorBackend = { kind: 'pgvector'; schema: string } | { kind: 'array' } | { kind: 'missing' };

let cached: VectorBackend | null = null;

export async function detectVectorBackend(db: Db = prisma): Promise<VectorBackend> {
  if (cached) return cached;
  const rows = await db.$queryRaw<{ udt_name: string; udt_schema: string }[]>`
    SELECT udt_name, udt_schema FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'transcript_chunks' AND column_name = 'embedding'`;
  const r = rows[0];
  cached = !r ? { kind: 'missing' } : r.udt_name === 'vector' ? { kind: 'pgvector', schema: r.udt_schema } : { kind: 'array' };
  return cached;
}

const qi = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/** Literal accepted by both pgvector ('[1,2]') and real[] ('{1,2}') casts. */
export function vectorLiteral(backend: VectorBackend, v: number[]): string {
  if (v.some((x) => !Number.isFinite(x))) throw new Error('Embedding contains non-finite values');
  const body = v.map((x) => Number(x.toFixed(7))).join(',');
  return backend.kind === 'pgvector' ? `[${body}]` : `{${body}}`;
}

export function castExpr(backend: VectorBackend, param: string): string {
  if (backend.kind === 'pgvector') return `${param}::${qi(backend.schema)}.vector`;
  return `${param}::real[]`;
}

/** SQL expression for cosine similarity (1 = identical) between the column and a parameter. */
export function similarityExpr(backend: VectorBackend, column: string, param: string): string {
  if (backend.kind === 'pgvector') return `(1 - (${column} OPERATOR(${qi(backend.schema)}.<=>) ${castExpr(backend, param)}))`;
  return `kb_cosine(${column}, ${castExpr(backend, param)})`;
}

/** UPDATE statement storing one chunk embedding. Params: $1 vector literal, $2 model, $3 dims, $4 chunk id. */
export function updateEmbeddingSql(backend: VectorBackend): string {
  return `UPDATE "transcript_chunks" SET "embedding" = ${castExpr(backend, '$1')}, "embedding_model" = $2, "embedding_dims" = $3 WHERE "id" = $4`;
}

/**
 * Nearest chunks of COMPLETED transcripts embedded with the same model.
 * Params: $1 query vector literal, $2 model id, $3 dims, $4 limit.
 */
export function semanticSearchSql(backend: VectorBackend): string {
  const sim = similarityExpr(backend, 'c."embedding"', '$1');
  return `
    SELECT c."id", ${sim}::float8 AS similarity
    FROM "transcript_chunks" c JOIN "transcripts" t ON t."id" = c."transcript_id"
    WHERE t."processing_status" = 'COMPLETED'
      AND c."embedding" IS NOT NULL AND c."embedding_model" = $2 AND c."embedding_dims" = $3
    ORDER BY ${backend.kind === 'pgvector' ? `c."embedding" OPERATOR(${qi(backend.schema)}.<=>) ${castExpr(backend, '$1')}` : 'similarity DESC'}
    LIMIT $4`;
}

export async function storeEmbedding(db: Db, backend: VectorBackend, chunkId: string, vector: number[], model: string) {
  await db.$executeRawUnsafe(updateEmbeddingSql(backend), vectorLiteral(backend, vector), model, vector.length, chunkId);
}

export async function semanticSearch(vector: number[], model: string, limit: number): Promise<{ id: string; similarity: number }[]> {
  const backend = await detectVectorBackend();
  if (backend.kind === 'missing') return [];
  return prisma.$queryRawUnsafe(semanticSearchSql(backend), vectorLiteral(backend, vector), model, vector.length, limit);
}

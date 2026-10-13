import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { semanticSearchSql, updateEmbeddingSql, vectorLiteral, type VectorBackend } from '../src/embeddings/vectorStore.js';

/**
 * The local test database has no pgvector, so the pgvector code path (used on Supabase)
 * is verified here against PGlite, an in-process Postgres with the real pgvector extension.
 * It runs the exact SQL from the migration and from vectorStore.ts.
 */
const migration = readFileSync('prisma/migrations/20261013090000_knowledge_base/migration.sql', 'utf8');
const between = (start: string, end: string) => {
  const i = migration.indexOf(start);
  return migration.slice(i, migration.indexOf(end, i) + end.length);
};
const embeddingBlock = between('DO $$\nDECLARE\n  ext_schema text;', 'END $$;');
const cosineFn = between('CREATE OR REPLACE FUNCTION kb_cosine', '$$;');

async function setup(db: PGlite) {
  await db.exec(`
    CREATE TABLE "transcripts" (id text PRIMARY KEY, processing_status text NOT NULL);
    CREATE TABLE "transcript_chunks" (id text PRIMARY KEY, transcript_id text REFERENCES transcripts(id), embedding_model text, embedding_dims int);
    INSERT INTO transcripts VALUES ('t1', 'COMPLETED'), ('t2', 'PENDING');
    INSERT INTO transcript_chunks (id, transcript_id) VALUES ('near', 't1'), ('far', 't1'), ('pending', 't2'), ('othermodel', 't1');
  `);
  await db.exec(cosineFn);
  await db.exec(embeddingBlock);
}

async function store(db: PGlite, backend: VectorBackend, id: string, v: number[], model = 'm1') {
  await db.query(updateEmbeddingSql(backend), [vectorLiteral(backend, v), model, v.length, id]);
}

async function exercise(db: PGlite, backend: VectorBackend) {
  await store(db, backend, 'near', [1, 0.1, 0]);
  await store(db, backend, 'far', [0, 0, 1]);
  await store(db, backend, 'pending', [1, 0.1, 0]);
  await store(db, backend, 'othermodel', [1, 0.1, 0], 'm2');
  const res = await db.query<{ id: string; similarity: number }>(semanticSearchSql(backend), [vectorLiteral(backend, [1, 0, 0]), 'm1', 3, 10]);
  return res.rows;
}

describe('embedding SQL', () => {
  it('pgvector in a separate "extensions" schema (Supabase layout): schema-qualified type and operator work', async () => {
    const db = await PGlite.create({ extensions: { vector } });
    await db.exec('CREATE SCHEMA extensions;');
    await setup(db);
    const col = await db.query<{ udt_name: string; udt_schema: string }>(
      `SELECT udt_name, udt_schema FROM information_schema.columns WHERE table_name = 'transcript_chunks' AND column_name = 'embedding'`,
    );
    expect(col.rows[0]).toEqual({ udt_name: 'vector', udt_schema: 'extensions' });
    const rows = await exercise(db, { kind: 'pgvector', schema: 'extensions' });
    expect(rows.map((r) => r.id)).toEqual(['near', 'far']); // pending transcript and other model excluded
    expect(rows[0].similarity).toBeGreaterThan(0.99);
    expect(rows[1].similarity).toBeLessThan(0.01);
    await db.close();
  });

  it('falls back to real[] with kb_cosine when pgvector is unavailable', async () => {
    const db = await PGlite.create();
    await setup(db);
    const col = await db.query<{ data_type: string }>(`SELECT data_type FROM information_schema.columns WHERE table_name = 'transcript_chunks' AND column_name = 'embedding'`);
    expect(col.rows[0].data_type).toBe('ARRAY');
    const rows = await exercise(db, { kind: 'array' });
    expect(rows.map((r) => r.id)).toEqual(['near', 'far']);
    expect(rows[0].similarity).toBeGreaterThan(0.99);
    await db.close();
  });

  it('rejects non-finite embedding values', () => {
    expect(() => vectorLiteral({ kind: 'array' }, [1, Number.NaN])).toThrow();
  });
});

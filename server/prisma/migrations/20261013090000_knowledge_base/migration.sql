-- Knowledge Base: richer transcript metadata, background processing, original-file storage
-- provider, and chunk embeddings for semantic retrieval.

ALTER TYPE "TranscriptStatus" RENAME VALUE 'READY' TO 'COMPLETED';

ALTER TABLE "transcripts"
  ADD COLUMN "topic" TEXT,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "source_type" TEXT NOT NULL DEFAULT 'upload',
  ADD COLUMN "storage_provider" TEXT NOT NULL DEFAULT 'local',
  ADD COLUMN "extracted_text" TEXT,
  ADD COLUMN "embedded_chunk_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "processing_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "processed_at" TIMESTAMP(3);

CREATE INDEX "transcripts_processing_status_idx" ON "transcripts" ("processing_status");
CREATE INDEX "transcripts_topic_idx" ON "transcripts" ("topic");

ALTER TABLE "transcript_chunks"
  ADD COLUMN "embedding_model" TEXT,
  ADD COLUMN "embedding_dims" INTEGER;

-- Cosine similarity for the real[] fallback (used where pgvector is not installed).
CREATE OR REPLACE FUNCTION kb_cosine(a real[], b real[]) RETURNS double precision
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN na = 0 OR nb = 0 THEN 0 ELSE dot / (sqrt(na) * sqrt(nb)) END
  FROM (
    SELECT sum(x * y)::double precision AS dot, sum(x * x)::double precision AS na, sum(y * y)::double precision AS nb
    FROM unnest(a, b) AS t(x, y)
  ) s
$$;

-- Embedding column: pgvector when available (Supabase), otherwise real[].
-- On Supabase the extension normally lives in the "extensions" schema; types and operators
-- are referenced schema-qualified by the application, so search_path does not matter.
DO $$
DECLARE
  ext_schema text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
      IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
        CREATE EXTENSION vector SCHEMA extensions;
      ELSE
        CREATE EXTENSION vector;
      END IF;
    END IF;
    SELECT extnamespace::regnamespace::text INTO ext_schema FROM pg_extension WHERE extname = 'vector';
    EXECUTE format('ALTER TABLE "transcript_chunks" ADD COLUMN "embedding" %I.vector', ext_schema);
  ELSE
    ALTER TABLE "transcript_chunks" ADD COLUMN "embedding" real[];
  END IF;
END $$;

-- Row Level Security: the app connects as the table owner (bypasses RLS). Enabling RLS
-- with no policies blocks Supabase's public anon/authenticated API roles from these tables.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'administrators', 'admin_sessions', 'password_reset_tokens', 'students', 'groups',
    'transcripts', 'transcript_chunks', 'conversations', 'incoming_messages', 'response_jobs',
    'response_drafts', 'approved_answer_examples', 'message_deliveries', 'application_settings',
    'audit_logs', 'ai_usage', 'jobs', '_prisma_migrations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

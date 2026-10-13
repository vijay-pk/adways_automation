-- Full-text search columns (generated, kept in sync by Postgres).
ALTER TABLE "transcript_chunks"
  ADD COLUMN "search_tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("content", ''))) STORED;
CREATE INDEX "transcript_chunks_search_tsv_idx" ON "transcript_chunks" USING GIN ("search_tsv");

ALTER TABLE "approved_answer_examples"
  ADD COLUMN "search_tsv" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("normalized_question", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("original_question", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("approved_answer", '')), 'C')
  ) STORED;
CREATE INDEX "approved_answer_examples_search_tsv_idx" ON "approved_answer_examples" USING GIN ("search_tsv");

-- At most one pending job per debounce key (conversation+sender); a running job may coexist with one new pending job.
CREATE UNIQUE INDEX "jobs_active_dedupe_key" ON "jobs" ("type", "dedupe_key")
  WHERE "status" = 'PENDING' AND "dedupe_key" IS NOT NULL;

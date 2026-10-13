// Builds supabase/install.sql: every Prisma migration in order, inside a dedicated "tutor"
// schema, plus the _prisma_migrations bookkeeping rows so `prisma migrate deploy` later sees
// them as applied. Paste the output into the Supabase SQL Editor once.
// Usage: node scripts/build-supabase-sql.mjs [--check]
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../prisma/migrations');
const outFile = resolve(here, '../../supabase/install.sql');
export const SCHEMA = 'tutor';

export function loadMigrations() {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => {
      // Prisma checksums the file as read on the deploy server (LF line endings, see .gitattributes).
      const sql = readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8').replace(/\r\n/g, '\n');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

export function buildInstallSql(migrations = loadMigrations(), uuid = () => randomUUID()) {
  const parts = [];
  parts.push(`-- =====================================================================
-- Course Tutor — Supabase install script (generated; do not edit by hand)
-- Regenerate with: npm run supabase:sql --workspace server
--
-- HOW TO USE
--   1. Supabase dashboard → SQL Editor → New query.
--   2. Paste this whole file and click Run (runs as one transaction).
--   3. Set DATABASE_URL / DIRECT_URL with ?schema=${SCHEMA} (see server/.env.production.example).
--
-- WHAT IT DOES
--   • Creates everything inside its own schema "${SCHEMA}", so it cannot collide with
--     existing tables in "public" and is NOT exposed through Supabase's public REST API.
--   • Enables pgvector (in the "extensions" schema) for transcript embeddings.
--   • Enables Row Level Security on every table and revokes API-role access.
--   • Records the migrations as applied, so future upgrades run with \`npm run db:migrate\`.
--   • Creates no users and no admin accounts (use \`npm run admin:create\` on the server).
--
-- Safe to run once. If the schema is already installed it stops without changing anything.
-- Migrations included: ${migrations.map((m) => m.name).join(', ')}
-- =====================================================================

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('${SCHEMA}._prisma_migrations') IS NOT NULL THEN
    RAISE EXCEPTION 'Course Tutor is already installed in schema "${SCHEMA}". Use "npm run db:migrate" for upgrades.';
  END IF;
END
$guard$;

CREATE SCHEMA IF NOT EXISTS ${SCHEMA};
SET LOCAL search_path TO ${SCHEMA}, extensions, public;

CREATE TABLE "_prisma_migrations" (
    "id"                    VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum"              VARCHAR(64) NOT NULL,
    "finished_at"           TIMESTAMPTZ,
    "migration_name"        VARCHAR(255) NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        TIMESTAMPTZ,
    "started_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count"   INTEGER NOT NULL DEFAULT 0
);
`);
  for (const m of migrations) {
    parts.push(`
-- ---------------------------------------------------------------------
-- Migration: ${m.name}
-- ---------------------------------------------------------------------
${m.sql.trim()}

INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "started_at", "applied_steps_count")
VALUES ('${uuid()}', '${m.checksum}', now(), '${m.name}', now(), 1);
`);
  }
  parts.push(`
-- ---------------------------------------------------------------------
-- Access control: only the server (table owner via the database connection) may use this schema.
-- ---------------------------------------------------------------------
REVOKE ALL ON SCHEMA ${SCHEMA} FROM PUBLIC;
DO $roles$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA ${SCHEMA} FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ${SCHEMA} FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${SCHEMA} FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${SCHEMA} FROM %I', r);
    END IF;
  END LOOP;
END
$roles$;

COMMIT;

-- Verification (should list ${migrations.length} migrations and the embedding column type):
SELECT migration_name, finished_at FROM ${SCHEMA}."_prisma_migrations" ORDER BY migration_name;
SELECT udt_schema || '.' || udt_name AS embedding_type
FROM information_schema.columns
WHERE table_schema = '${SCHEMA}' AND table_name = 'transcript_chunks' AND column_name = 'embedding';
`);
  return parts.join('');
}

/** Ignores the random migration-row ids when comparing generated output. */
export const normalizeIds = (sql) => sql.replace(/VALUES \('[0-9a-f-]{36}'/g, "VALUES ('<id>'");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sql = buildInstallSql();
  if (process.argv.includes('--check')) {
    const current = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
    if (normalizeIds(current) !== normalizeIds(sql)) {
      console.error('supabase/install.sql is out of date. Run: npm run supabase:sql --workspace server');
      process.exit(1);
    }
    console.log('supabase/install.sql is up to date.');
  } else {
    writeFileSync(outFile, sql);
    console.log(`Wrote ${outFile}`);
  }
}

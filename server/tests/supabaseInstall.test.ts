import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
// @ts-expect-error plain ESM build script without type declarations
import { buildInstallSql, normalizeIds } from '../scripts/build-supabase-sql.mjs';

const installSql = readFileSync('../supabase/install.sql', 'utf8');

describe('supabase/install.sql', () => {
  it('is up to date with the Prisma migrations', () => {
    expect(normalizeIds(installSql)).toBe(normalizeIds(buildInstallSql()));
  });

  it('installs into a Supabase-like database without touching existing tables', async () => {
    const db = await PGlite.create({ extensions: { vector } });
    // Supabase layout: extensions schema, API roles, and an unrelated existing app table.
    await db.exec(`
      CREATE SCHEMA extensions;
      CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE TABLE public.students (id int PRIMARY KEY, name text);
      INSERT INTO public.students VALUES (1, 'existing row');
      GRANT ALL ON ALL TABLES IN SCHEMA public TO anon;
    `);
    await db.exec(installSql);

    const emb = await db.query<{ t: string }>(
      `SELECT udt_schema || '.' || udt_name AS t FROM information_schema.columns WHERE table_schema = 'tutor' AND table_name = 'transcript_chunks' AND column_name = 'embedding'`,
    );
    expect(emb.rows[0].t).toBe('extensions.vector');

    const migrations = await db.query<{ migration_name: string }>(`SELECT migration_name FROM tutor._prisma_migrations ORDER BY 1`);
    expect(migrations.rows).toHaveLength(buildInstallSql().match(/^-- Migration: /gm).length);

    const noRls = await db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'tutor' AND c.relkind = 'r' AND NOT c.relrowsecurity`,
    );
    expect(noRls.rows).toEqual([]);

    const access = await db.query<{ usage: boolean; select: boolean }>(
      `SELECT has_schema_privilege('anon', 'tutor', 'USAGE') AS usage, has_table_privilege('anon', 'tutor.administrators', 'SELECT') AS select`,
    );
    expect(access.rows[0]).toEqual({ usage: false, select: false });

    // Existing public tables are untouched.
    const existing = await db.query<{ name: string }>(`SELECT name FROM public.students`);
    expect(existing.rows).toEqual([{ name: 'existing row' }]);

    // Running it again stops safely.
    await expect(db.exec(installSql)).rejects.toThrow(/already installed/);
    await db.close();
  });
});

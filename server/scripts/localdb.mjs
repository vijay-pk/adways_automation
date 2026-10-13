// Dev/test helper: runs a local PostgreSQL using embedded-postgres binaries.
// Production uses the hosted DATABASE_URL instead.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(process.env.LOCAL_PG_DIR ?? '.localdb');
const port = Number(process.env.LOCAL_PG_PORT ?? 5433);
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'tutor', password: 'tutor_local', port, persistent: true });
if (!existsSync(dir)) await pg.initialise();
await pg.start();
try { await pg.createDatabase('tutor'); } catch { /* exists */ }
console.log(`Local Postgres ready: postgresql://tutor:tutor_local@localhost:${port}/tutor`);
const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (process.argv.includes('--once')) await stop();

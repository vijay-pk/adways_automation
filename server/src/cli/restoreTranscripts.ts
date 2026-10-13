/**
 * Uploads transcript originals from a backup directory (made by backupTranscripts.ts) back into
 * the configured storage, at the storage paths recorded in the database. Run after restoring the
 * database dump. Existing objects with the same key are overwritten with identical content.
 * Usage: node dist/cli/restoreTranscripts.js <backupDir>
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { getStorage } from '../storage/index.js';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: restoreTranscripts <backupDir>');
  process.exit(1);
}

const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
  files: { file: string; storagePath: string; fileHash: string; mimeType: string | null }[];
};
const storage = getStorage();
await storage.ensureReady();
const known = new Map((await prisma.transcript.findMany({ select: { storagePath: true, fileHash: true } })).map((t) => [t.storagePath, t.fileHash]));
let restored = 0;
let skipped = 0;
for (const f of manifest.files) {
  if (known.get(f.storagePath) !== f.fileHash) {
    skipped++; // not referenced by the restored database
    continue;
  }
  const data = await readFile(join(dir, 'files', f.file));
  if (createHash('sha256').update(data).digest('hex') !== f.fileHash) throw new Error(`Checksum mismatch for ${f.file}`);
  await storage.put(f.storagePath, data, f.mimeType ?? 'application/octet-stream');
  restored++;
}
console.log(`Restored ${restored} files to ${storage.name} storage; skipped ${skipped} not referenced by the database.`);
await prisma.$disconnect();

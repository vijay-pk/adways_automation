/**
 * Copies every transcript original from storage (local or Supabase) into a backup directory,
 * with a manifest that restoreTranscripts.ts can replay. The database dump is separate (deploy/backup.sh).
 * Usage: node dist/cli/backupTranscripts.js <outDir>
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prisma } from '../db/prisma.js';
import { getStorage } from '../storage/index.js';

const outDir = process.argv[2];
if (!outDir) {
  console.error('Usage: backupTranscripts <outDir>');
  process.exit(1);
}

const storage = getStorage();
const transcripts = await prisma.transcript.findMany({
  select: { id: true, filename: true, storagePath: true, fileHash: true, lessonTitle: true, mimeType: true },
});
await mkdir(join(outDir, 'files'), { recursive: true });
const manifest: { id: string; file: string; storagePath: string; fileHash: string; mimeType: string | null; title: string | null }[] = [];
let failed = 0;
for (const t of transcripts) {
  try {
    const data = await storage.get(t.storagePath);
    const file = `${t.fileHash}${t.storagePath.match(/\.[a-z0-9]+$/i)?.[0] ?? ''}`;
    await writeFile(join(outDir, 'files', file), data);
    manifest.push({ id: t.id, file, storagePath: t.storagePath, fileHash: t.fileHash, mimeType: t.mimeType, title: t.lessonTitle });
  } catch (err) {
    failed++;
    console.error(`Could not back up ${t.filename}: ${err instanceof Error ? err.message : err}`);
  }
}
await writeFile(join(outDir, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), storage: storage.name, files: manifest }, null, 2));
console.log(`Backed up ${manifest.length}/${transcripts.length} transcript originals to ${outDir}`);
await prisma.$disconnect();
if (failed) process.exitCode = 1;

import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Transcript } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { sha256 } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { getSettings } from '../settings/settingsService.js';
import { getStorage } from '../storage/index.js';
import { enqueueDebounced } from '../jobs/queue.js';
import { extensionOf, extractSegments, sniffMatches, SUPPORTED_EXTENSIONS } from './extract/index.js';
import { chunkSegments } from './chunk.js';
import { embedAll, getEmbedder } from '../embeddings/index.js';
import { detectVectorBackend, storeEmbedding } from '../embeddings/vectorStore.js';

export const uploadRoot = () => resolve(env.UPLOAD_DIR);

export interface TranscriptMeta {
  title?: string | null;
  moduleName?: string | null;
  topic?: string | null;
  description?: string | null;
}

const MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt',
};

const clean = (s?: string | null, max = 200) => (s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) || null;
const safeName = (n: string) => n.replace(/[^\w.\- ()]/g, '_').slice(0, 200);
const titleFromFilename = (n: string) => n.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 200);

/** Type, content and size checks shared by uploads, pasted text and replacements. */
async function validateFile(buf: Buffer, filename: string) {
  const ext = extensionOf(filename);
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw badRequest(`Unsupported file type "${ext || 'none'}". Allowed: ${SUPPORTED_EXTENSIONS.join(', ')}`);
  }
  const { max_upload_mb } = await getSettings();
  const limit = Math.min(max_upload_mb, env.MAX_UPLOAD_MB) * 1024 * 1024;
  if (buf.length === 0) throw badRequest('File is empty');
  if (buf.length > limit) throw badRequest(`File exceeds the ${Math.min(max_upload_mb, env.MAX_UPLOAD_MB)} MB limit`);
  if (!sniffMatches(ext, buf)) throw badRequest('File content does not match its extension');
  return { ext, mime: MIME[ext] ?? 'application/octet-stream' };
}

async function assertNotDuplicate(fileHash: string, exceptId?: string) {
  const existing = await prisma.transcript.findUnique({ where: { fileHash } });
  if (existing && existing.id !== exceptId) {
    throw conflict(`Duplicate: identical content already uploaded as "${existing.lessonTitle ?? existing.filename}"`);
  }
  if (existing && existing.id === exceptId) throw conflict('The replacement is identical to the current file');
}

const storageKey = (hash: string, ext: string) => `transcripts/${hash}${ext}`;

export const enqueueProcessing = (id: string) =>
  enqueueDebounced('processTranscript', id, { transcriptId: id }, new Date());

/** Stores the original privately, creates a PENDING transcript and queues background processing. */
export async function createTranscript(buf: Buffer, filename: string, meta: TranscriptMeta, sourceType: 'upload' | 'paste' = 'upload') {
  const { ext, mime } = await validateFile(buf, filename);
  const fileHash = sha256(buf);
  await assertNotDuplicate(fileHash);
  const storage = getStorage();
  const key = storageKey(fileHash, ext);
  await storage.put(key, buf, mime);
  try {
    const t = await prisma.transcript.create({
      data: {
        filename: safeName(filename),
        lessonTitle: clean(meta.title) ?? titleFromFilename(filename),
        moduleName: clean(meta.moduleName),
        topic: clean(meta.topic),
        description: clean(meta.description, 2000),
        fileHash,
        storagePath: key,
        storageProvider: storage.name,
        mimeType: mime,
        sizeBytes: buf.length,
        sourceType,
        processingStatus: 'PENDING',
      },
    });
    await enqueueProcessing(t.id);
    return t;
  } catch (err) {
    await storage.delete(key).catch(() => undefined);
    throw err;
  }
}

export async function createFromUpload(tmpPath: string, originalName: string, meta: TranscriptMeta) {
  try {
    return await createTranscript(await readFile(tmpPath), originalName, meta, 'upload');
  } finally {
    await rm(tmpPath, { force: true });
  }
}

export async function createFromText(text: string, meta: TranscriptMeta) {
  const title = clean(meta.title);
  if (!title) throw badRequest('Class title is required for pasted transcripts');
  if (!text.trim()) throw badRequest('Transcript text is empty');
  const filename = `${title.replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').toLowerCase().slice(0, 80) || 'transcript'}.txt`;
  return createTranscript(Buffer.from(text, 'utf8'), filename, meta, 'paste');
}

/** Replaces the original file. Old chunks are removed immediately so stale content is never retrieved. */
export async function replaceTranscriptFile(id: string, buf: Buffer, filename: string) {
  const t = await prisma.transcript.findUnique({ where: { id } });
  if (!t) throw notFound('Transcript not found');
  const { ext, mime } = await validateFile(buf, filename);
  const fileHash = sha256(buf);
  await assertNotDuplicate(fileHash, id);
  const storage = getStorage();
  const key = storageKey(fileHash, ext);
  await storage.put(key, buf, mime);
  const updated = await prisma.$transaction(async (tx) => {
    await tx.transcriptChunk.deleteMany({ where: { transcriptId: id } });
    return tx.transcript.update({
      where: { id },
      data: {
        filename: safeName(filename),
        fileHash,
        storagePath: key,
        storageProvider: storage.name,
        mimeType: mime,
        sizeBytes: buf.length,
        sourceType: 'upload',
        processingStatus: 'PENDING',
        processingError: null,
        extractedText: null,
        chunkCount: 0,
        embeddedChunkCount: 0,
        processingAttempts: 0,
        processedAt: null,
      },
    });
  });
  if (t.storagePath !== key) await storage.delete(t.storagePath).catch(() => undefined);
  await enqueueProcessing(id);
  return updated;
}

export async function updateTranscriptMeta(id: string, meta: TranscriptMeta) {
  return prisma.transcript.update({
    where: { id },
    data: {
      ...(meta.title !== undefined ? { lessonTitle: clean(meta.title) ?? undefined } : {}),
      ...(meta.moduleName !== undefined ? { moduleName: clean(meta.moduleName) } : {}),
      ...(meta.topic !== undefined ? { topic: clean(meta.topic) } : {}),
      ...(meta.description !== undefined ? { description: clean(meta.description, 2000) } : {}),
    },
  });
}

export async function requestReprocess(id: string) {
  const r = await prisma.transcript.updateMany({
    where: { id },
    data: { processingStatus: 'PENDING', processingError: null, processingAttempts: 0 },
  });
  if (!r.count) throw notFound('Transcript not found');
  await enqueueProcessing(id);
}

class Superseded extends Error {}

/**
 * Background step: download original, extract, chunk, embed, and swap chunks atomically.
 * If the file was replaced or deleted meanwhile, the result is discarded.
 */
export async function processTranscript(id: string, opts: { final: boolean } = { final: true }): Promise<Transcript | null> {
  const t = await prisma.transcript.findUnique({ where: { id } });
  if (!t) return null;
  const hashAtStart = t.fileHash;
  await prisma.transcript.update({
    where: { id },
    data: { processingStatus: 'PROCESSING', processingAttempts: { increment: 1 } },
  });
  try {
    const buf = await getStorage().get(t.storagePath);
    const segments = await extractSegments(buf, t.filename);
    const chunks = chunkSegments(segments);
    if (!chunks.length) throw new Error('No text could be extracted from this file');
    const extractedText = segments.map((s) => (s.start ? `[${s.start}] ${s.text}` : s.text)).join('\n');

    const embedder = await getEmbedder();
    const header = [t.lessonTitle, t.topic].filter(Boolean).join(' — ');
    const vectors = embedder ? await embedAll(embedder, chunks.map((c) => (header ? `${header}\n${c.content}` : c.content))) : null;
    const backend = vectors ? await detectVectorBackend() : null;
    if (backend?.kind === 'missing') throw new Error('Embedding column missing; run database migrations');

    await prisma.$transaction(
      async (tx) => {
        const current = await tx.transcript.findUnique({ where: { id }, select: { fileHash: true } });
        if (!current || current.fileHash !== hashAtStart) throw new Superseded();
        await tx.transcriptChunk.deleteMany({ where: { transcriptId: id } });
        await tx.transcriptChunk.createMany({
          data: chunks.map((c) => ({
            transcriptId: id,
            chunkIndex: c.index,
            content: c.content,
            timestampStart: c.timestampStart,
            timestampEnd: c.timestampEnd,
            tokenEstimate: c.tokenEstimate,
          })),
        });
        if (vectors && embedder && backend) {
          const rows = await tx.transcriptChunk.findMany({ where: { transcriptId: id }, select: { id: true, chunkIndex: true } });
          for (const r of rows) await storeEmbedding(tx, backend, r.id, vectors[r.chunkIndex], embedder.id);
        }
        await tx.transcript.update({
          where: { id },
          data: {
            processingStatus: 'COMPLETED',
            processingError: null,
            chunkCount: chunks.length,
            embeddedChunkCount: vectors ? chunks.length : 0,
            extractedText,
            processedAt: new Date(),
          },
        });
      },
      { timeout: 60_000 },
    );
  } catch (err) {
    if (err instanceof Superseded) return null;
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    await prisma.transcript.updateMany({
      where: { id, fileHash: hashAtStart },
      data: opts.final
        ? { processingStatus: 'FAILED', processingError: message }
        : { processingStatus: 'PENDING', processingError: `Attempt failed, retrying automatically: ${message}` },
    });
    if (!opts.final) throw err;
  }
  return prisma.transcript.findUnique({ where: { id } });
}

export async function deleteTranscript(id: string) {
  const t = await prisma.transcript.findUnique({ where: { id } });
  if (!t) throw notFound('Transcript not found');
  await prisma.transcript.delete({ where: { id } }); // chunks cascade; approved examples keep their own source snapshot
  await getStorage().delete(t.storagePath).catch(() => undefined);
  return t;
}

export async function readOriginal(id: string) {
  const t = await prisma.transcript.findUnique({ where: { id } });
  if (!t) throw notFound('Transcript not found');
  return { transcript: t, data: await getStorage().get(t.storagePath) };
}

import { Router } from 'express';
import express from 'express';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Prisma, TranscriptStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { requireRole, SUPER, CAN_REVIEW } from '../auth/middleware.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parseBody } from '../lib/validate.js';
import { audit } from '../audit/auditService.js';
import { getSettings } from '../settings/settingsService.js';
import { getEmbedder } from '../embeddings/index.js';
import { detectVectorBackend } from '../embeddings/vectorStore.js';
import { getStorage } from '../storage/index.js';
import { searchTranscripts } from '../retrieval/transcriptSearch.js';
import {
  createFromText,
  createFromUpload,
  deleteTranscript,
  readOriginal,
  replaceTranscriptFile,
  requestReprocess,
  updateTranscriptMeta,
  uploadRoot,
} from './service.js';

const tmpDir = join(uploadRoot(), 'tmp');
mkdirSync(tmpDir, { recursive: true });
// Hard ceiling from env; the admin-configurable limit is enforced per file in the service.
const upload = multer({ dest: tmpDir, limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 20 } });

export const transcriptRouter = Router();

const metaSchema = z.object({
  title: z.string().max(200).optional(),
  moduleName: z.string().max(200).optional(),
  topic: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
});

const LIST_OMIT = { storagePath: true, extractedText: true } as const;

transcriptRouter.get('/', async (req, res) => {
  const q = z
    .object({
      q: z.string().max(200).optional(),
      module: z.string().max(200).optional(),
      topic: z.string().max(200).optional(),
      status: z.nativeEnum(TranscriptStatus).optional(),
      sort: z.enum(['createdAt', 'title', 'module', 'status']).default('createdAt'),
      order: z.enum(['asc', 'desc']).default('desc'),
    })
    .parse(req.query);
  const where: Prisma.TranscriptWhereInput = {
    ...(q.module ? { moduleName: q.module } : {}),
    ...(q.topic ? { topic: q.topic } : {}),
    ...(q.status ? { processingStatus: q.status } : {}),
    ...(q.q
      ? {
          OR: ['lessonTitle', 'topic', 'description', 'filename', 'moduleName'].map((f) => ({ [f]: { contains: q.q, mode: 'insensitive' } })),
        }
      : {}),
  };
  const orderBy: Prisma.TranscriptOrderByWithRelationInput =
    q.sort === 'title' ? { lessonTitle: q.order } : q.sort === 'module' ? { moduleName: q.order } : q.sort === 'status' ? { processingStatus: q.order } : { createdAt: q.order };
  const items = await prisma.transcript.findMany({ where, orderBy, omit: LIST_OMIT });
  res.json({ items });
});

/** Filter options and pipeline configuration (no secrets). */
transcriptRouter.get('/meta', async (_req, res) => {
  const [modules, topics, counts, settings, embedder, backend] = await Promise.all([
    prisma.transcript.findMany({ distinct: ['moduleName'], select: { moduleName: true }, where: { moduleName: { not: null } } }),
    prisma.transcript.findMany({ distinct: ['topic'], select: { topic: true }, where: { topic: { not: null } } }),
    prisma.transcript.groupBy({ by: ['processingStatus'], _count: true }),
    getSettings(),
    getEmbedder(),
    detectVectorBackend(),
  ]);
  res.json({
    modules: modules.map((m) => m.moduleName).sort(),
    topics: topics.map((t) => t.topic).sort(),
    statusCounts: Object.fromEntries(counts.map((c) => [c.processingStatus, c._count])),
    maxUploadMb: Math.min(settings.max_upload_mb, env.MAX_UPLOAD_MB),
    storage: getStorage().name,
    embeddings: { enabled: !!embedder, model: embedder?.id ?? null, vectorBackend: backend.kind },
  });
});

transcriptRouter.post('/', requireRole(...SUPER), upload.array('files', 20), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw badRequest('No files uploaded (field name "files")');
  const meta = metaSchema.parse(req.body ?? {});
  const results = [];
  for (const f of files) {
    try {
      const t = await createFromUpload(f.path, f.originalname, { ...meta, title: files.length === 1 ? meta.title : undefined });
      results.push({ filename: f.originalname, ok: true, id: t.id, status: t.processingStatus });
    } catch (err) {
      results.push({ filename: f.originalname, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  await audit(req.auth!.admin.id, 'transcript.upload', 'transcript', undefined, { results });
  res.status(202).json({ results });
});

transcriptRouter.post('/text', requireRole(...SUPER), express.json({ limit: `${env.MAX_UPLOAD_MB}mb` }), async (req, res) => {
  const body = parseBody(metaSchema.extend({ title: z.string().min(1).max(200), text: z.string().min(1) }), req.body);
  const t = await createFromText(body.text, body);
  await audit(req.auth!.admin.id, 'transcript.paste', 'transcript', t.id, { title: t.lessonTitle });
  res.status(202).json({ id: t.id, status: t.processingStatus });
});

transcriptRouter.post('/reembed-all', requireRole(...SUPER), async (req, res) => {
  const ids = await prisma.transcript.findMany({ where: { processingStatus: { in: ['COMPLETED', 'FAILED'] } }, select: { id: true } });
  for (const { id } of ids) await requestReprocess(id);
  await audit(req.auth!.admin.id, 'transcript.reprocess_all', 'transcript', undefined, { count: ids.length });
  res.status(202).json({ queued: ids.length });
});

transcriptRouter.get('/search', async (req, res) => {
  const q = z.object({ q: z.string().min(1).max(500), module: z.string().optional() }).parse(req.query);
  const settings = await getSettings();
  res.json({ results: await searchTranscripts(q.q, [], 10, { moduleName: q.module, minSimilarity: settings.semantic_min_similarity }) });
});

transcriptRouter.get('/:id', async (req, res) => {
  const t = await prisma.transcript.findUnique({ where: { id: req.params.id }, omit: { storagePath: true } });
  if (!t) throw notFound();
  const chunks = await prisma.transcriptChunk.findMany({
    where: { transcriptId: t.id },
    orderBy: { chunkIndex: 'asc' },
    select: { id: true, chunkIndex: true, content: true, timestampStart: true, timestampEnd: true, tokenEstimate: true, embeddingModel: true },
  });
  res.json({ transcript: t, chunks });
});

/** Original file download for reviewers and super admins; never a public URL. */
transcriptRouter.get('/:id/original', requireRole(...CAN_REVIEW), async (req, res) => {
  const { transcript, data } = await readOriginal(req.params.id as string);
  res.setHeader('content-type', transcript.mimeType ?? 'application/octet-stream');
  res.setHeader('cache-control', 'private, no-store');
  res.attachment(transcript.filename).send(data);
});

transcriptRouter.patch('/:id', requireRole(...SUPER), async (req, res) => {
  const body = parseBody(metaSchema, req.body ?? {});
  const t = await updateTranscriptMeta(req.params.id as string, body);
  await audit(req.auth!.admin.id, 'transcript.update', 'transcript', t.id, body);
  res.json({ ...t, storagePath: undefined, extractedText: undefined });
});

transcriptRouter.post('/:id/replace', requireRole(...SUPER), upload.single('file'), async (req, res) => {
  const f = req.file;
  if (!f) throw badRequest('No file uploaded (field name "file")');
  const { readFile, rm } = await import('node:fs/promises');
  try {
    const t = await replaceTranscriptFile(req.params.id as string, await readFile(f.path), f.originalname);
    await audit(req.auth!.admin.id, 'transcript.replace', 'transcript', t.id, { filename: t.filename });
    res.status(202).json({ id: t.id, status: t.processingStatus });
  } finally {
    await rm(f.path, { force: true });
  }
});

transcriptRouter.post('/:id/reprocess', requireRole(...SUPER), async (req, res) => {
  await requestReprocess(req.params.id as string);
  await audit(req.auth!.admin.id, 'transcript.reprocess', 'transcript', req.params.id as string);
  res.status(202).json({ id: req.params.id, status: 'PENDING' });
});

transcriptRouter.delete('/:id', requireRole(...SUPER), async (req, res) => {
  const t = await deleteTranscript(req.params.id as string);
  await audit(req.auth!.admin.id, 'transcript.delete', 'transcript', t.id, { filename: t.filename, title: t.lessonTitle });
  res.json({ ok: true });
});

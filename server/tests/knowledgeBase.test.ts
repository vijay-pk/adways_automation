import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/db/prisma.js';
import { getStorage, setStorage, type FileStorage } from '../src/storage/index.js';
import { LocalFileStorage } from '../src/storage/localStorage.js';
import { setEmbedder } from '../src/embeddings/index.js';
import { MockEmbedder } from '../src/embeddings/mockEmbedder.js';
import { searchTranscripts } from '../src/retrieval/transcriptSearch.js';
import { processTranscript } from '../src/transcripts/service.js';
import { updateSettings } from '../src/settings/settingsService.js';
import { app, CTR_TRANSCRIPT, enrollStudent, flushJobs, inbound, login, ROAS_TRANSCRIPT, setupWorld } from './helpers.js';
import { makeDocx, makePdf, RETARGETING_TEXT } from './fixtures.js';

type Session = Awaited<ReturnType<typeof login>>;
let sup: Session;

beforeEach(async () => {
  await setupWorld();
  setStorage(new LocalFileStorage('.test-uploads/originals'));
  sup = await login('SUPER_ADMIN');
});

const uploadFiles = (s: Session, files: { buf: Buffer; name: string }[], fields: Record<string, string> = {}) => {
  let r = s.agent.post('/api/transcripts').set('x-csrf-token', s.csrf);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  for (const f of files) r = r.attach('files', f.buf, f.name);
  return r;
};
const paste = (s: Session, body: object) => s.post('/api/transcripts/text', body);
const ids = (passages: { transcriptId: string }[]) => [...new Set(passages.map((p) => p.transcriptId))];

describe('upload and background processing', () => {
  it('accepts TXT, PDF and DOCX, stores originals privately and processes them in the background', async () => {
    const pdf = makePdf(['Cost per click is the amount you pay for each click on your ad.', 'Lower cost per click comes from better relevance.']);
    const docx = await makeDocx(['Lookalike audiences are built from a seed audience of your best customers.']);
    const res = await uploadFiles(sup, [
      { buf: Buffer.from(ROAS_TRANSCRIPT), name: 'roas.txt' },
      { buf: pdf, name: 'cpc-class.pdf' },
      { buf: docx, name: 'lookalikes.docx' },
    ], { moduleName: 'Module 2', topic: 'Metrics', description: 'Week 2 recordings' });
    expect(res.status).toBe(202);
    expect(res.body.results.map((r: { ok: boolean; status: string }) => [r.ok, r.status])).toEqual([[true, 'PENDING'], [true, 'PENDING'], [true, 'PENDING']]);

    // Not processed yet: the request did not block on extraction.
    expect(await prisma.transcriptChunk.count()).toBe(0);
    expect(await searchTranscripts('ROAS', [], 5)).toHaveLength(0);

    await flushJobs();
    const all = await prisma.transcript.findMany({ orderBy: { filename: 'asc' } });
    expect(all.map((t) => [t.filename, t.processingStatus])).toEqual([
      ['cpc-class.pdf', 'COMPLETED'],
      ['lookalikes.docx', 'COMPLETED'],
      ['roas.txt', 'COMPLETED'],
    ]);
    expect(all.every((t) => t.moduleName === 'Module 2' && t.topic === 'Metrics' && t.description === 'Week 2 recordings')).toBe(true);
    expect(all.find((t) => t.filename === 'cpc-class.pdf')!.extractedText).toMatch(/Cost per click is the amount/);
    expect(all.find((t) => t.filename === 'lookalikes.docx')!.extractedText).toMatch(/seed audience/);
    expect((await searchTranscripts('lookalike seed audience', [], 5))[0].lessonTitle).toBe('lookalikes');

    // Original is kept in storage and only downloadable by authorized admins.
    const roas = all.find((t) => t.filename === 'roas.txt')!;
    expect((await getStorage().get(roas.storagePath)).toString()).toBe(ROAS_TRANSCRIPT);
    const reviewer = await login('REVIEWER');
    const dl = await reviewer.get(`/api/transcripts/${roas.id}/original`);
    expect(dl.status).toBe(200);
    expect(dl.headers['cache-control']).toMatch(/no-store/);
    const viewer = await login('VIEWER');
    expect((await viewer.get(`/api/transcripts/${roas.id}/original`)).status).toBe(403);
    expect((await request(app).get(`/api/transcripts/${roas.id}/original`)).status).toBe(401);
    // Storage keys are never exposed by the API.
    const preview = await sup.get(`/api/transcripts/${roas.id}`);
    expect(preview.body.transcript.storagePath).toBeUndefined();
    expect(preview.body.transcript.extractedText).toMatch(/\[00:10:05\]/);
    expect(preview.body.chunks.length).toBeGreaterThan(0);
  });

  it('creates transcripts from pasted text with metadata', async () => {
    expect((await paste(sup, { title: '', text: 'x' })).status).toBe(400);
    const res = await paste(sup, { title: 'Class 7: Retargeting', moduleName: 'Module 3', topic: 'Audiences', description: 'Live class', text: RETARGETING_TEXT });
    expect(res.status).toBe(202);
    await flushJobs();
    const t = await prisma.transcript.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(t).toMatchObject({ lessonTitle: 'Class 7: Retargeting', moduleName: 'Module 3', topic: 'Audiences', sourceType: 'paste', processingStatus: 'COMPLETED' });
    const hits = await searchTranscripts('retargeting audiences', [], 3);
    expect(hits[0].lessonTitle).toBe('Class 7: Retargeting');
    expect(hits[0].timestampStart).toBe('00:05:00');
    // Same text pasted again is a duplicate.
    expect((await paste(sup, { title: 'Again', text: RETARGETING_TEXT })).status).toBe(409);
  });

  it('accepts large pasted transcripts beyond the default JSON body limit', async () => {
    const big = Array.from({ length: 3000 }, (_, i) => `Line ${i}: bidding strategy and budget pacing for campaigns.`).join('\n');
    expect(Buffer.byteLength(big)).toBeGreaterThan(1024 * 1024 / 8);
    const res = await paste(sup, { title: 'Full class', text: big.repeat(6) });
    expect(res.status).toBe(202);
  });

  it('rejects duplicates, unsupported or spoofed files, and files over the configured limit', async () => {
    await uploadFiles(sup, [{ buf: Buffer.from(CTR_TRANSCRIPT), name: 'ctr.txt' }]);
    const dup = await uploadFiles(sup, [{ buf: Buffer.from(CTR_TRANSCRIPT), name: 'copy.txt' }]);
    expect(dup.body.results[0]).toMatchObject({ ok: false });
    expect(dup.body.results[0].error).toMatch(/Duplicate/);
    const bad = await uploadFiles(sup, [{ buf: Buffer.from('MZ\0\0'), name: 'evil.exe' }]);
    expect(bad.body.results[0].error).toMatch(/Unsupported/);
    const spoof = await uploadFiles(sup, [{ buf: Buffer.from('not a pdf'), name: 'x.pdf' }]);
    expect(spoof.body.results[0].error).toMatch(/does not match/);
    await updateSettings({ max_upload_mb: 1 }, null);
    const big = await uploadFiles(sup, [{ buf: Buffer.alloc(1.2 * 1024 * 1024, 'a'), name: 'big.txt' }]);
    expect(big.body.results[0].error).toMatch(/1 MB limit/);
    expect(await prisma.transcript.count()).toBe(1);
  });

  it('records meaningful errors when extraction fails', async () => {
    await uploadFiles(sup, [{ buf: Buffer.from('   \n  \n'), name: 'empty.txt' }]);
    await flushJobs();
    const t = await prisma.transcript.findFirstOrThrow();
    expect(t.processingStatus).toBe('FAILED');
    expect(t.processingError).toMatch(/No text could be extracted/);
  });
});

describe('embeddings and semantic retrieval', () => {
  it('stores chunk embeddings from the configured provider and finds content full-text search misses', async () => {
    const embedder = new MockEmbedder();
    setEmbedder(embedder);
    await paste(sup, { title: 'Retargeting class', text: RETARGETING_TEXT });
    await paste(sup, { title: 'ROAS class', text: ROAS_TRANSCRIPT });
    await flushJobs();
    const t = await prisma.transcript.findFirstOrThrow({ where: { lessonTitle: 'Retargeting class' } });
    expect(t.embeddedChunkCount).toBe(t.chunkCount);
    const chunks = await prisma.transcriptChunk.findMany({ where: { transcriptId: t.id } });
    expect(chunks.every((c) => c.embeddingModel === embedder.id && c.embeddingDims === 1024)).toBe(true);

    // Misspelled query: full-text alone finds nothing; hybrid retrieval finds the class.
    setEmbedder(null);
    expect(await searchTranscripts('retargting', [], 3)).toHaveLength(0);
    setEmbedder(embedder);
    const hits = await searchTranscripts('retargting', [], 3, { minSimilarity: 0.1 });
    expect(hits[0]?.transcriptId).toBe(t.id);
    // Unrelated questions stay below the similarity threshold.
    expect(await searchTranscripts('sourdough bread baking', [], 3)).toHaveLength(0);
    // Usage is tracked for embeddings.
    expect(await prisma.aiUsage.count({ where: { purpose: 'embedding' } })).toBeGreaterThan(0);
  });

  it('retries embedding failures, then marks FAILED with the error, and recovers on reprocess', async () => {
    const embedder = new MockEmbedder();
    embedder.failNext = 100;
    setEmbedder(embedder);
    const res = await paste(sup, { title: 'CTR class', text: CTR_TRANSCRIPT });
    await flushJobs(1);
    let t = await prisma.transcript.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(t.processingStatus).toBe('PENDING');
    expect(t.processingError).toMatch(/retrying automatically/);
    await flushJobs(10);
    t = await prisma.transcript.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(t.processingStatus).toBe('FAILED');
    expect(t.processingError).toMatch(/Simulated embedding provider failure/);
    expect(t.processingAttempts).toBe(5);
    expect(await prisma.transcriptChunk.count()).toBe(0);

    embedder.failNext = 0;
    expect((await sup.post(`/api/transcripts/${t.id}/reprocess`)).status).toBe(202);
    await flushJobs();
    t = await prisma.transcript.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(t.processingStatus).toBe('COMPLETED');
    expect(t.processingError).toBeNull();
  });

  it('falls back to full-text search when the query embedding fails', async () => {
    await paste(sup, { title: 'CTR class', text: CTR_TRANSCRIPT });
    await flushJobs();
    const embedder = new MockEmbedder();
    embedder.failNext = 1;
    setEmbedder(embedder);
    const hits = await searchTranscripts('click through rate', [], 3);
    expect(hits[0].lessonTitle).toBe('CTR class');
  });
});

describe('managing transcripts', () => {
  it('lists with search, filters and sorting', async () => {
    await paste(sup, { title: 'B: ROAS deep dive', moduleName: 'Module 2', topic: 'Metrics', text: ROAS_TRANSCRIPT });
    await paste(sup, { title: 'A: Retargeting', moduleName: 'Module 3', topic: 'Audiences', text: RETARGETING_TEXT });
    await flushJobs();
    await paste(sup, { title: 'C: CTR', moduleName: 'Module 2', topic: 'Metrics', text: CTR_TRANSCRIPT });
    const titles = async (qs: string) => (await sup.get(`/api/transcripts?${qs}`)).body.items.map((t: { lessonTitle: string }) => t.lessonTitle);
    expect(await titles('sort=title&order=asc')).toEqual(['A: Retargeting', 'B: ROAS deep dive', 'C: CTR']);
    expect(await titles('q=audiences')).toEqual(['A: Retargeting']);
    expect(await titles('module=Module%202&sort=title&order=asc')).toEqual(['B: ROAS deep dive', 'C: CTR']);
    expect(await titles('status=PENDING')).toEqual(['C: CTR']);
    const meta = await sup.get('/api/transcripts/meta');
    expect(meta.body.modules).toEqual(['Module 2', 'Module 3']);
    expect(meta.body.topics).toEqual(['Audiences', 'Metrics']);
    expect(meta.body.statusCounts).toEqual({ COMPLETED: 2, PENDING: 1 });
    expect(JSON.stringify(meta.body)).not.toMatch(/service|key/i);
  });

  it('edits metadata and retrieval shows the new title', async () => {
    const res = await paste(sup, { title: 'Untitled', text: ROAS_TRANSCRIPT });
    await flushJobs();
    const patched = await sup.patch(`/api/transcripts/${res.body.id}`, { title: 'Class 4: ROAS', topic: 'Metrics' });
    expect(patched.status).toBe(200);
    expect(patched.body.storagePath).toBeUndefined();
    expect((await searchTranscripts('ROAS', [], 1))[0].lessonTitle).toBe('Class 4: ROAS');
  });

  it('replacing a file removes old content from retrieval immediately and indexes the new one', async () => {
    const res = await uploadFiles(sup, [{ buf: Buffer.from(ROAS_TRANSCRIPT), name: 'class.txt' }], { title: 'Class 4' });
    await flushJobs();
    const before = await prisma.transcript.findUniqueOrThrow({ where: { id: res.body.results[0].id } });
    expect(await searchTranscripts('ROAS', [], 3)).toHaveLength(1);

    const same = await sup.agent.post(`/api/transcripts/${before.id}/replace`).set('x-csrf-token', sup.csrf).attach('file', Buffer.from(ROAS_TRANSCRIPT), 'class.txt');
    expect(same.status).toBe(409);

    const rep = await sup.agent.post(`/api/transcripts/${before.id}/replace`).set('x-csrf-token', sup.csrf).attach('file', Buffer.from(CTR_TRANSCRIPT), 'class-v2.txt');
    expect(rep.status).toBe(202);
    expect(await searchTranscripts('ROAS', [], 3)).toHaveLength(0); // stale content gone before reprocessing
    await expect(getStorage().get(before.storagePath)).rejects.toThrow(); // old original deleted
    await flushJobs();
    const after = await prisma.transcript.findUniqueOrThrow({ where: { id: before.id } });
    expect(after).toMatchObject({ processingStatus: 'COMPLETED', filename: 'class-v2.txt', lessonTitle: 'Class 4' });
    expect(ids(await searchTranscripts('click through rate', [], 3))).toEqual([before.id]);
    expect(await searchTranscripts('ROAS', [], 3)).toHaveLength(0);
  });

  it('discards a processing result if the file was replaced mid-processing', async () => {
    const res = await paste(sup, { title: 'Race', text: ROAS_TRANSCRIPT });
    const inner = getStorage();
    const racing: FileStorage = {
      name: 'local',
      ensureReady: () => inner.ensureReady(),
      put: (k, d, c) => inner.put(k, d, c),
      delete: (k) => inner.delete(k),
      get: async (k) => {
        const data = await inner.get(k);
        await prisma.transcript.update({ where: { id: res.body.id }, data: { fileHash: 'replaced-meanwhile' } });
        return data;
      },
    };
    setStorage(racing);
    await processTranscript(res.body.id);
    expect(await prisma.transcriptChunk.count()).toBe(0);
  });

  it('deleting removes chunks, the original file and retrieval results but keeps approved answers', async () => {
    const res = await paste(sup, { title: 'CTR class', text: CTR_TRANSCRIPT });
    await flushJobs();
    const t = await prisma.transcript.findUniqueOrThrow({ where: { id: res.body.id } });

    // Produce an approved answer citing this transcript.
    const { mock } = { mock: (await import('../src/messaging/registry.js')).getMockAdapter() };
    await enrollStudent('studentA');
    await inbound(mock, { chatId: 'a@c.us', senderId: 'studentA', text: 'What is CTR?' });
    await flushJobs();
    const job = await prisma.responseJob.findFirstOrThrow();
    expect((job.sourceRefs as { sources: { transcriptId: string }[] }).sources[0].transcriptId).toBe(t.id);
    await sup.post(`/api/responses/${job.id}/approve`, { reusable: true });

    expect((await sup.agent.delete(`/api/transcripts/${t.id}`).set('x-csrf-token', sup.csrf)).status).toBe(200);
    expect(await prisma.transcriptChunk.count()).toBe(0);
    expect(await searchTranscripts('click through rate', [], 3)).toHaveLength(0);
    await expect(getStorage().get(t.storagePath)).rejects.toThrow();
    const ex = await prisma.approvedAnswerExample.findFirstOrThrow();
    expect((ex.transcriptSources as { lessonTitle: string }[])[0].lessonTitle).toBe('CTR class');
  });

  it('re-embed all queues every processed transcript', async () => {
    await paste(sup, { title: 'One', text: ROAS_TRANSCRIPT });
    await paste(sup, { title: 'Two', text: CTR_TRANSCRIPT });
    await flushJobs();
    setEmbedder(new MockEmbedder());
    const r = await sup.post('/api/transcripts/reembed-all');
    expect(r.body.queued).toBe(2);
    await flushJobs();
    const all = await prisma.transcript.findMany();
    expect(all.every((t) => t.embeddedChunkCount === t.chunkCount && t.chunkCount > 0)).toBe(true);
  });
});

describe('permissions', () => {
  it('only super admins manage course materials; all admins can browse; anonymous users get nothing', async () => {
    const res = await paste(sup, { title: 'CTR', text: CTR_TRANSCRIPT });
    const id = res.body.id;
    for (const role of ['REVIEWER', 'VIEWER'] as const) {
      const s = await login(role);
      expect((await s.get('/api/transcripts')).status).toBe(200);
      expect((await paste(s, { title: 'x', text: 'y' })).status).toBe(403);
      expect((await uploadFiles(s, [{ buf: Buffer.from('hello'), name: 'a.txt' }])).status).toBe(403);
      expect((await s.patch(`/api/transcripts/${id}`, { title: 'hack' })).status).toBe(403);
      expect((await s.post(`/api/transcripts/${id}/reprocess`)).status).toBe(403);
      expect((await s.agent.post(`/api/transcripts/${id}/replace`).set('x-csrf-token', s.csrf).attach('file', Buffer.from('z'), 'z.txt')).status).toBe(403);
      expect((await s.agent.delete(`/api/transcripts/${id}`).set('x-csrf-token', s.csrf)).status).toBe(403);
    }
    expect((await request(app).get('/api/transcripts')).status).toBe(401);
    expect((await request(app).post('/api/transcripts/text').send({ title: 'x', text: 'y' })).status).toBe(401);
    // CSRF token required for mutations even with a valid session.
    expect((await sup.agent.post('/api/transcripts/text').send({ title: 'x', text: 'y' })).status).toBe(403);
    expect(await prisma.transcript.count()).toBe(1);
  });
});

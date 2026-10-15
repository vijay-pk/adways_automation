import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import type { MockTutorAI } from '../src/ai/mock.js';
import type { MockMessagingAdapter } from '../src/messaging/mockAdapter.js';
import { validateAnswer } from '../src/ai/validateAnswer.js';
import { buildGeneratePrompt } from '../src/ai/prompts.js';
import { CTR_TRANSCRIPT, enrollStudent, flushJobs, inbound, login, ROAS_TRANSCRIPT, seedTranscript, setupWorld } from './helpers.js';

let ai: MockTutorAI;
let mock: MockMessagingAdapter;

beforeEach(async () => {
  ({ ai, mock } = await setupWorld({ settings: { auto_reply_enabled: false } }));
  await enrollStudent('studentA');
  await enrollStudent('studentB');
  await seedTranscript(CTR_TRANSCRIPT, { moduleName: 'Module 1', lessonTitle: 'CTR basics' });
  await seedTranscript(ROAS_TRANSCRIPT, { moduleName: 'Module 2', lessonTitle: 'ROAS' });
});

async function ask(senderId: string, text: string) {
  await inbound(mock, { chatId: `${senderId}@c.us`, senderId, text });
  await flushJobs();
  return prisma.responseJob.findFirstOrThrow({ where: { senderExternalId: senderId }, orderBy: { createdAt: 'desc' } });
}

const SIMPLE_CTR = 'CTR in simple words: out of everyone who sees your ad, how many click it. 10 clicks from 1,000 views is 1%.';

describe('Approved Answer Memory', () => {
  it('#12 rejected answers are never added to reusable memory', async () => {
    const reviewer = await login('REVIEWER');
    const job = await ask('studentA', 'What is CTR?');
    await reviewer.post(`/api/responses/${job.id}/reject`, { notes: 'too technical' });
    expect(await prisma.approvedAnswerExample.count()).toBe(0);
    const next = await ask('studentB', 'Explain click-through rate in simple words');
    expect(next.exampleIdsUsed).toEqual([]);
  });

  it('approved answers are private by default and not reused until marked reusable', async () => {
    const reviewer = await login('REVIEWER');
    const job = await ask('studentA', 'What is CTR?');
    await reviewer.post(`/api/responses/${job.id}/approve`, { editedAnswer: SIMPLE_CTR });
    const ex = await prisma.approvedAnswerExample.findFirstOrThrow();
    expect(ex.reusable).toBe(false);
    const next = await ask('studentB', 'Explain click-through rate in simple words');
    expect(next.exampleIdsUsed).toEqual([]);
    // Opt in, then it is retrieved.
    await reviewer.patch(`/api/memory/${ex.id}`, { reusable: true });
    const third = await ask('studentA', 'click through rate meaning?');
    expect(third.exampleIdsUsed).toEqual([ex.id]);
  });

  it('#13 approved examples influence relevant future drafts', async () => {
    const reviewer = await login('REVIEWER');
    const job = await ask('studentA', 'What is CTR?');
    await reviewer.post(`/api/responses/${job.id}/approve`, { editedAnswer: SIMPLE_CTR, reusable: true, topicTags: ['CTR'] });
    await flushJobs();

    const later = await ask('studentB', 'Explain click-through rate in simple words.');
    const ex = await prisma.approvedAnswerExample.findFirstOrThrow();
    expect(later.exampleIdsUsed).toEqual([ex.id]);
    const gen = ai.generateCalls.at(-1)!;
    expect(gen.examples[0].answer).toBe(SIMPLE_CTR);
    // Transcripts remain the source of course facts alongside the example.
    expect(gen.passages[0].lessonTitle).toBe('CTR basics');
    expect(later.draftAnswer).toContain('CTR in simple words');
    // The prompt for real providers carries the example as a labelled reference.
    const prompt = buildGeneratePrompt(gen);
    expect(prompt.user).toContain('<example ref="E1"');
    expect(prompt.user).toContain(SIMPLE_CTR);

    // Influence tracking is visible in the memory API.
    const detail = await reviewer.get(`/api/memory/${ex.id}`);
    expect(detail.body.influencedJobs.map((j: { id: string }) => j.id)).toContain(later.id);
    // Disabled examples stop influencing drafts.
    await reviewer.patch(`/api/memory/${ex.id}`, { enabled: false });
    const after = await ask('studentA', 'click-through rate simple explanation');
    expect(after.exampleIdsUsed).toEqual([]);
  });

  it('#14 newer corrections take precedence over stale examples', async () => {
    const reviewer = await login('REVIEWER');
    const first = await ask('studentA', 'What is CTR?');
    await reviewer.post(`/api/responses/${first.id}/approve`, { editedAnswer: 'OLD: CTR is impressions divided by clicks.', reusable: true });
    await flushJobs();
    const second = await ask('studentB', 'What is CTR?');
    await reviewer.post(`/api/responses/${second.id}/approve`, { editedAnswer: 'CORRECTED: CTR is clicks divided by impressions.', reusable: true });
    await flushJobs();

    await ask('studentA', 'Explain CTR please');
    const gen = ai.generateCalls.at(-1)!;
    const answers = gen.examples.map((e) => e.answer);
    expect(answers).toContain('CORRECTED: CTR is clicks divided by impressions.');
    expect(answers).not.toContain('OLD: CTR is impressions divided by clicks.');
  });

  it('records draft vs final edits and exposes correction patterns', async () => {
    const reviewer = await login('REVIEWER');
    const job = await ask('studentA', 'What is CTR?');
    await reviewer.post(`/api/responses/${job.id}/approve`, { editedAnswer: 'Short: clicks / impressions. Example: 10 / 1000 = 1%.' });
    const ex = await prisma.approvedAnswerExample.findFirstOrThrow();
    expect(ex.wasEdited).toBe(true);
    expect(ex.originalDraft).toBe(job.draftAnswer);
    expect((ex.editSummary as { categories: string[] }).categories).toContain('shortened');
    const patterns = await reviewer.get('/api/memory/patterns');
    expect(patterns.status).toBe(200);
    expect(patterns.body.editedExamples).toBe(1);
  });
});

describe('citations and evidence', () => {
  it('#15 transcript citations point to real source records', async () => {
    const job = await ask('studentA', 'What is ROAS?');
    const sources = (job.sourceRefs as { sources: { chunkId: string; transcriptId: string; lessonTitle: string; timestampStart: string }[] }).sources;
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) {
      const chunk = await prisma.transcriptChunk.findUniqueOrThrow({ where: { id: s.chunkId }, include: { transcript: true } });
      expect(chunk.transcriptId).toBe(s.transcriptId);
      expect(chunk.transcript.lessonTitle).toBe(s.lessonTitle);
      expect(chunk.timestampStart).toBe(s.timestampStart);
    }
    // Sources are tracked for the reviewer (above), but never printed in the student-facing answer.
    expect(job.draftAnswer).not.toMatch(/Sources:/);
  });

  it('#15b invented citation refs are dropped by validation', () => {
    const passages = [
      { ref: 'S1', chunkId: 'c1', transcriptId: 't1', filename: 'f.txt', moduleName: 'M1', lessonTitle: 'L1', timestampStart: '00:01:00', timestampEnd: null, content: 'x', rank: 1 },
    ];
    const v = validateAnswer({ answer: 'Answer [S1] [S7]', sourceRefs: ['S1', 'S7'], evidenceSufficient: true, confidence: 0.9 }, passages, 1500);
    expect(v.sources.map((s) => s.ref)).toEqual(['S1']);
    expect(v.issues.join(' ')).toMatch(/S7/);
    expect(v.text).not.toContain('[S7]');
  });

  it('#16 missing transcript evidence still yields a clean best-effort answer held for review', async () => {
    const job = await ask('studentA', 'How do I bake sourdough bread?');
    expect(job.evidenceSufficient).toBe(false);
    expect(job.retrievedChunkIds).toEqual([]);
    expect(job.draftAnswer).toBeTruthy();
    // No disclaimer or sources leak into the student-facing answer; it reads like a tutor reply.
    expect(job.draftAnswer).not.toMatch(/course material|transcript|Sources:/i);
    expect(job.status).toBe('PENDING_APPROVAL');

    const v = validateAnswer({ answer: 'Bread needs flour.', sourceRefs: [], evidenceSufficient: true, confidence: 0.9 }, [], 1500);
    expect(v.evidenceSufficient).toBe(false);
    expect(v.text).toBe('Bread needs flour.');
    expect(v.confidence).toBeLessThanOrEqual(0.3);
  });

  it('enforces the maximum response length', () => {
    const passages = [{ ref: 'S1', chunkId: 'c', transcriptId: 't', filename: 'f', moduleName: 'M', lessonTitle: 'L', timestampStart: null, timestampEnd: null, content: 'x', rank: 1 }];
    const long = 'This is a sentence about ROAS. '.repeat(100);
    const v = validateAnswer({ answer: long, sourceRefs: ['S1'], evidenceSufficient: true, confidence: 0.8 }, passages, 300);
    expect(v.text.length).toBeLessThanOrEqual(300);
  });
});

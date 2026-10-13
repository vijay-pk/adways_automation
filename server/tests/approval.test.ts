import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import type { MockTutorAI } from '../src/ai/mock.js';
import type { MockMessagingAdapter } from '../src/messaging/mockAdapter.js';
import { updateSettings } from '../src/settings/settingsService.js';
import { claimNext, recoverStaleJobs } from '../src/jobs/queue.js';
import { runDueJobs } from '../src/jobs/worker.js';
import { activateAdapter } from '../src/messaging/registry.js';
import { CTR_TRANSCRIPT, enrollStudent, flushJobs, inbound, login, ROAS_TRANSCRIPT, seedTranscript, setupWorld } from './helpers.js';

let ai: MockTutorAI;
let mock: MockMessagingAdapter;

beforeEach(async () => {
  ({ ai, mock } = await setupWorld({ settings: { auto_reply_enabled: false } }));
  await enrollStudent('studentA');
  await seedTranscript(CTR_TRANSCRIPT, { moduleName: 'Module 1', lessonTitle: 'CTR basics' });
  await seedTranscript(ROAS_TRANSCRIPT, { moduleName: 'Module 2', lessonTitle: 'ROAS' });
});

async function pendingJob(text = 'What is CTR?') {
  await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text });
  await flushJobs();
  return prisma.responseJob.findFirstOrThrow({ where: { status: 'PENDING_APPROVAL' }, orderBy: { createdAt: 'desc' } });
}

describe('automatic mode', () => {
  it('#8 automatic mode sends a validated answer with sources and records usage', async () => {
    await updateSettings({ auto_reply_enabled: true }, null);
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'What is CTR?' });
    await flushJobs();
    const job = await prisma.responseJob.findFirstOrThrow({ include: { delivery: true } });
    expect(job.status).toBe('SENT');
    expect(job.autoApproved).toBe(true);
    expect(job.delivery?.status).toBe('SENT');
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0].text).toBe(job.approvedAnswer);
    expect(mock.outbox[0].text).toMatch(/Sources: Module 1 – CTR basics \(00:02:00\)/);
    expect(await prisma.aiUsage.count({ where: { responseJobId: job.id } })).toBe(2);
    // Auto-sent answers are never promoted to Approved Answer Memory.
    expect(await prisma.approvedAnswerExample.count()).toBe(0);
  });

  it('auto mode holds answers without transcript evidence for review', async () => {
    await updateSettings({ auto_reply_enabled: true }, null);
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'How do I bake sourdough bread?' });
    await flushJobs();
    const job = await prisma.responseJob.findFirstOrThrow();
    expect(job.status).toBe('PENDING_APPROVAL');
    expect(mock.outbox).toHaveLength(0);
  });
});

describe('approval mode', () => {
  it('#9 approval mode sends nothing before approval', async () => {
    const job = await pendingJob();
    expect(job.draftAnswer).toBeTruthy();
    expect(mock.outbox).toHaveLength(0);
    expect(await prisma.messageDelivery.count()).toBe(0);
    expect(await prisma.job.count({ where: { type: 'deliverMessage' } })).toBe(0);
  });

  it('#10 approval sends the exact edited answer and keeps the original draft', async () => {
    const job = await pendingJob();
    const reviewer = await login('REVIEWER');
    const edited = 'CTR means the share of people who clicked after seeing your ad. 10 clicks / 1,000 views = 1%.';
    const res = await reviewer.post(`/api/responses/${job.id}/approve`, { editedAnswer: edited, reusable: true });
    expect(res.status).toBe(200);
    await flushJobs();
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0].text).toBe(edited);
    const after = await prisma.responseJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('SENT');
    expect(after.approvedAnswer).toBe(edited);
    expect(after.draftAnswer).toBe(job.draftAnswer);
    expect(after.approvedById).toBe(reviewer.admin.id);
    const ex = await prisma.approvedAnswerExample.findFirstOrThrow();
    expect(ex.originalDraft).toBe(job.draftAnswer);
    expect(ex.approvedAnswer).toBe(edited);
    expect(ex.wasEdited).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: 'response.edit_approve' } })).toBe(1);
  });

  it('#11 repeated and concurrent approval clicks do not send duplicates', async () => {
    const job = await pendingJob();
    const reviewer = await login('REVIEWER');
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => reviewer.post(`/api/responses/${job.id}/approve`, {})));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    const again = await reviewer.post(`/api/responses/${job.id}/approve`, {});
    expect(again.status).toBe(409);
    await flushJobs();
    await flushJobs();
    expect(mock.outbox).toHaveLength(1);
    expect(await prisma.messageDelivery.count()).toBe(1);
  });

  it('#17 unauthorized administrators cannot approve messages', async () => {
    const job = await pendingJob();
    const viewer = await login('VIEWER');
    expect((await viewer.post(`/api/responses/${job.id}/approve`, {})).status).toBe(403);
    // Missing CSRF token is rejected even for a reviewer.
    const reviewer = await login('REVIEWER');
    expect((await reviewer.agent.post(`/api/responses/${job.id}/approve`).send({})).status).toBe(403);
    // Unauthenticated
    const { default: request } = await import('supertest');
    const { app } = await import('./helpers.js');
    expect((await request(app).post(`/api/responses/${job.id}/approve`).send({})).status).toBe(401);
    await flushJobs();
    expect(mock.outbox).toHaveLength(0);
    expect((await prisma.responseJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('PENDING_APPROVAL');
  });

  it('reject, mark-reviewed and regenerate never send', async () => {
    const reviewer = await login('REVIEWER');
    const j1 = await pendingJob('What is CTR?');
    expect((await reviewer.post(`/api/responses/${j1.id}/regenerate`, { hint: 'simpler' })).status).toBe(200);
    expect(await prisma.responseDraft.count({ where: { responseJobId: j1.id } })).toBe(2);
    expect((await reviewer.post(`/api/responses/${j1.id}/request-evidence`, {})).status).toBe(200);
    expect(ai.generateCalls.at(-1)!.passages.length).toBeGreaterThan(0);
    expect((await reviewer.post(`/api/responses/${j1.id}/reject`, { notes: 'wrong' })).status).toBe(200);
    expect((await reviewer.post(`/api/responses/${j1.id}/approve`, {})).status).toBe(409);
    const j2 = await pendingJob('What is ROAS?');
    expect((await reviewer.post(`/api/responses/${j2.id}/mark-reviewed`, {})).status).toBe(200);
    await flushJobs();
    expect(mock.outbox).toHaveLength(0);
  });
});

describe('reliability', () => {
  it('#19 a disconnected worker/session does not lose queued jobs', async () => {
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'What is CTR?' });
    await prisma.job.updateMany({ data: { runAt: new Date(Date.now() - 1000) } });
    const claimed = await claimNext(); // worker claims the job, then "crashes"
    expect(claimed?.status).toBe('RUNNING');
    expect(await runDueJobs()).toBe(0); // nothing else due
    expect(await recoverStaleJobs(0)).toBe(1);
    await flushJobs();
    expect(await prisma.responseJob.count({ where: { status: 'PENDING_APPROVAL' } })).toBe(1);
  });

  it('#19b messaging disconnection keeps approved messages queued until reconnect', async () => {
    const job = await pendingJob();
    await mock.disconnect();
    const reviewer = await login('REVIEWER');
    await reviewer.post(`/api/responses/${job.id}/approve`, {});
    await flushJobs(1);
    expect(mock.outbox).toHaveLength(0);
    let state = await prisma.responseJob.findUniqueOrThrow({ where: { id: job.id }, include: { delivery: true } });
    expect(state.status).toBe('APPROVED'); // will be retried with backoff
    expect(state.delivery?.lastError).toMatch(/disconnected/);
    await mock.connect();
    await flushJobs();
    state = await prisma.responseJob.findUniqueOrThrow({ where: { id: job.id }, include: { delivery: true } });
    expect(state.status).toBe('SENT');
    expect(mock.outbox).toHaveLength(1);
  });

  it('#20 provider failures are logged and safely recoverable', async () => {
    // AI provider failure: job is kept as FAILED with the error, then regenerated.
    ai.failNext = 1;
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'What is CTR?' });
    await flushJobs();
    const failed = await prisma.responseJob.findFirstOrThrow();
    expect(failed.status).toBe('FAILED');
    expect(failed.lastError).toMatch(/Simulated AI provider failure/);
    const reviewer = await login('REVIEWER');
    expect((await reviewer.post(`/api/responses/${failed.id}/regenerate`, {})).status).toBe(200);
    expect((await prisma.responseJob.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe('PENDING_APPROVAL');

    // Messaging provider failure on every attempt: FAILED after max attempts, approval kept, safe retry.
    mock.failNextSends = 5;
    await reviewer.post(`/api/responses/${failed.id}/approve`, {});
    await flushJobs(10);
    const afterFail = await prisma.responseJob.findUniqueOrThrow({ where: { id: failed.id }, include: { delivery: true } });
    expect(afterFail.status).toBe('FAILED');
    expect(afterFail.approvedAt).not.toBeNull();
    expect(afterFail.delivery?.attempts).toBe(5);
    expect(afterFail.delivery?.lastError).toMatch(/Simulated provider failure/);
    expect(mock.outbox).toHaveLength(0);
    expect((await reviewer.post(`/api/responses/${failed.id}/retry-delivery`, {})).status).toBe(200);
    await flushJobs();
    expect(mock.outbox).toHaveLength(1);
    expect((await reviewer.post(`/api/responses/${failed.id}/retry-delivery`, {})).status).toBe(409);
  });

  it('#21 the emergency stop prevents outgoing messages and takes effect immediately', async () => {
    await updateSettings({ auto_reply_enabled: true }, null);
    const reviewer = await login('REVIEWER');
    const res = await reviewer.post('/api/settings/emergency', { pause_all_outgoing: true });
    expect(res.status).toBe(200);
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'What is CTR?' });
    await flushJobs();
    expect(mock.outbox).toHaveLength(0);
    // Approved-before-pause messages are also held.
    const job = await prisma.responseJob.findFirstOrThrow();
    await reviewer.post(`/api/responses/${job.id}/approve`, {});
    await flushJobs();
    expect(mock.outbox).toHaveLength(0);
    // Reviewers cannot lift the stop; super admins can.
    expect((await reviewer.post('/api/settings/emergency', { pause_all_outgoing: false })).status).toBe(400);
    const sup = await login('SUPER_ADMIN');
    expect((await sup.post('/api/settings/emergency', { pause_all_outgoing: false })).status).toBe(200);
    await flushJobs();
    expect(mock.outbox).toHaveLength(1);
  });

  it('pausing group replies blocks only groups; stopping connection blocks everything', async () => {
    const sup = await login('SUPER_ADMIN');
    await sup.post('/api/settings/emergency', { messaging_connection_enabled: false });
    expect((await mock.getStatus()).state).toBe('disconnected');
    await sup.post('/api/settings/emergency', { messaging_connection_enabled: true });
    expect((await mock.getStatus()).state).toBe('connected');
    await activateAdapter('mock');
  });
});

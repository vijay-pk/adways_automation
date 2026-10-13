import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/db/prisma.js';
import type { MockMessagingAdapter } from '../src/messaging/mockAdapter.js';
import { app, CTR_TRANSCRIPT, enrollStudent, flushJobs, inbound, login, seedTranscript, setupWorld } from './helpers.js';

let mock: MockMessagingAdapter;

beforeEach(async () => {
  ({ mock } = await setupWorld({ settings: { auto_reply_enabled: false } }));
  await enrollStudent('studentA');
  await seedTranscript(CTR_TRANSCRIPT, { moduleName: 'Module 1', lessonTitle: 'CTR basics' });
});

async function approvedJob() {
  await inbound(mock, { chatId: 'a@c.us', senderId: 'studentA', text: 'What is CTR?' });
  await flushJobs();
  const job = await prisma.responseJob.findFirstOrThrow();
  const reviewer = await login('REVIEWER');
  expect((await reviewer.post(`/api/responses/${job.id}/approve`, {})).status).toBe(200);
  return job;
}

describe('delivery safety', () => {
  it('never re-sends when recording a successful send fails', async () => {
    const job = await approvedJob();
    const original = mock.sendMessage.bind(mock);
    mock.sendMessage = async (dest, text) => {
      const r = await original(dest, text);
      // Simulate the database write failing right after the provider accepted the message.
      await prisma.messageDelivery.deleteMany({ where: { responseJobId: job.id } });
      return r;
    };
    await flushJobs(10);
    expect(mock.outbox).toHaveLength(1);
    expect((await prisma.responseJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SENDING');
  });

  it('audits successful sends and final failures', async () => {
    await approvedJob();
    await flushJobs();
    const sent = await prisma.auditLog.findFirstOrThrow({ where: { action: 'message.sent' } });
    expect(sent.metadata).toMatchObject({ chatType: 'PRIVATE', autoApproved: false });

    await enrollStudent('studentB');
    mock.failNextSends = 5;
    await inbound(mock, { chatId: 'b@c.us', senderId: 'studentB', text: 'What is CTR?' });
    await flushJobs();
    const job = await prisma.responseJob.findFirstOrThrow({ where: { senderExternalId: 'studentB' } });
    const reviewer = await login('REVIEWER');
    await reviewer.post(`/api/responses/${job.id}/approve`, {});
    await flushJobs(10);
    expect(await prisma.auditLog.count({ where: { action: 'message.send_retrying' } })).toBe(4);
    expect(await prisma.auditLog.count({ where: { action: 'message.send_failed' } })).toBe(1);
  });
});

describe('administrator removal', () => {
  it('super admins can remove admins but not themselves or the last super admin', async () => {
    const sup = await login('SUPER_ADMIN');
    const reviewer = await login('REVIEWER');
    expect((await reviewer.agent.delete(`/api/admin/admins/${sup.admin.id}`).set('x-csrf-token', reviewer.csrf)).status).toBe(403);
    expect((await sup.agent.delete(`/api/admin/admins/${sup.admin.id}`).set('x-csrf-token', sup.csrf)).status).toBe(400);
    const res = await sup.agent.delete(`/api/admin/admins/${reviewer.admin.id}`).set('x-csrf-token', sup.csrf);
    expect(res.status).toBe(200);
    expect(await prisma.administrator.findUnique({ where: { id: reviewer.admin.id } })).toBeNull();
    // Their session no longer works and the audit trail survives.
    expect((await reviewer.get('/api/dashboard')).status).toBe(401);
    expect(await prisma.auditLog.count({ where: { action: 'admin.delete', resourceId: reviewer.admin.id } })).toBe(1);
  });
});

describe('health', () => {
  it('public health reports database status without auth; integration health requires login', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body).toEqual({ ok: true, db: 'ok' });
    expect((await request(app).get('/api/admin/health')).status).toBe(401);
    const viewer = await login('VIEWER');
    const h = await viewer.get('/api/admin/health');
    expect(h.status).toBe(200);
    const names = h.body.checks.map((c: { name: string }) => c.name);
    expect(names).toEqual(['database', 'ai_generation', 'embeddings', 'file_storage', 'messaging', 'job_queue']);
    expect(h.body.checks.find((c: { name: string }) => c.name === 'database').ok).toBe(true);
    expect(JSON.stringify(h.body)).not.toMatch(/Bearer|service_role|apiKey/i);
  });
});

describe('unicode', () => {
  it('stores and answers non-Latin student messages (Hindi, Malayalam)', async () => {
    await inbound(mock, { chatId: 'a@c.us', senderId: 'studentA', text: 'CTR क्या है? → സിടിആർ എന്താണ്?' });
    await flushJobs();
    const msg = await prisma.incomingMessage.findFirstOrThrow();
    expect(msg.content).toBe('CTR क्या है? → സിടിആർ എന്താണ്?');
    expect(await prisma.responseJob.count({ where: { status: 'PENDING_APPROVAL' } })).toBe(1);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import type { MockMessagingAdapter } from '../src/messaging/mockAdapter.js';
import { FULL_CAPABILITIES } from '../src/messaging/mockAdapter.js';
import { getSettings, updateSettings } from '../src/settings/settingsService.js';
import { getActiveAdapter } from '../src/messaging/registry.js';
import { CTR_TRANSCRIPT, enableGroup, enrollStudent, flushJobs, inbound, login, seedTranscript, setupWorld } from './helpers.js';

let mock: MockMessagingAdapter;

beforeEach(async () => {
  ({ mock } = await setupWorld({ settings: { auto_reply_enabled: false } }));
  await enrollStudent('studentA');
  await seedTranscript(CTR_TRANSCRIPT, { moduleName: 'Module 1', lessonTitle: 'CTR basics' });
});

describe('adapter switching and capabilities', () => {
  it('#22 switching adapters preserves the database and approved-answer records', async () => {
    const sup = await login('SUPER_ADMIN');
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'What is CTR?' });
    await flushJobs();
    const job = await prisma.responseJob.findFirstOrThrow();
    await sup.post(`/api/responses/${job.id}/approve`, { editedAnswer: 'CTR = clicks / impressions.', reusable: true });
    await flushJobs();
    const before = {
      examples: await prisma.approvedAnswerExample.findMany(),
      transcripts: await prisma.transcript.count(),
      chunks: await prisma.transcriptChunk.count(),
      admins: await prisma.administrator.count(),
      jobs: await prisma.responseJob.count(),
    };

    await sup.patch('/api/settings', { cloud_api_policy_acknowledged: true });
    const res = await sup.patch('/api/settings', { messaging_adapter: 'whatsapp_cloud' });
    expect(res.status).toBe(200);
    expect(getActiveAdapter()?.name).toBe('whatsapp_cloud');

    expect(await prisma.approvedAnswerExample.findMany()).toEqual(before.examples);
    expect(await prisma.transcript.count()).toBe(before.transcripts);
    expect(await prisma.transcriptChunk.count()).toBe(before.chunks);
    expect(await prisma.administrator.count()).toBe(before.admins);
    expect(await prisma.responseJob.count()).toBe(before.jobs);
    expect((await getSettings()).messaging_adapter).toBe('whatsapp_cloud');

    // Switching back works and the mock channel resumes.
    expect((await sup.patch('/api/settings', { messaging_adapter: 'mock' })).status).toBe(200);
    expect(getActiveAdapter()?.name).toBe('mock');
  });

  it('#23 unsupported group capabilities are reported accurately', async () => {
    const sup = await login('SUPER_ADMIN');
    await sup.patch('/api/settings', { cloud_api_policy_acknowledged: true, messaging_adapter: 'whatsapp_cloud' });
    const res = await sup.get('/api/settings/messaging');
    expect(res.body.adapter).toBe('whatsapp_cloud');
    expect(res.body.status.state).toBe('not_configured');
    expect(res.body.capabilities.receiveGroupMessages).toBe(false);
    expect(res.body.capabilities.sendGroupMessages).toBe(false);
    expect(res.body.capabilities.nativeMentions).toBe(false);
    expect(res.body.capabilities.notes.join(' ')).toMatch(/groups/i);
    expect(res.body.lastError).toMatch(/not configured/i);
    expect(res.body.webChat.capabilities.sendPrivateMessages).toBe(true);
  });

  it('#23b an adapter without group send capability fails group delivery visibly, never silently', async () => {
    ({ mock } = await setupWorld({
      capabilities: { ...FULL_CAPABILITIES, sendGroupMessages: false },
      settings: { auto_reply_enabled: true },
    }));
    await enrollStudent('studentA');
    await seedTranscript(CTR_TRANSCRIPT, { moduleName: 'Module 1', lessonTitle: 'CTR basics' });
    await enableGroup('g@g.us');
    await inbound(mock, { chatId: 'g@g.us', chatType: 'GROUP', senderId: 'studentA', text: '@CourseAI what is CTR?', mention: true });
    await flushJobs();
    const job = await prisma.responseJob.findFirstOrThrow({ include: { delivery: true } });
    expect(job.status).toBe('FAILED');
    expect(job.lastError).toMatch(/cannot send group messages/);
    expect(mock.outbox).toHaveLength(0);
  });

  it('an adapter without native mentions never treats group text as an invocation', async () => {
    ({ mock } = await setupWorld({ capabilities: { ...FULL_CAPABILITIES, nativeMentions: false }, settings: { auto_reply_enabled: true } }));
    await enrollStudent('studentA');
    await enableGroup('g@g.us');
    await inbound(mock, { chatId: 'g@g.us', chatType: 'GROUP', senderId: 'studentA', text: '@CourseAI what is CTR?', mention: true });
    await flushJobs();
    expect(await prisma.responseJob.count()).toBe(0);
  });

  it('the experimental WhatsApp Web adapter is not falsely offered', async () => {
    const sup = await login('SUPER_ADMIN');
    await sup.patch('/api/settings', { whatsapp_web_risk_acknowledged: true });
    const res = await sup.patch('/api/settings', { messaging_adapter: 'whatsapp_web' });
    expect(res.status).toBe(400);
    expect(getActiveAdapter()?.name).toBe('mock');
  });
});

describe('compliance', () => {
  it('#24 prohibited data-use features cannot be activated', async () => {
    const sup = await login('SUPER_ADMIN');
    const res = await sup.patch('/api/settings', { platform_data_ai_training_allowed: true });
    expect(res.status).toBe(400);
    expect((await getSettings()).platform_data_ai_training_allowed).toBe(false);
    await expect(updateSettings({ platform_data_ai_training_allowed: true }, null)).rejects.toThrow();
    // Even a tampered DB row is ignored in favour of the locked default.
    await prisma.applicationSetting.upsert({
      where: { key: 'platform_data_ai_training_allowed' },
      create: { key: 'platform_data_ai_training_allowed', value: true },
      update: { value: true },
    });
    expect((await getSettings()).platform_data_ai_training_allowed).toBe(false);
  });

  it('#24b the official adapter cannot be enabled before the policy checklist is acknowledged', async () => {
    const sup = await login('SUPER_ADMIN');
    const res = await sup.patch('/api/settings', { messaging_adapter: 'whatsapp_cloud' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/policy/i);
    expect((await getSettings()).messaging_adapter).toBe('mock');
  });

  it('only super admins can change settings; viewers are read-only', async () => {
    const reviewer = await login('REVIEWER');
    expect((await reviewer.patch('/api/settings', { auto_reply_enabled: true })).status).toBe(403);
    const viewer = await login('VIEWER');
    expect((await viewer.get('/api/settings')).status).toBe(200);
    expect((await viewer.post('/api/settings/emergency', { pause_all_outgoing: true })).status).toBe(403);
  });
});

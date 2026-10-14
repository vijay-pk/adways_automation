import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import type { MockTutorAI } from '../src/ai/mock.js';
import type { MockMessagingAdapter } from '../src/messaging/mockAdapter.js';
import { updateSettings } from '../src/settings/settingsService.js';
import {
  CTR_TRANSCRIPT,
  enableGroup,
  enrollStudent,
  flushJobs,
  inbound,
  minutesAgo,
  ROAS_TRANSCRIPT,
  seedTranscript,
  setStudentStatus,
  setupWorld,
  TRACKING_TRANSCRIPT,
} from './helpers.js';

const GROUP = 'group-1@g.us';
let ai: MockTutorAI;
let mock: MockMessagingAdapter;

beforeEach(async () => {
  ({ ai, mock } = await setupWorld({ settings: { auto_reply_enabled: true } }));
  await enableGroup(GROUP);
  await enrollStudent('studentA');
  await enrollStudent('studentB');
  await seedTranscript(ROAS_TRANSCRIPT, { moduleName: 'Module 2', lessonTitle: 'ROAS' });
  await seedTranscript(CTR_TRANSCRIPT, { moduleName: 'Module 1', lessonTitle: 'CTR basics' });
  await seedTranscript(TRACKING_TRANSCRIPT, { moduleName: 'Module 3', lessonTitle: 'Tracking' });
});

const jobs = () => prisma.responseJob.findMany({ orderBy: { createdAt: 'asc' } });

describe('group routing', () => {
  it('#1 group messages without a mention never produce replies', async () => {
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'studentA', text: 'Can someone explain how to calculate ROAS?' });
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'studentB', text: 'CourseAI what is CTR?' }); // name in text is not a mention
    await flushJobs();
    expect(await jobs()).toHaveLength(0);
    expect(await prisma.job.count()).toBe(0);
    expect(mock.outbox).toHaveLength(0);
    const msgs = await prisma.incomingMessage.findMany();
    expect(msgs.every((m) => m.processingStatus === 'CONTEXT_ONLY')).toBe(true);
  });

  it('#2 a genuine native mention triggers question processing and one reply', async () => {
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'studentA', text: '@CourseAI what is ROAS?', mention: true });
    await flushJobs();
    const all = await jobs();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('SENT');
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0].destination.chatId).toBe(GROUP);
    expect(mock.outbox[0].text).toMatch(/ROAS/);
  });

  it('#3 a question followed by a bare mention is understood as one question', async () => {
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'studentA', text: 'Can someone explain how to calculate ROAS?', at: minutesAgo(2) });
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'studentA', text: '@CourseAI', mention: true, at: minutesAgo(1) });
    await flushJobs();
    const all = await jobs();
    expect(all).toHaveLength(1);
    expect(all[0].contextMessageIds).toHaveLength(2);
    expect(all[0].normalizedQuestion).toMatch(/calculate ROAS/);
    expect(mock.outbox).toHaveLength(1);
  });

  it('#3b question + mention with extra request yields a single combined answer', async () => {
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'studentA', text: 'What is conversion tracking?', at: minutesAgo(1) });
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'studentA', text: '@CourseAI please explain with an example.', mention: true });
    await flushJobs();
    const all = await jobs();
    expect(all).toHaveLength(1);
    expect(all[0].normalizedQuestion).toMatch(/conversion tracking.*example/i);
    expect(mock.outbox).toHaveLength(1);
  });

  it('#4/#5 context uses only the same sender in the same group (ROAS example)', async () => {
    const otherGroup = 'group-2@g.us';
    await enableGroup(otherGroup);
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'studentA', text: 'What is ROAS?', at: minutesAgo(3) });
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'studentB', text: 'Has anyone finished the assignment?', at: minutesAgo(2.5) });
    await inbound(mock, { chatId: otherGroup, chatType: 'GROUP', senderId: 'studentA', text: 'Unrelated message in another group', at: minutesAgo(2.2) });
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'studentA', text: "I don't understand the formula.", at: minutesAgo(2) });
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'studentA', text: '@CourseAI explain with numbers.', mention: true, at: minutesAgo(1) });
    await flushJobs();

    const all = await jobs();
    expect(all).toHaveLength(1);
    const ctx = await prisma.incomingMessage.findMany({ where: { id: { in: all[0].contextMessageIds } }, orderBy: { timestamp: 'asc' } });
    expect(ctx.map((m) => m.content)).toEqual(['What is ROAS?', "I don't understand the formula.", '@CourseAI explain with numbers.']);
    expect(ctx.every((m) => m.senderExternalId === 'studentA')).toBe(true);
    // The AI never saw Student B's message or the other group's message.
    const sent = JSON.stringify(ai.correlateCalls.at(-1));
    expect(sent).not.toContain('assignment');
    expect(sent).not.toContain('another group');
    expect(mock.outbox).toHaveLength(1);
  });

  it('excludes same-sender messages outside the configured time window', async () => {
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'studentA', text: 'Old question about budgets', at: minutesAgo(30) });
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'studentA', text: '@CourseAI what is CTR?', mention: true });
    await flushJobs();
    const [job] = await jobs();
    expect(job.contextMessageIds).toHaveLength(1);
  });

  it('a further mention after an answer does not re-answer consumed messages', async () => {
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'studentA', text: 'What is ROAS?', at: minutesAgo(2) });
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'studentA', text: '@CourseAI', mention: true, at: minutesAgo(1.5) });
    await flushJobs();
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'studentA', text: '@CourseAI what is CTR?', mention: true });
    await flushJobs();
    const all = await jobs();
    expect(all).toHaveLength(2);
    expect(all[1].contextMessageIds).toHaveLength(1);
    expect(all[1].normalizedQuestion).toMatch(/CTR/);
  });

  it('ignores groups not on the allowlist and registers them disabled', async () => {
    await inbound(mock, { chatId: 'unknown@g.us', chatType: 'GROUP', senderId: 'studentA', text: '@CourseAI hi', mention: true });
    await flushJobs();
    expect(await jobs()).toHaveLength(0);
    expect(await prisma.incomingMessage.count()).toBe(0);
    const g = await prisma.group.findFirst({ where: { externalChatId: 'unknown@g.us' } });
    expect(g?.enabled).toBe(false);
  });

  it('text-command mode is opt-in and display-name text never counts by default', async () => {
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'studentA', text: '!tutor what is ROAS?' });
    await flushJobs();
    expect(await jobs()).toHaveLength(0);
    await updateSettings({ text_command_mode_enabled: true }, null);
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'studentA', text: '!tutor what is ROAS?' });
    await flushJobs();
    expect(await jobs()).toHaveLength(1);
  });

  it('ignores outgoing/self messages (no self-reply loops)', async () => {
    await mock.simulateInbound({ chatId: GROUP, chatType: 'GROUP', senderId: 'bot@mock', text: '@CourseAI hi', mentionedIds: ['bot@mock'] });
    await mock.simulateInbound({ chatId: 'p1', senderId: 'studentA', text: 'my own outgoing', fromMe: true });
    await flushJobs();
    expect(await prisma.incomingMessage.count()).toBe(0);
  });
});

describe('private routing', () => {
  it('#7 personal messages are processed without a mention', async () => {
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'Explain CTR.' });
    await flushJobs();
    const all = await jobs();
    expect(all).toHaveLength(1);
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0].destination.chatType).toBe('PRIVATE');
  });

  it('auto-enrolls a first-time private sender even while enrollment is required', async () => {
    // require_enrollment defaults on; studentC was never enrolled. A first private message
    // promotes the sender from PENDING to ACTIVE, so it is processed instead of blocked.
    await inbound(mock, { chatId: 'studentC@c.us', senderId: 'studentC', text: 'What is CTR?' });
    await flushJobs();
    expect(await jobs()).toHaveLength(1);
    expect((await prisma.student.findFirstOrThrow({ where: { platformUserId: 'studentC' } })).enrollmentStatus).toBe('ACTIVE');
  });

  it('keeps a suspended sender blocked despite auto-enroll', async () => {
    // Admin suspensions must hold: auto-enroll only promotes the untouched PENDING default.
    await setStudentStatus('studentC', 'SUSPENDED');
    await inbound(mock, { chatId: 'studentC@c.us', senderId: 'studentC', text: 'What is CTR?' });
    await flushJobs();
    expect(await jobs()).toHaveLength(0);
    expect((await prisma.incomingMessage.findFirstOrThrow({ where: { senderExternalId: 'studentC' } })).processingStatus).toBe('BLOCKED');
    expect((await prisma.student.findFirstOrThrow({ where: { platformUserId: 'studentC' } })).enrollmentStatus).toBe('SUSPENDED');
  });

  it('turning off require_enrollment lets any sender through', async () => {
    await updateSettings({ require_enrollment: false }, null);
    await inbound(mock, { chatId: 'studentX@c.us', senderId: 'studentX', text: 'What is CTR?' });
    await flushJobs();
    expect(await jobs()).toHaveLength(1);
  });

  it('a burst of consecutive private messages yields one answer', async () => {
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'Hi', at: minutesAgo(0.3) });
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'what is ROAS', at: minutesAgo(0.2) });
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'with numbers please' });
    expect(await prisma.job.count({ where: { status: 'PENDING' } })).toBe(1);
    await flushJobs();
    expect(await jobs()).toHaveLength(1);
    expect(mock.outbox).toHaveLength(1);
  });

  it('#6 a follow-up refers to the previous answer in the same conversation', async () => {
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'What is CTR?', at: minutesAgo(3) });
    await flushJobs();
    // Another student's private conversation must not leak in.
    await inbound(mock, { chatId: 'studentB@c.us', senderId: 'studentB', text: 'What is ROAS?', at: minutesAgo(2) });
    await flushJobs();
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'Why?' });
    await flushJobs();
    const all = await jobs();
    expect(all).toHaveLength(3);
    const followup = all[2];
    expect(followup.intent).toBe('followup');
    expect(followup.previousJobId).toBe(all[0].id);
    expect(followup.normalizedQuestion).toMatch(/CTR/);
    const lastGen = ai.generateCalls.at(-1)!;
    expect(lastGen.prior?.question).toMatch(/CTR/);
    expect(JSON.stringify(lastGen)).not.toContain('ROAS');
  });

  it('unrelated new question starts a new context (no prior attached)', async () => {
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'What is CTR?', at: minutesAgo(3) });
    await flushJobs();
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'How does conversion tracking work?' });
    await flushJobs();
    const all = await jobs();
    expect(all[1].intent).toBe('new');
    expect(all[1].previousJobId).toBeNull();
  });

  it('does not auto-enroll in groups: an unenrolled mention stays blocked', async () => {
    // Auto-enroll is private-only. A group mention from a never-enrolled sender is still gated.
    await inbound(mock, { chatId: GROUP, chatType: 'GROUP', senderId: 'stranger', text: '@CourseAI what is CTR?', mention: true });
    await flushJobs();
    expect(await jobs()).toHaveLength(0);
    expect((await prisma.incomingMessage.findFirstOrThrow({ where: { senderExternalId: 'stranger' } })).processingStatus).toBe('BLOCKED');
    expect((await prisma.student.findFirstOrThrow({ where: { platformUserId: 'stranger' } })).enrollmentStatus).toBe('PENDING');
  });

  it('enforces per-student rate limits', async () => {
    await updateSettings({ student_per_minute_limit: 1 }, null);
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'What is CTR?' });
    await flushJobs();
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'What is ROAS?' });
    await flushJobs();
    expect(await jobs()).toHaveLength(1);
  });
});

describe('deduplication', () => {
  it('#18 duplicate inbound events are processed once', async () => {
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'What is CTR?', id: 'dup-1' });
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'What is CTR?', id: 'dup-1' });
    await inbound(mock, { chatId: 'studentA@c.us', senderId: 'studentA', text: 'What is CTR?', id: 'dup-1' });
    await flushJobs();
    expect(await prisma.incomingMessage.count()).toBe(1);
    expect(await jobs()).toHaveLength(1);
    expect(mock.outbox).toHaveLength(1);
  });
});

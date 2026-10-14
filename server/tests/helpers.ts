import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { AdminRole, ChatType, EnrollmentStatus } from '@prisma/client';
import { prisma } from '../src/db/prisma.js';
import { createApp } from '../src/app.js';
import { bootstrap } from '../src/bootstrap.js';
import { setAI } from '../src/ai/index.js';
import { MockTutorAI } from '../src/ai/mock.js';
import { MockMessagingAdapter, FULL_CAPABILITIES } from '../src/messaging/mockAdapter.js';
import { activateAdapter, setMockAdapter } from '../src/messaging/registry.js';
import { hashPassword } from '../src/auth/password.js';
import { updateSettings, type Settings } from '../src/settings/settingsService.js';
import { runDueJobs } from '../src/jobs/worker.js';
import { createTranscript, processTranscript } from '../src/transcripts/service.js';
import { setEmbedder } from '../src/embeddings/index.js';
import type { AdapterCapabilities } from '../src/messaging/types.js';

export const app = createApp();
export const BOT = 'bot@mock';
export const PASSWORD = 'Correct-Horse-42-battery';

let booted = false;

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`;
  if (tables.length) {
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  }
}

/** Fresh DB, fresh mock AI and mock adapter. Returns the test doubles. */
export async function setupWorld(opts: { capabilities?: AdapterCapabilities; settings?: Partial<Settings> } = {}) {
  await resetDb();
  const ai = new MockTutorAI();
  setAI(ai);
  setEmbedder(null);
  const mock = new MockMessagingAdapter(opts.capabilities ?? FULL_CAPABILITIES, BOT);
  setMockAdapter(mock);
  if (!booted) {
    await bootstrap();
    booted = true;
  }
  await updateSettings({ debounce_seconds: 0, ...opts.settings }, null);
  await activateAdapter('mock');
  return { ai, mock };
}

export async function createAdmin(role: AdminRole = 'SUPER_ADMIN', email = `${role.toLowerCase()}-${randomUUID().slice(0, 6)}@test.dev`) {
  return prisma.administrator.create({
    data: { email, role, passwordHash: await hashPassword(PASSWORD), mustChangePassword: false },
  });
}

/** Logged-in supertest agent with CSRF header helper. */
export async function login(role: AdminRole = 'SUPER_ADMIN') {
  const admin = await createAdmin(role);
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email: admin.email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.csrfToken as string;
  return {
    admin,
    agent,
    csrf,
    post: (url: string, body: object = {}) => agent.post(url).set('x-csrf-token', csrf).send(body),
    patch: (url: string, body: object = {}) => agent.patch(url).set('x-csrf-token', csrf).send(body),
    get: (url: string) => agent.get(url),
  };
}

export async function enrollStudent(platformUserId: string, displayName = platformUserId) {
  return prisma.student.upsert({
    where: { channel_platformUserId: { channel: 'MOCK', platformUserId } },
    create: { channel: 'MOCK', platformUserId, displayName, enrollmentStatus: 'ACTIVE' },
    update: { enrollmentStatus: 'ACTIVE' },
  });
}

export async function setStudentStatus(platformUserId: string, enrollmentStatus: EnrollmentStatus, displayName = platformUserId) {
  return prisma.student.upsert({
    where: { channel_platformUserId: { channel: 'MOCK', platformUserId } },
    create: { channel: 'MOCK', platformUserId, displayName, enrollmentStatus },
    update: { enrollmentStatus },
  });
}

export async function enableGroup(chatId: string) {
  return prisma.group.upsert({
    where: { channel_externalChatId: { channel: 'MOCK', externalChatId: chatId } },
    create: { channel: 'MOCK', externalChatId: chatId, enabled: true, name: chatId },
    update: { enabled: true },
  });
}

export function inbound(
  mock: MockMessagingAdapter,
  p: { chatId: string; senderId: string; text: string; chatType?: ChatType; mention?: boolean; at?: Date; id?: string; quoted?: string },
) {
  return mock.simulateInbound({
    chatId: p.chatId,
    senderId: p.senderId,
    text: p.text,
    chatType: p.chatType ?? 'PRIVATE',
    mentionedIds: p.mention ? [BOT] : [],
    timestamp: p.at ?? new Date(),
    ...(p.id ? { externalMessageId: p.id } : {}),
    ...(p.quoted ? { quotedMessageId: p.quoted } : {}),
  });
}

/** Runs every queued job now, ignoring debounce/backoff delays, until the queue is idle. */
export async function flushJobs(rounds = 10) {
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    await prisma.job.updateMany({ where: { status: 'PENDING' }, data: { runAt: new Date(Date.now() - 1000) } });
    const n = await runDueJobs(100);
    total += n;
    if (!n) break;
  }
  return total;
}

/** Creates a transcript and processes it synchronously (bypassing the background queue). */
export async function seedTranscript(content: string, meta: { filename?: string; moduleName?: string; lessonTitle?: string; topic?: string } = {}) {
  const filename = meta.filename ?? `lesson-${randomUUID().slice(0, 6)}.txt`;
  const t = await createTranscript(Buffer.from(content), filename, { title: meta.lessonTitle, moduleName: meta.moduleName, topic: meta.topic });
  await prisma.job.deleteMany({ where: { type: 'processTranscript' } });
  return (await processTranscript(t.id))!;
}

export const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

export const ROAS_TRANSCRIPT = `[00:10:05] Today we cover ROAS, which means return on ad spend. ROAS is revenue from ads divided by ad spend.
[00:11:30] For example, if you spend 1,000 on ads and the ads generate 4,000 in revenue, your ROAS is 4, often written as 4x.
[00:13:00] A good ROAS depends on your margins. Low-margin products need a higher ROAS to be profitable.`;

export const CTR_TRANSCRIPT = `[00:02:00] Click-through rate, or CTR, is the percentage of people who saw your ad and clicked it.
[00:03:10] CTR equals clicks divided by impressions, multiplied by 100. Ten clicks from one thousand impressions is a CTR of 1 percent.`;

export const TRACKING_TRANSCRIPT = `[00:20:00] Conversion tracking tells the ad platform which clicks turned into purchases or leads.
[00:21:15] You install the pixel or conversions API so every purchase event is reported back, for example a purchase on the thank-you page.`;

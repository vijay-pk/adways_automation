import { Prisma, type Student } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { getSettings, type Settings } from '../settings/settingsService.js';
import { enqueueDebounced } from '../jobs/queue.js';
import type { NormalizedMessage } from './types.js';
import { logger } from '../lib/logger.js';

export type IngestOutcome =
  | 'ignored_self'
  | 'ignored_empty'
  | 'duplicate'
  | 'group_not_allowed'
  | 'context_only'
  | 'replies_disabled'
  | 'not_enrolled'
  | 'rate_limited'
  | 'queued';

export interface IngestContext {
  botId: string | null;
  supportsNativeMentions: boolean;
}

/**
 * Entry point for every inbound message from any adapter.
 * Routing rules: groups need a genuine native mention (or the opt-in text command,
 * or a quoted reply to one of the tutor's messages); private messages are always eligible.
 */
export async function ingestMessage(msg: NormalizedMessage, ctx: IngestContext): Promise<IngestOutcome> {
  if (msg.fromMe || (ctx.botId && msg.senderId === ctx.botId)) return 'ignored_self';
  const text = msg.text?.trim() ?? '';
  if (!text) return 'ignored_empty';

  const settings = await getSettings();

  if (msg.chatType === 'GROUP') {
    const group = await prisma.group.upsert({
      where: { channel_externalChatId: { channel: msg.channel, externalChatId: msg.chatId } },
      create: { channel: msg.channel, externalChatId: msg.chatId, name: msg.chatName, enabled: false },
      update: msg.chatName ? { name: msg.chatName } : {},
    });
    // Unknown/disabled groups: register the group for the allowlist UI, store no message content.
    if (!group.enabled) return 'group_not_allowed';
  }

  const student = await upsertStudent(msg);
  const conversation = await prisma.conversation.upsert({
    where: { channel_externalChatId: { channel: msg.channel, externalChatId: msg.chatId } },
    create: {
      channel: msg.channel,
      externalChatId: msg.chatId,
      chatType: msg.chatType,
      studentId: msg.chatType === 'PRIVATE' ? student.id : null,
      lastMessageAt: msg.timestamp,
    },
    update: { lastMessageAt: msg.timestamp },
  });

  const invocation = detectInvocation(msg, text, ctx, settings);
  const isMention = msg.chatType === 'GROUP' ? invocation.invoked || (await isReplyToTutor(msg)) : false;

  let messageId: string;
  try {
    const created = await prisma.incomingMessage.create({
      data: {
        channel: msg.channel,
        externalMessageId: msg.externalMessageId,
        conversationId: conversation.id,
        senderExternalId: msg.senderId,
        studentId: student.id,
        content: invocation.cleanedText || text,
        timestamp: msg.timestamp,
        mentionMetadata: { mentionedIds: msg.mentionedIds, via: invocation.via } as never,
        isMention,
        quotedMessageId: msg.quotedMessageId,
        processingStatus: 'RECEIVED',
      },
    });
    messageId = created.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return 'duplicate';
    throw err;
  }

  const setStatus = (processingStatus: 'CONTEXT_ONLY' | 'BLOCKED' | 'QUEUED') =>
    prisma.incomingMessage.update({ where: { id: messageId }, data: { processingStatus } });

  if (msg.chatType === 'GROUP' && !isMention) {
    await setStatus('CONTEXT_ONLY');
    return 'context_only';
  }
  const repliesOn = msg.chatType === 'GROUP' ? settings.group_replies_enabled : settings.private_replies_enabled;
  if (!repliesOn) {
    await setStatus('CONTEXT_ONLY');
    return 'replies_disabled';
  }
  if (settings.require_enrollment && student.enrollmentStatus !== 'ACTIVE') {
    await setStatus('BLOCKED');
    return 'not_enrolled';
  }
  if (await isRateLimited(student, msg.senderId, settings)) {
    await setStatus('BLOCKED');
    return 'rate_limited';
  }

  const runAt = new Date(Date.now() + settings.debounce_seconds * 1000);
  await enqueueDebounced(
    'processQuestion',
    `${conversation.id}:${msg.senderId}`,
    { conversationId: conversation.id, senderExternalId: msg.senderId, triggerMessageId: messageId },
    runAt,
  );
  await setStatus('QUEUED');
  logger.debug({ conversationId: conversation.id, messageId }, 'question queued');
  return 'queued';
}

function detectInvocation(msg: NormalizedMessage, text: string, ctx: IngestContext, settings: Settings) {
  if (msg.chatType !== 'GROUP') return { invoked: true, via: 'private', cleanedText: text };
  if (ctx.supportsNativeMentions && ctx.botId && msg.mentionedIds.includes(ctx.botId)) {
    // Strip a leading "@Name" token that platforms render for native mentions.
    return { invoked: true, via: 'native_mention', cleanedText: text };
  }
  if (settings.text_command_mode_enabled) {
    const cmd = settings.text_command.toLowerCase();
    if (text.toLowerCase().startsWith(cmd)) {
      return { invoked: true, via: 'text_command', cleanedText: text.slice(cmd.length).trim() };
    }
  }
  return { invoked: false, via: null, cleanedText: text };
}

/** A quoted reply to a message the tutor sent counts as invoking the tutor. */
async function isReplyToTutor(msg: NormalizedMessage) {
  if (!msg.quotedMessageId) return false;
  const delivery = await prisma.messageDelivery.findFirst({
    where: { externalMessageId: msg.quotedMessageId, status: 'SENT' },
    select: { id: true },
  });
  return !!delivery;
}

async function upsertStudent(msg: NormalizedMessage): Promise<Student> {
  if (msg.knownStudentId) return prisma.student.findUniqueOrThrow({ where: { id: msg.knownStudentId } });
  return prisma.student.upsert({
    where: { channel_platformUserId: { channel: msg.channel, platformUserId: msg.senderId } },
    create: {
      channel: msg.channel,
      platformUserId: msg.senderId,
      displayName: msg.senderName,
      normalizedPhone: msg.senderPhone ? normalizePhone(msg.senderPhone) : undefined,
    },
    update: msg.senderName ? { displayName: msg.senderName } : {},
  });
}

export const normalizePhone = (p: string) => p.replace(/[^\d+]/g, '');

async function isRateLimited(student: Student, senderId: string, settings: Settings) {
  const now = Date.now();
  const [lastMinute, lastDay] = await Promise.all([
    prisma.responseJob.count({ where: { senderExternalId: senderId, createdAt: { gte: new Date(now - 60_000) } } }),
    prisma.responseJob.count({ where: { senderExternalId: senderId, createdAt: { gte: new Date(now - 86_400_000) } } }),
  ]);
  const daily = student.dailyLimitOverride ?? settings.student_daily_limit;
  return lastMinute >= settings.student_per_minute_limit || lastDay >= daily;
}

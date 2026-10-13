import { Router } from 'express';
import { z } from 'zod';
import { ResponseStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { requireRole, CAN_REVIEW } from '../auth/middleware.js';
import { notFound } from '../lib/errors.js';
import { parseBody } from '../lib/validate.js';
import {
  approveJob,
  markReviewedWithoutSending,
  regenerateJob,
  rejectJob,
  retryDelivery,
} from './approvalService.js';

export const responseRouter = Router();

responseRouter.get('/', async (req, res) => {
  const q = z
    .object({
      status: z.nativeEnum(ResponseStatus).optional(),
      skip: z.coerce.number().int().min(0).default(0),
      take: z.coerce.number().int().min(1).max(100).default(25),
    })
    .parse(req.query);
  const where = q.status ? { status: q.status } : {};
  const [items, total] = await Promise.all([
    prisma.responseJob.findMany({
      where,
      orderBy: { createdAt: q.status === 'PENDING_APPROVAL' ? 'asc' : 'desc' },
      skip: q.skip,
      take: q.take,
      include: {
        conversation: { select: { channel: true, chatType: true, externalChatId: true } },
        approvedBy: { select: { email: true } },
        delivery: { select: { status: true, attempts: true, lastError: true } },
      },
    }),
    prisma.responseJob.count({ where }),
  ]);
  res.json({ items, total });
});

responseRouter.get('/:id', async (req, res) => {
  const job = await prisma.responseJob.findUnique({
    where: { id: req.params.id },
    include: {
      conversation: true,
      approvedBy: { select: { email: true } },
      delivery: true,
      drafts: { orderBy: { createdAt: 'asc' } },
      usage: true,
      example: { select: { id: true, reusable: true } },
    },
  });
  if (!job) throw notFound();
  const [messages, chunks, examples, sender] = await Promise.all([
    prisma.incomingMessage.findMany({
      where: { id: { in: job.contextMessageIds } },
      orderBy: { timestamp: 'asc' },
      select: { id: true, content: true, timestamp: true, isMention: true, externalMessageId: true },
    }),
    prisma.transcriptChunk.findMany({
      where: { id: { in: job.retrievedChunkIds } },
      include: { transcript: { select: { filename: true, moduleName: true, lessonTitle: true } } },
    }),
    prisma.approvedAnswerExample.findMany({
      where: { id: { in: job.exampleIdsUsed } },
      select: { id: true, normalizedQuestion: true, approvedAnswer: true, updatedAt: true, wasEdited: true },
    }),
    prisma.student.findFirst({
      where: { platformUserId: job.senderExternalId, channel: job.conversation.channel },
      select: { id: true, displayName: true, enrollmentStatus: true },
    }),
  ]);
  const order = new Map(job.retrievedChunkIds.map((id, i) => [id, i]));
  chunks.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  res.json({ job, messages, chunks, examples, sender });
});

const approveSchema = z.object({
  editedAnswer: z.string().min(1).max(4000).optional(),
  reusable: z.boolean().optional(),
  reviewerNotes: z.string().max(2000).optional(),
  topicTags: z.array(z.string().min(1).max(50)).max(20).optional(),
  moduleName: z.string().max(200).optional(),
});
const notesSchema = z.object({ notes: z.string().max(2000).optional() });
const hintSchema = z.object({ hint: z.string().max(2000).optional() });

responseRouter.post('/:id/approve', requireRole(...CAN_REVIEW), async (req, res) => {
  const body = parseBody(approveSchema, req.body ?? {});
  res.json(await approveJob(req.params.id as string, req.auth!.admin.id, body));
});

responseRouter.post('/:id/reject', requireRole(...CAN_REVIEW), async (req, res) => {
  const body = parseBody(notesSchema, req.body ?? {});
  res.json(await rejectJob(req.params.id as string, req.auth!.admin.id, body.notes));
});

responseRouter.post('/:id/mark-reviewed', requireRole(...CAN_REVIEW), async (req, res) => {
  const body = parseBody(notesSchema, req.body ?? {});
  res.json(await markReviewedWithoutSending(req.params.id as string, req.auth!.admin.id, body.notes));
});

responseRouter.post('/:id/regenerate', requireRole(...CAN_REVIEW), async (req, res) => {
  const body = parseBody(hintSchema, req.body ?? {});
  res.json(await regenerateJob(req.params.id as string, req.auth!.admin.id, { hint: body.hint }));
});

responseRouter.post('/:id/request-evidence', requireRole(...CAN_REVIEW), async (req, res) => {
  const body = parseBody(hintSchema, req.body ?? {});
  res.json(await regenerateJob(req.params.id as string, req.auth!.admin.id, { hint: body.hint, moreEvidence: true }));
});

responseRouter.post('/:id/retry-delivery', requireRole(...CAN_REVIEW), async (req, res) => {
  res.json(await retryDelivery(req.params.id as string, req.auth!.admin.id));
});

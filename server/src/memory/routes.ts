import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireRole, CAN_REVIEW } from '../auth/middleware.js';
import { notFound } from '../lib/errors.js';
import { parseBody } from '../lib/validate.js';
import { audit } from '../audit/auditService.js';
import { jobsInfluencedBy, listExamples } from './approvedExamples.js';
import { correctionPatterns } from './editDiff.js';

export const memoryRouter = Router();

const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true').optional();

memoryRouter.get('/', async (req, res) => {
  const q = z
    .object({
      q: z.string().max(200).optional(),
      reusable: boolQuery,
      enabled: boolQuery,
      skip: z.coerce.number().int().min(0).default(0),
      take: z.coerce.number().int().min(1).max(100).default(25),
    })
    .parse(req.query);
  res.json(await listExamples(q));
});

memoryRouter.get('/patterns', async (_req, res) => {
  res.json(await correctionPatterns());
});

memoryRouter.get('/:id', async (req, res) => {
  const ex = await prisma.approvedAnswerExample.findUnique({ where: { id: req.params.id } });
  if (!ex) throw notFound();
  res.json({ example: ex, influencedJobs: await jobsInfluencedBy(ex.id) });
});

const updateSchema = z.object({
  normalizedQuestion: z.string().min(1).max(1000).optional(),
  approvedAnswer: z.string().min(1).max(4000).optional(),
  reusable: z.boolean().optional(),
  enabled: z.boolean().optional(),
  topicTags: z.array(z.string().min(1).max(50)).max(20).optional(),
  moduleName: z.string().max(200).nullable().optional(),
  reviewerNotes: z.string().max(2000).nullable().optional(),
  qualityStatus: z.enum(['approved', 'corrected', 'excellent', 'needs_review']).optional(),
  usefulnessScore: z.number().int().min(1).max(5).nullable().optional(),
});

memoryRouter.patch('/:id', requireRole(...CAN_REVIEW), async (req, res) => {
  const body = parseBody(updateSchema, req.body ?? {});
  if (body.topicTags) body.topicTags = body.topicTags.map((t) => t.toLowerCase());
  const ex = await prisma.approvedAnswerExample.update({ where: { id: req.params.id as string }, data: body });
  await audit(req.auth!.admin.id, 'memory.update', 'approved_answer_example', ex.id, { fields: Object.keys(body) });
  res.json(ex);
});

memoryRouter.delete('/:id', requireRole(...CAN_REVIEW), async (req, res) => {
  await prisma.approvedAnswerExample.delete({ where: { id: req.params.id as string } });
  await audit(req.auth!.admin.id, 'memory.delete', 'approved_answer_example', req.params.id as string);
  res.json({ ok: true });
});

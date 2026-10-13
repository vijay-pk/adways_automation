import { randomUUID } from 'node:crypto';
import type { Job } from '@prisma/client';
import { prisma, type Db } from '../db/prisma.js';

export type JobType = 'processQuestion' | 'deliverMessage' | 'retention' | 'processTranscript';

export interface EnqueueOptions {
  runAt?: Date;
  dedupeKey?: string;
  maxAttempts?: number;
}

export async function enqueue(type: JobType, payload: Record<string, unknown>, opts: EnqueueOptions = {}, db: Db = prisma) {
  return db.job.create({
    data: {
      type,
      payload: payload as never,
      runAt: opts.runAt ?? new Date(),
      dedupeKey: opts.dedupeKey,
      maxAttempts: opts.maxAttempts ?? 5,
    },
  });
}

/**
 * Debounced enqueue: if a PENDING job with the same key exists, push its run time
 * back and replace its payload so a burst of messages yields one job.
 */
export async function enqueueDebounced(
  type: JobType,
  dedupeKey: string,
  payload: Record<string, unknown>,
  runAt: Date,
  db: Db = prisma,
): Promise<string> {
  const now = new Date();
  const rows = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "jobs" ("id", "type", "dedupe_key", "payload", "status", "run_at", "attempts", "max_attempts", "created_at", "updated_at")
    VALUES (${randomUUID()}, ${type}, ${dedupeKey}, ${JSON.stringify(payload)}::jsonb, 'PENDING', (${runAt} AT TIME ZONE 'UTC'), 0, 5, (${now} AT TIME ZONE 'UTC'), (${now} AT TIME ZONE 'UTC'))
    ON CONFLICT ("type", "dedupe_key") WHERE "status" = 'PENDING' AND "dedupe_key" IS NOT NULL
    DO UPDATE SET "run_at" = EXCLUDED."run_at", "payload" = EXCLUDED."payload", "updated_at" = EXCLUDED."updated_at"
    RETURNING "id"`;
  return rows[0].id;
}

// Columns are timestamp without time zone holding UTC (Prisma convention). Raw SQL therefore
// converts Node timestamps with AT TIME ZONE 'UTC' instead of using now(), which follows the
// database session time zone.

/** Atomically claims the next due job (safe with multiple workers). */
export async function claimNext(): Promise<Job | null> {
  const now = new Date();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "jobs" SET "status" = 'RUNNING', "locked_at" = (${now} AT TIME ZONE 'UTC'), "attempts" = "attempts" + 1, "updated_at" = (${now} AT TIME ZONE 'UTC')
    WHERE "id" = (
      SELECT "id" FROM "jobs" WHERE "status" = 'PENDING' AND "run_at" <= (${now} AT TIME ZONE 'UTC')
      ORDER BY "run_at" ASC FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING "id"`;
  if (!rows.length) return null;
  return prisma.job.findUnique({ where: { id: rows[0].id } });
}

export const completeJob = (id: string) =>
  prisma.job.update({ where: { id }, data: { status: 'DONE', lockedAt: null, lastError: null } });

export const backoffMs = (attempts: number) => Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 10 * 60_000);

export async function failJob(job: Job, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const final = job.attempts >= job.maxAttempts;
  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: final ? 'FAILED' : 'PENDING',
      lockedAt: null,
      lastError: message.slice(0, 2000),
      runAt: final ? job.runAt : new Date(Date.now() + backoffMs(job.attempts)),
    },
  });
  return final;
}

/** Re-schedule without consuming an attempt (e.g. outgoing paused). */
export const deferJob = (job: Job, ms: number, reason: string) =>
  prisma.job.update({
    where: { id: job.id },
    data: { status: 'PENDING', lockedAt: null, attempts: { decrement: 1 }, lastError: reason, runAt: new Date(Date.now() + ms) },
  });

/** Jobs left RUNNING by a crashed/disconnected worker go back to PENDING. */
export async function recoverStaleJobs(staleMs = 5 * 60_000) {
  const r = await prisma.job.updateMany({
    where: { status: 'RUNNING', lockedAt: { lt: new Date(Date.now() - staleMs) } },
    data: { status: 'PENDING', lockedAt: null },
  });
  return r.count;
}

export async function queueStats() {
  const grouped = await prisma.job.groupBy({ by: ['type', 'status'], _count: true });
  return grouped.map((g) => ({ type: g.type, status: g.status, count: g._count }));
}

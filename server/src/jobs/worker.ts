import type { Job } from '@prisma/client';
import { claimNext, completeJob, failJob, recoverStaleJobs } from './queue.js';
import { logger } from '../lib/logger.js';

export class DeferError extends Error {
  constructor(
    public delayMs: number,
    reason: string,
  ) {
    super(reason);
  }
}

export type JobHandler = (job: Job) => Promise<void>;
const handlers = new Map<string, JobHandler>();

export const registerHandler = (type: string, handler: JobHandler) => handlers.set(type, handler);

export async function runJob(job: Job) {
  const handler = handlers.get(job.type);
  try {
    if (!handler) throw new Error(`No handler for job type ${job.type}`);
    await handler(job);
    await completeJob(job.id);
  } catch (err) {
    if (err instanceof DeferError) {
      const { deferJob } = await import('./queue.js');
      await deferJob(job, err.delayMs, err.message);
      return;
    }
    const final = await failJob(job, err);
    logger.error({ jobId: job.id, type: job.type, attempts: job.attempts, final, err }, 'job failed');
  }
}

/** Processes due jobs until none remain (or `max` reached). Used by worker loop and tests. */
export async function runDueJobs(max = 100): Promise<number> {
  let n = 0;
  while (n < max) {
    const job = await claimNext();
    if (!job) break;
    await runJob(job);
    n++;
  }
  return n;
}

let timer: NodeJS.Timeout | null = null;
let stopping = false;

export function startWorker(pollMs: number) {
  stopping = false;
  let lastRecover = 0;
  const tick = async () => {
    try {
      if (Date.now() - lastRecover > 60_000) {
        lastRecover = Date.now();
        const n = await recoverStaleJobs();
        if (n) logger.warn({ n }, 'recovered stale jobs');
      }
      await runDueJobs(25);
    } catch (err) {
      logger.error({ err }, 'worker tick failed');
    } finally {
      if (!stopping) timer = setTimeout(tick, pollMs);
    }
  };
  timer = setTimeout(tick, pollMs);
}

export function stopWorker() {
  stopping = true;
  if (timer) clearTimeout(timer);
}

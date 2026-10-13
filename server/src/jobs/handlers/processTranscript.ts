import type { Job } from '@prisma/client';
import { processTranscript } from '../../transcripts/service.js';

/** Queue wrapper: non-final failures are retried with backoff; the last attempt marks FAILED. */
export async function processTranscriptHandler(job: Job) {
  const { transcriptId } = job.payload as { transcriptId: string };
  await processTranscript(transcriptId, { final: job.attempts >= job.maxAttempts });
}

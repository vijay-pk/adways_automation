import { prisma } from '../../db/prisma.js';
import { getSettings } from '../../settings/settingsService.js';
import { enqueueDebounced } from '../queue.js';

/**
 * Data retention: raw message contents and per-student drafts are purged after the configured
 * number of days. Approved Answer Memory, transcripts and audit logs are kept separately.
 */
export async function runRetention() {
  const settings = await getSettings();
  const cutoff = new Date(Date.now() - settings.message_retention_days * 86_400_000);
  const messages = await prisma.incomingMessage.updateMany({
    where: { timestamp: { lt: cutoff }, content: { not: null } },
    data: { content: null },
  });
  const deleted = await prisma.incomingMessage.deleteMany({
    where: { timestamp: { lt: new Date(cutoff.getTime() - settings.message_retention_days * 86_400_000) } },
  });
  const drafts = await prisma.responseDraft.deleteMany({ where: { createdAt: { lt: cutoff } } });
  const jobs = await prisma.job.deleteMany({ where: { status: { in: ['DONE', 'CANCELLED'] }, updatedAt: { lt: cutoff } } });
  return { redactedMessages: messages.count, deletedMessages: deleted.count, deletedDrafts: drafts.count, deletedQueueJobs: jobs.count };
}

export async function retentionHandler() {
  await runRetention();
  // Reschedule daily.
  await enqueueDebounced('retention', 'daily', {}, new Date(Date.now() + 86_400_000));
}

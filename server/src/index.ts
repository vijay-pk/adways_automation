import { env } from './config/env.js';
import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { startWorker, stopWorker } from './jobs/worker.js';
import { enqueueDebounced, recoverStaleJobs } from './jobs/queue.js';
import { disconnectActive } from './messaging/registry.js';
import { prisma } from './db/prisma.js';
import { logger } from './lib/logger.js';
import { getStorage } from './storage/index.js';

async function main() {
  await prisma.$connect();
  await getStorage().ensureReady();
  await bootstrap();
  // Jobs interrupted by a crash or restart are picked up again (all state lives in Postgres).
  await recoverStaleJobs(0);
  await enqueueDebounced('retention', 'daily', {}, new Date(Date.now() + 60_000));
  if (env.WORKER_ENABLED) startWorker(env.WORKER_POLL_MS);

  const server = createApp().listen(env.PORT, () => logger.info(`Course tutor API listening on :${env.PORT}`));
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopWorker();
    server.close();
    await disconnectActive().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});

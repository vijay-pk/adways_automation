import { registerHandler } from './jobs/worker.js';
import { processQuestion } from './jobs/handlers/processQuestion.js';
import { deliverResponse } from './responses/deliveryService.js';
import { retentionHandler } from './jobs/handlers/retention.js';
import { processTranscriptHandler } from './jobs/handlers/processTranscript.js';
import { getActiveAdapter, initMessaging, setInboundHandler } from './messaging/registry.js';
import { ingestMessage } from './messaging/ingest.js';
import { logger } from './lib/logger.js';

/** Wires job handlers and inbound messaging. Shared by the server entrypoint and tests. */
export async function bootstrap() {
  registerHandler('processQuestion', processQuestion);
  registerHandler('deliverMessage', deliverResponse);
  registerHandler('retention', retentionHandler);
  registerHandler('processTranscript', processTranscriptHandler);
  setInboundHandler(async (msg) => {
    const adapter = getActiveAdapter();
    try {
      await ingestMessage(msg, {
        botId: adapter?.botId() ?? null,
        supportsNativeMentions: adapter?.capabilities.nativeMentions ?? false,
      });
    } catch (err) {
      logger.error({ err, externalMessageId: msg.externalMessageId }, 'ingest failed');
      throw err;
    }
  });
  await initMessaging();
}

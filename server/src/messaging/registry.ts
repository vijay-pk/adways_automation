import type { Channel } from '@prisma/client';
import type { MessageHandler, MessagingAdapter } from './types.js';
import { MockMessagingAdapter } from './mockAdapter.js';
import { WhatsAppCloudApiAdapter, cloudConfigSummary } from './cloudApiAdapter.js';
import { WhatsAppWebAdapter, type WaSocketFactory } from './whatsappWebAdapter.js';
import { WebChatAdapter } from './webChatAdapter.js';
import { getSettings, type Settings } from '../settings/settingsService.js';
import { badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export type AdapterName = Settings['messaging_adapter'];

/**
 * Holds the active messaging adapter. Only the in-memory connection lives here;
 * all business state (messages, jobs, examples, settings) stays in the database,
 * so switching adapters never loses data.
 */
const webChat = new WebChatAdapter();
let active: MessagingAdapter | null = null;
let inboundHandler: MessageHandler | null = null;
let lastError: string | null = null;
let mockSingleton: MockMessagingAdapter | null = null;

export const getMockAdapter = () => (mockSingleton ??= new MockMessagingAdapter());
/** Test hook: replace the mock instance (e.g. with different capabilities). */
export const setMockAdapter = (m: MockMessagingAdapter) => {
  mockSingleton = m;
};

let webOptions: { sessionDir?: string; socketFactory?: WaSocketFactory } = {};
/** Test hook: inject a fake WhatsApp Web socket instead of Baileys. */
export const setWhatsAppWebOptions = (o: typeof webOptions) => {
  webOptions = o;
};

export function createAdapter(name: AdapterName): MessagingAdapter {
  switch (name) {
    case 'mock':
      return getMockAdapter();
    case 'whatsapp_cloud':
      return new WhatsAppCloudApiAdapter();
    case 'whatsapp_web':
      return new WhatsAppWebAdapter(webOptions);
  }
}

/** Compliance gates that must pass before an adapter can be selected. */
export function assertAdapterAllowed(name: AdapterName, settings: Settings) {
  if (settings.platform_data_ai_training_allowed !== false) {
    throw badRequest('Platform message data must not be used for AI training.');
  }
  if (name === 'whatsapp_cloud' && !settings.cloud_api_policy_acknowledged) {
    throw badRequest('Review and acknowledge the WhatsApp Business Platform policy checklist before enabling this adapter.');
  }
  if (name === 'whatsapp_web' && !settings.whatsapp_web_risk_acknowledged) {
    throw badRequest('The experimental WhatsApp Web adapter requires explicit risk acknowledgement.');
  }
}

export function setInboundHandler(handler: MessageHandler) {
  inboundHandler = handler;
  active?.onMessage(handler);
}

export async function activateAdapter(name: AdapterName, settings?: Settings) {
  const s = settings ?? (await getSettings());
  assertAdapterAllowed(name, s);
  const next = createAdapter(name);
  if (active && active !== next) await active.disconnect().catch(() => undefined);
  active = next;
  if (inboundHandler) next.onMessage(inboundHandler);
  lastError = null;
  if (s.messaging_connection_enabled) await connectActive();
  return next;
}

export async function connectActive() {
  if (!active) return;
  try {
    await active.connect();
    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.warn({ adapter: active.name, err: lastError }, 'adapter connect failed');
  }
}

export async function disconnectActive() {
  await active?.disconnect();
}

export const getActiveAdapter = () => active;
export const getLastAdapterError = () => lastError;

/** Adapter able to deliver to a conversation of the given channel, or null. */
export function getSenderForChannel(channel: Channel): MessagingAdapter | null {
  if (channel === 'WEB') return webChat;
  if (active && active.channel === channel) return active;
  return null;
}

export async function initMessaging() {
  const s = await getSettings();
  try {
    await activateAdapter(s.messaging_adapter, s);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.error({ err: lastError }, 'messaging init failed; falling back to no active adapter');
  }
}

export async function adapterOverview() {
  const status = active ? await active.getStatus() : { state: 'not_configured' as const, detail: 'No adapter active' };
  return {
    adapter: active?.name ?? null,
    channel: active?.channel ?? null,
    experimental: active?.experimental ?? false,
    status,
    lastError,
    capabilities: active?.capabilities ?? null,
    webChat: { capabilities: webChat.capabilities },
    // Linked-device login: whether a QR is waiting (the QR itself is served to super admins only).
    login: active?.loginQr ? { supported: true, qrAvailable: !!active.loginQr() } : { supported: false, qrAvailable: false },
    cloud: cloudConfigSummary(),
  };
}

/** Current login QR of the active adapter, or null. */
export const getLoginQr = () => active?.loginQr?.() ?? null;

/** Unlinks a linked-device adapter and deletes its session. */
export async function logoutActive() {
  if (!active?.logout) throw badRequest('The active adapter has no device session to log out of');
  await active.logout();
}

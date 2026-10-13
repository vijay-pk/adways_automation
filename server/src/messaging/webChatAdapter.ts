import { randomUUID } from 'node:crypto';
import type { AdapterCapabilities, ConnectionStatus, MessagingAdapter, SendResult } from './types.js';

/**
 * Website chat fallback. Replies are stored on the response job (status SENT) and
 * fetched by the student's browser; no external platform is involved.
 */
export class WebChatAdapter implements MessagingAdapter {
  readonly name = 'web';
  readonly channel = 'WEB' as const;
  readonly experimental = false;
  readonly capabilities: AdapterCapabilities = {
    receivePrivateMessages: true,
    sendPrivateMessages: true,
    receiveGroupMessages: false,
    sendGroupMessages: false,
    nativeMentions: false,
    quotedReplies: false,
    messageHistory: true,
    notes: ['Website chat for enrolled students; used when a WhatsApp feature is unavailable.'],
  };
  botId() {
    return 'tutor@web';
  }
  async connect() {}
  async disconnect() {}
  async getStatus(): Promise<ConnectionStatus> {
    return { state: 'connected', botId: 'tutor@web' };
  }
  async sendMessage(): Promise<SendResult> {
    return { externalMessageId: `web-${randomUUID()}` };
  }
  onMessage() {}
}

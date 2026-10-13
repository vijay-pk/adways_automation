import type { AdapterCapabilities, ConnectionStatus, MessagingAdapter, SendResult } from './types.js';
import { NotConfiguredError } from './types.js';

/**
 * Placeholder for the official WhatsApp Business Platform (Cloud API) adapter (Milestone 10).
 * Capabilities are declared conservatively: group messaging and native group mentions are
 * NOT assumed to be available. The dashboard shows these limitations and students are
 * routed to the website chat instead.
 */
export const CLOUD_API_CAPABILITIES: AdapterCapabilities = {
  receivePrivateMessages: true,
  sendPrivateMessages: true,
  receiveGroupMessages: false,
  sendGroupMessages: false,
  nativeMentions: false,
  quotedReplies: true,
  messageHistory: false,
  notes: [
    'Not implemented yet. Requires a verified Meta business account, an approved phone number and a policy review.',
    'Existing WhatsApp groups and group mentions are not assumed to be supported.',
    'Business-initiated messages outside the customer service window require approved templates.',
    'Message data must not be used to train or improve AI models.',
  ],
};

export class WhatsAppCloudApiAdapter implements MessagingAdapter {
  readonly name = 'whatsapp_cloud';
  readonly channel = 'WHATSAPP_CLOUD' as const;
  readonly capabilities = CLOUD_API_CAPABILITIES;
  readonly experimental = false;

  botId() {
    return null;
  }
  async connect() {
    throw new NotConfiguredError('WhatsApp Cloud API adapter is not configured');
  }
  async disconnect() {}
  async getStatus(): Promise<ConnectionStatus> {
    return { state: 'not_configured', detail: 'Official adapter not implemented yet (Milestone 10)' };
  }
  async sendMessage(): Promise<SendResult> {
    throw new NotConfiguredError('WhatsApp Cloud API adapter is not configured');
  }
  onMessage() {}
}

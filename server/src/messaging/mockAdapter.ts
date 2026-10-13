import { randomUUID } from 'node:crypto';
import type {
  AdapterCapabilities,
  ConnectionStatus,
  MessageDestination,
  MessageHandler,
  MessagingAdapter,
  NormalizedMessage,
  SendResult,
} from './types.js';
import { CapabilityError } from './types.js';

export interface SentRecord {
  id: string;
  destination: MessageDestination;
  text: string;
  at: Date;
}

export const FULL_CAPABILITIES: AdapterCapabilities = {
  receivePrivateMessages: true,
  sendPrivateMessages: true,
  receiveGroupMessages: true,
  sendGroupMessages: true,
  nativeMentions: true,
  quotedReplies: true,
  messageHistory: false,
  notes: ['Development/test adapter. Messages never leave this server.'],
};

/** In-memory adapter for development and automated tests. Never sends real messages. */
export class MockMessagingAdapter implements MessagingAdapter {
  readonly name = 'mock';
  readonly channel = 'MOCK' as const;
  readonly experimental = false;
  readonly outbox: SentRecord[] = [];
  private handler: MessageHandler | null = null;
  private connected = false;
  failNextSends = 0;

  constructor(
    readonly capabilities: AdapterCapabilities = FULL_CAPABILITIES,
    private readonly id = 'bot@mock',
  ) {}

  botId() {
    return this.id;
  }

  async connect() {
    this.connected = true;
  }

  async disconnect() {
    this.connected = false;
  }

  async getStatus(): Promise<ConnectionStatus> {
    return { state: this.connected ? 'connected' : 'disconnected', botId: this.id };
  }

  onMessage(handler: MessageHandler) {
    this.handler = handler;
  }

  async sendMessage(destination: MessageDestination, text: string): Promise<SendResult> {
    if (!this.connected) throw new Error('Mock adapter is disconnected');
    const canSend =
      destination.chatType === 'GROUP' ? this.capabilities.sendGroupMessages : this.capabilities.sendPrivateMessages;
    if (!canSend) throw new CapabilityError(`Adapter cannot send ${destination.chatType} messages`);
    if (this.failNextSends > 0) {
      this.failNextSends--;
      throw new Error('Simulated provider failure');
    }
    const record = { id: `mock-out-${randomUUID()}`, destination, text, at: new Date() };
    this.outbox.push(record);
    return { externalMessageId: record.id };
  }

  /** Simulates an inbound platform event. */
  async simulateInbound(
    partial: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'chatId' | 'senderId' | 'text'>,
  ): Promise<NormalizedMessage> {
    if (!this.handler) throw new Error('No inbound handler registered');
    const msg: NormalizedMessage = {
      channel: 'MOCK',
      externalMessageId: `mock-in-${randomUUID()}`,
      chatType: 'PRIVATE',
      timestamp: new Date(),
      fromMe: false,
      mentionedIds: [],
      ...partial,
    };
    await this.handler(msg);
    return msg;
  }
}

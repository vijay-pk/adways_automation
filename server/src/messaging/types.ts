import type { Channel, ChatType } from '@prisma/client';

/** Provider-neutral inbound message. The AI engine never sees provider event objects. */
export interface NormalizedMessage {
  channel: Channel;
  externalMessageId: string;
  chatId: string;
  chatType: ChatType;
  chatName?: string;
  senderId: string;
  senderName?: string;
  senderPhone?: string;
  text: string;
  timestamp: Date;
  fromMe: boolean;
  /** Platform-native mention targets (e.g. JIDs). Never derived from free text. */
  mentionedIds: string[];
  quotedMessageId?: string;
  /** Set by the website chat, where the student is already authenticated. */
  knownStudentId?: string;
}

export interface MessageDestination {
  channel: Channel;
  chatId: string;
  chatType: ChatType;
  replyToMessageId?: string;
  mentionIds?: string[];
}

export interface SendResult {
  externalMessageId: string;
}

export type ConnectionState = 'connected' | 'connecting' | 'disconnected' | 'error' | 'not_configured';

export interface ConnectionStatus {
  state: ConnectionState;
  detail?: string;
  botId?: string | null;
}

export interface AdapterCapabilities {
  receivePrivateMessages: boolean;
  sendPrivateMessages: boolean;
  receiveGroupMessages: boolean;
  sendGroupMessages: boolean;
  nativeMentions: boolean;
  quotedReplies: boolean;
  messageHistory: boolean;
  /** Human-readable limitations shown in the dashboard. */
  notes: string[];
}

export type MessageHandler = (message: NormalizedMessage) => Promise<void>;

export interface MessagingAdapter {
  readonly name: string;
  readonly channel: Channel;
  readonly capabilities: AdapterCapabilities;
  readonly experimental: boolean;
  botId(): string | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): Promise<ConnectionStatus>;
  sendMessage(destination: MessageDestination, text: string): Promise<SendResult>;
  onMessage(handler: MessageHandler): void;
}

export class CapabilityError extends Error {}
export class NotConfiguredError extends Error {}

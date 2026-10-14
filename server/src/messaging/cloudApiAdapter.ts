import { createHmac } from 'node:crypto';
import { env } from '../config/env.js';
import { safeEqual } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import type {
  AdapterCapabilities,
  ConnectionStatus,
  MessageDestination,
  MessageHandler,
  MessagingAdapter,
  NormalizedMessage,
  SendResult,
} from './types.js';
import { CapabilityError, NotConfiguredError } from './types.js';

/**
 * Official WhatsApp Business Platform (Cloud API) adapter.
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
    'Requires a verified Meta business account, an approved phone number and a policy review.',
    'Existing WhatsApp groups and group mentions are not assumed to be supported; groups use the website chat.',
    'Free-form replies only work within 24 hours of the student’s last message; later sends need approved templates.',
    'Message data must not be used to train or improve AI models.',
  ],
};

export interface CloudConfig {
  graphUrl: string;
  apiVersion: string;
  phoneNumberId?: string;
  businessAccountId?: string;
  accessToken?: string;
  appSecret?: string;
  verifyToken?: string;
}

let override: CloudConfig | null = null;

export const getCloudConfig = (): CloudConfig =>
  override ?? {
    graphUrl: env.WHATSAPP_CLOUD_GRAPH_URL,
    apiVersion: env.WHATSAPP_CLOUD_API_VERSION,
    phoneNumberId: env.WHATSAPP_CLOUD_PHONE_NUMBER_ID,
    businessAccountId: env.WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID,
    accessToken: env.WHATSAPP_CLOUD_ACCESS_TOKEN,
    appSecret: env.WHATSAPP_CLOUD_APP_SECRET,
    verifyToken: env.WHATSAPP_CLOUD_VERIFY_TOKEN,
  };

/** Test hook. */
export const setCloudConfig = (c: CloudConfig | null) => {
  override = c;
};

const REQUIRED: [keyof CloudConfig, string][] = [
  ['phoneNumberId', 'WHATSAPP_CLOUD_PHONE_NUMBER_ID'],
  ['accessToken', 'WHATSAPP_CLOUD_ACCESS_TOKEN'],
  ['appSecret', 'WHATSAPP_CLOUD_APP_SECRET'],
  ['verifyToken', 'WHATSAPP_CLOUD_VERIFY_TOKEN'],
];

/** Which settings are present (never their values). */
export function cloudConfigSummary(c: CloudConfig = getCloudConfig()) {
  return {
    phoneNumberId: c.phoneNumberId ?? null,
    businessAccountId: c.businessAccountId ?? null,
    apiVersion: c.apiVersion,
    accessTokenSet: !!c.accessToken,
    appSecretSet: !!c.appSecret,
    verifyTokenSet: !!c.verifyToken,
    missing: REQUIRED.filter(([k]) => !c[k]).map(([, name]) => name),
  };
}

/** Validates Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the app secret). */
export function verifyCloudSignature(raw: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`;
  return safeEqual(header, expected);
}

export interface CloudStatusEvent {
  externalMessageId: string;
  status: string;
  timestamp: Date;
  error?: string;
}

interface CloudWebhookPayload {
  object?: string;
  entry?: {
    changes?: {
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: CloudInboundMessage[];
        statuses?: { id?: string; status?: string; timestamp?: string; errors?: { code?: number; title?: string; message?: string }[] }[];
      };
    }[];
  }[];
}

interface CloudInboundMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string };
  context?: { id?: string };
}

const toDate = (s?: string) => (s && Number(s) > 0 ? new Date(Number(s) * 1000) : new Date());

/** Extracts messages and delivery statuses addressed to our phone number from a webhook payload. */
export function parseCloudWebhook(payload: unknown, phoneNumberId: string | undefined) {
  const messages: NormalizedMessage[] = [];
  const statuses: CloudStatusEvent[] = [];
  const body = payload as CloudWebhookPayload;
  if (body?.object !== 'whatsapp_business_account') return { messages, statuses };
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (change.field !== 'messages' || !value) continue;
      if (phoneNumberId && value.metadata?.phone_number_id !== phoneNumberId) continue;
      const names = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages ?? []) {
        if (!m.id || !m.from) continue;
        const text =
          m.text?.body ??
          m.button?.text ??
          m.interactive?.button_reply?.title ??
          m.interactive?.list_reply?.title ??
          m.image?.caption ??
          m.video?.caption ??
          m.document?.caption ??
          '';
        messages.push({
          channel: 'WHATSAPP_CLOUD',
          externalMessageId: m.id,
          chatId: m.from,
          chatType: 'PRIVATE',
          senderId: m.from,
          senderName: names.get(m.from) ?? undefined,
          senderPhone: `+${m.from}`,
          text,
          timestamp: toDate(m.timestamp),
          fromMe: false,
          mentionedIds: [],
          quotedMessageId: m.context?.id,
        });
      }
      for (const s of value.statuses ?? []) {
        if (!s.id || !s.status) continue;
        const e = s.errors?.[0];
        statuses.push({
          externalMessageId: s.id,
          status: s.status,
          timestamp: toDate(s.timestamp),
          error: e ? `Cloud API ${e.code ?? ''} ${e.title ?? e.message ?? ''}`.trim() : undefined,
        });
      }
    }
  }
  return { messages, statuses };
}

type GraphError = { error?: { message?: string; code?: number; error_subcode?: number } };

const describeGraphError = (status: number, body: GraphError) => {
  const code = body.error?.code;
  const hint = code === 131047 ? ' (24-hour customer service window closed; an approved template is required)' : '';
  return `Cloud API ${status}${code ? ` code ${code}` : ''}: ${body.error?.message ?? 'request failed'}${hint}`;
};

export class WhatsAppCloudApiAdapter implements MessagingAdapter {
  readonly name = 'whatsapp_cloud';
  readonly channel = 'WHATSAPP_CLOUD' as const;
  readonly capabilities = CLOUD_API_CAPABILITIES;
  readonly experimental = false;

  private handler: MessageHandler | null = null;
  private status: ConnectionStatus = { state: 'not_configured', detail: 'Cloud API settings missing' };

  constructor(
    private readonly config: CloudConfig = getCloudConfig(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const missing = cloudConfigSummary(config).missing;
    if (missing.length) this.status = { state: 'not_configured', detail: `Missing: ${missing.join(', ')}` };
    else this.status = { state: 'disconnected', botId: config.phoneNumberId };
  }

  botId() {
    return this.config.phoneNumberId ?? null;
  }

  onMessage(handler: MessageHandler) {
    this.handler = handler;
  }

  private url(path: string) {
    return `${this.config.graphUrl.replace(/\/+$/, '')}/${this.config.apiVersion}/${path}`;
  }

  private headers() {
    return { authorization: `Bearer ${this.config.accessToken}`, 'content-type': 'application/json' };
  }

  /** Checks the credentials against the phone number; no persistent connection is needed. */
  async connect() {
    const missing = cloudConfigSummary(this.config).missing;
    if (missing.length) {
      this.status = { state: 'not_configured', detail: `Missing: ${missing.join(', ')}` };
      throw new NotConfiguredError(`WhatsApp Cloud API adapter is not configured (missing ${missing.join(', ')})`);
    }
    const res = await this.fetchImpl(this.url(`${encodeURIComponent(this.config.phoneNumberId!)}?fields=display_phone_number,verified_name`), {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as GraphError & { display_phone_number?: string; verified_name?: string };
    if (!res.ok) {
      const message = describeGraphError(res.status, body);
      this.status = { state: 'error', detail: message, botId: this.config.phoneNumberId };
      throw new Error(message);
    }
    this.status = {
      state: 'connected',
      detail: `Number ${body.display_phone_number ?? '?'}${body.verified_name ? ` (${body.verified_name})` : ''}`,
      botId: this.config.phoneNumberId,
    };
  }

  async disconnect() {
    if (this.status.state === 'connected') this.status = { ...this.status, state: 'disconnected', detail: 'Disconnected by an administrator' };
  }

  async getStatus(): Promise<ConnectionStatus> {
    return this.status;
  }

  async sendMessage(destination: MessageDestination, text: string): Promise<SendResult> {
    if (destination.chatType === 'GROUP') throw new CapabilityError('Adapter cannot send GROUP messages');
    if (this.status.state !== 'connected') throw new NotConfiguredError('WhatsApp Cloud API adapter is not connected');
    const res = await this.fetchImpl(this.url(`${encodeURIComponent(this.config.phoneNumberId!)}/messages`), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: destination.chatId,
        type: 'text',
        text: { body: text, preview_url: false },
        ...(destination.replyToMessageId ? { context: { message_id: destination.replyToMessageId } } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as GraphError & { messages?: { id?: string }[] };
    if (!res.ok) throw new Error(describeGraphError(res.status, body));
    const id = body.messages?.[0]?.id;
    if (!id) throw new Error('Cloud API did not return a message id');
    return { externalMessageId: id };
  }

  /** Hands webhook messages to the inbound pipeline (duplicates are dropped there by message id). */
  async receive(messages: NormalizedMessage[]) {
    if (!this.handler) return;
    for (const msg of messages) {
      try {
        await this.handler(msg);
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err), externalMessageId: msg.externalMessageId }, 'cloud inbound failed');
        throw err; // non-200 makes Meta retry the webhook
      }
    }
  }
}

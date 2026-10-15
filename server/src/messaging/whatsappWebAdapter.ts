import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from '../config/env.js';
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
import { CapabilityError } from './types.js';

/**
 * EXPERIMENTAL WhatsApp Web adapter (linked device, QR login) built on Baileys.
 * Unofficial automation may violate WhatsApp's terms and get the number banned; the registry only
 * activates it after a super admin acknowledges that risk. Session files are credentials: they stay
 * in WHATSAPP_WEB_SESSION_DIR, are never logged and are never returned by the API.
 */
export const WHATSAPP_WEB_CAPABILITIES: AdapterCapabilities = {
  receivePrivateMessages: true,
  sendPrivateMessages: true,
  receiveGroupMessages: true,
  sendGroupMessages: true,
  nativeMentions: true,
  quotedReplies: true,
  messageHistory: false,
  notes: [
    'Experimental and unofficial: may violate WhatsApp terms and can get the number banned. Use a separate test number.',
    'Linking a device by QR code does not mean WhatsApp authorizes automated access.',
    'Only messages received while connected are processed; earlier history is not imported.',
    'Message data must not be used to train or improve AI models.',
  ],
};

/** The parts of a Baileys message this adapter reads (kept loose so tests can build fixtures). */
export interface WaRawMessage {
  key?: {
    remoteJid?: string | null;
    remoteJidAlt?: string | null;
    participant?: string | null;
    participantAlt?: string | null;
    fromMe?: boolean | null;
    id?: string | null;
  } | null;
  message?: WaContent | null;
  pushName?: string | null;
  messageTimestamp?: number | { toNumber(): number } | null;
}

interface WaContextInfo {
  mentionedJid?: string[] | null;
  stanzaId?: string | null;
}

interface WaContent {
  conversation?: string | null;
  extendedTextMessage?: { text?: string | null; contextInfo?: WaContextInfo | null } | null;
  imageMessage?: { caption?: string | null; contextInfo?: WaContextInfo | null } | null;
  videoMessage?: { caption?: string | null; contextInfo?: WaContextInfo | null } | null;
  documentMessage?: { caption?: string | null; contextInfo?: WaContextInfo | null } | null;
  ephemeralMessage?: { message?: WaContent | null } | null;
  viewOnceMessage?: { message?: WaContent | null } | null;
  viewOnceMessageV2?: { message?: WaContent | null } | null;
  documentWithCaptionMessage?: { message?: WaContent | null } | null;
  protocolMessage?: unknown;
  reactionMessage?: unknown;
}

/** Minimal surface of a Baileys socket (lets tests inject a fake). */
export interface WaSocketLike {
  user?: { id: string; lid?: string | null } | null;
  ev: { on(event: string, listener: (arg: never) => void): void };
  sendMessage(jid: string, content: { text: string; mentions?: string[] }, options?: { quoted?: unknown }): Promise<{ key?: { id?: string | null } } | undefined>;
  groupMetadata(jid: string): Promise<{ subject?: string }>;
  logout(): Promise<void>;
  end(err: Error | undefined): void;
}

export type WaSocketFactory = (sessionDir: string) => Promise<WaSocketLike>;

/** "123:4@s.whatsapp.net" -> "123@s.whatsapp.net" (drops the device suffix). */
export function normalizeJid(jid: string | null | undefined): string {
  if (!jid) return '';
  const at = jid.indexOf('@');
  if (at < 0) return jid;
  const server = jid.slice(at + 1);
  return `${jid.slice(0, at).split(':')[0]}@${server === 'c.us' ? 's.whatsapp.net' : server}`;
}

function unwrap(content: WaContent | null | undefined): WaContent | null {
  let c = content ?? null;
  for (let i = 0; c && i < 4; i++) {
    const inner = c.ephemeralMessage?.message ?? c.viewOnceMessage?.message ?? c.viewOnceMessageV2?.message ?? c.documentWithCaptionMessage?.message;
    if (!inner) break;
    c = inner;
  }
  return c;
}

function toDate(ts: WaRawMessage['messageTimestamp']): Date {
  const n = typeof ts === 'number' ? ts : ts && typeof ts.toNumber === 'function' ? ts.toNumber() : Number(ts ?? 0);
  return n > 0 ? new Date(n * 1000) : new Date();
}

/** Converts a Baileys message into the provider-neutral shape, or null when it is not a chat message. */
export function normalizeWaMessage(m: WaRawMessage, self: { jid: string | null; lid: string | null }): NormalizedMessage | null {
  const key = m.key;
  const remoteJid = key?.remoteJid;
  if (!key?.id || !remoteJid) return null;
  if (remoteJid.endsWith('@broadcast') || remoteJid.endsWith('@newsletter')) return null;
  const content = unwrap(m.message);
  if (!content || content.protocolMessage || content.reactionMessage) return null;

  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    '';
  const info =
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    content.documentMessage?.contextInfo;

  const isGroup = remoteJid.endsWith('@g.us');
  const rawSender = (isGroup ? key.participant : remoteJid) ?? '';
  const altSender = isGroup ? key.participantAlt : key.remoteJidAlt;
  // Prefer the phone-number JID so a student keeps one identity when WhatsApp switches to LIDs.
  const sender = normalizeJid(rawSender.endsWith('@lid') && altSender ? altSender : rawSender);
  if (!sender) return null;

  // Report mentions as their normalized JIDs/LIDs as-is. A tutor mention may arrive as either the
  // bot's phone JID or its LID, so the router matches against both (see detectInvocation).
  const mentionedIds = (info?.mentionedJid ?? []).map((j) => normalizeJid(j));
  const isSelf = !!key.fromMe || (!!self.jid && sender === self.jid) || (!!self.lid && sender === self.lid);

  return {
    channel: 'WHATSAPP_WEB',
    externalMessageId: key.id,
    chatId: remoteJid,
    chatType: isGroup ? 'GROUP' : 'PRIVATE',
    senderId: sender,
    senderName: m.pushName ?? undefined,
    senderPhone: sender.endsWith('@s.whatsapp.net') ? `+${sender.split('@')[0]}` : undefined,
    text,
    timestamp: toDate(m.messageTimestamp),
    fromMe: isSelf,
    mentionedIds,
    quotedMessageId: info?.stanzaId ?? undefined,
  };
}

/** Loads Baileys lazily so the dependency is only touched when this adapter actually connects. */
const baileysFactory: WaSocketFactory = async (sessionDir) => {
  const baileys = await import('@whiskeysockets/baileys');
  const { default: pino } = await import('pino');
  const { state, saveCreds } = await baileys.useMultiFileAuthState(sessionDir);
  const latest = await baileys.fetchLatestBaileysVersion().catch(() => null);
  const sock = baileys.makeWASocket({
    auth: state,
    // Baileys logs can contain keys and message payloads: keep its logger silent.
    logger: pino({ level: 'silent' }),
    browser: baileys.Browsers.appropriate('Course Tutor'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    ...(latest?.version ? { version: latest.version } : {}),
  });
  sock.ev.on('creds.update', saveCreds);
  return sock as unknown as WaSocketLike;
};

type WebState = 'disconnected' | 'connecting' | 'qr' | 'connected' | 'error';
const LOGGED_OUT = 401;
const RESTART_REQUIRED = 515;
const QUOTE_CACHE = 500;

export class WhatsAppWebAdapter implements MessagingAdapter {
  readonly name = 'whatsapp_web';
  readonly channel = 'WHATSAPP_WEB' as const;
  readonly capabilities = WHATSAPP_WEB_CAPABILITIES;
  readonly experimental = true;

  private sock: WaSocketLike | null = null;
  private handler: MessageHandler | null = null;
  private state: WebState = 'disconnected';
  private detail: string | undefined;
  private qr: string | null = null;
  private selfJid: string | null = null;
  private selfLid: string | null = null;
  private stopping = false;
  private retries = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly recent = new Map<string, WaRawMessage>();
  private readonly groupNames = new Map<string, string>();
  private readonly sessionDir: string;
  private readonly factory: WaSocketFactory;

  constructor(opts: { sessionDir?: string; socketFactory?: WaSocketFactory } = {}) {
    this.sessionDir = resolve(opts.sessionDir ?? env.WHATSAPP_WEB_SESSION_DIR);
    this.factory = opts.socketFactory ?? baileysFactory;
  }

  botId() {
    return this.selfJid;
  }

  /** The bot's LID identity, if known. Group mentions may arrive as this instead of the phone JID. */
  botLid() {
    return this.selfLid;
  }

  loginQr() {
    return this.state === 'qr' ? this.qr : null;
  }

  onMessage(handler: MessageHandler) {
    this.handler = handler;
  }

  async connect() {
    if (this.sock) return;
    this.stopping = false;
    await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
    await this.start();
  }

  async disconnect() {
    this.stopping = true;
    this.clearTimer();
    const sock = this.sock;
    this.sock = null;
    sock?.end(undefined);
    this.setState('disconnected', 'Disconnected by an administrator');
  }

  /** Unlinks the device on WhatsApp and deletes the local session; the next connect shows a new QR. */
  async logout() {
    this.stopping = true;
    this.clearTimer();
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      await sock.logout().catch(() => undefined);
      sock.end(undefined);
    }
    await this.clearSession();
    this.setState('disconnected', 'Logged out. Connect again to scan a new QR code.');
  }

  async getStatus(): Promise<ConnectionStatus> {
    const state = this.state === 'qr' ? 'connecting' : this.state;
    return { state, detail: this.detail, botId: this.selfJid };
  }

  async sendMessage(destination: MessageDestination, text: string): Promise<SendResult> {
    if (!this.sock || this.state !== 'connected') throw new Error('WhatsApp Web is not connected');
    if (destination.chatType === 'GROUP' && !this.capabilities.sendGroupMessages) {
      throw new CapabilityError('Adapter cannot send GROUP messages');
    }
    const mentions = destination.chatType === 'GROUP' ? (destination.mentionIds ?? []).map(normalizeJid).filter(Boolean) : [];
    // WhatsApp only highlights a mention when the text contains "@<number>".
    const tags = mentions.map((j) => `@${j.split('@')[0]}`).filter((t) => !text.includes(t));
    const body = tags.length ? `${tags.join(' ')} ${text}` : text;
    const quoted = destination.replyToMessageId ? this.recent.get(destination.replyToMessageId) : undefined;
    const sent = await this.sock.sendMessage(destination.chatId, mentions.length ? { text: body, mentions } : { text: body }, quoted ? { quoted } : undefined);
    const id = sent?.key?.id;
    if (!id) throw new Error('WhatsApp Web did not return a message id');
    return { externalMessageId: id };
  }

  private async start() {
    this.setState('connecting', 'Connecting to WhatsApp…');
    let sock: WaSocketLike;
    try {
      sock = await this.factory(this.sessionDir);
    } catch (err) {
      this.setState('error', `Could not start WhatsApp Web: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    this.sock = sock;
    sock.ev.on('connection.update', ((u: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }) => {
      void this.onConnectionUpdate(sock, u);
    }) as (arg: never) => void);
    sock.ev.on('messages.upsert', ((u: { messages: WaRawMessage[]; type: string }) => {
      void this.onUpsert(u);
    }) as (arg: never) => void);
  }

  private async onConnectionUpdate(sock: WaSocketLike, u: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }) {
    if (sock !== this.sock) return; // event from a socket we already replaced
    if (u.qr) {
      this.qr = u.qr;
      this.setState('qr', 'Scan the QR code with WhatsApp → Linked devices → Link a device.');
    }
    if (u.connection === 'open') {
      this.qr = null;
      this.retries = 0;
      this.selfJid = normalizeJid(sock.user?.id) || null;
      this.selfLid = normalizeJid(sock.user?.lid) || null;
      this.setState('connected', 'Linked and connected');
      logger.info({ adapter: this.name }, 'WhatsApp Web connected');
    }
    if (u.connection === 'close') {
      this.sock = null;
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (code === LOGGED_OUT) {
        await this.clearSession();
        this.setState('disconnected', 'The device was unlinked from the phone. Connect again to scan a new QR code.');
        logger.warn({ adapter: this.name }, 'WhatsApp Web logged out');
        return;
      }
      if (this.stopping) return;
      const delay = code === RESTART_REQUIRED ? 0 : Math.min(2_000 * 2 ** this.retries, 60_000);
      this.retries++;
      this.setState('connecting', `Connection closed${code ? ` (${code})` : ''}; reconnecting…`);
      logger.warn({ adapter: this.name, code, delay }, 'WhatsApp Web connection closed; reconnecting');
      this.clearTimer();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.stopping && !this.sock) this.start().catch(() => undefined);
      }, delay);
    }
  }

  private async onUpsert(u: { messages: WaRawMessage[]; type: string }) {
    if (u.type !== 'notify') return; // history/append events are not new questions
    for (const raw of u.messages) {
      const msg = normalizeWaMessage(raw, { jid: this.selfJid, lid: this.selfLid });
      if (!msg) continue;
      this.remember(msg.externalMessageId, raw);
      if (msg.fromMe || !this.handler) continue;
      if (msg.chatType === 'GROUP') msg.chatName = await this.groupName(msg.chatId);
      try {
        await this.handler(msg);
      } catch {
        // already logged by the inbound handler; never let it break the socket's event loop
      }
    }
  }

  private remember(id: string, raw: WaRawMessage) {
    this.recent.set(id, raw);
    if (this.recent.size > QUOTE_CACHE) this.recent.delete(this.recent.keys().next().value!);
  }

  private async groupName(jid: string): Promise<string | undefined> {
    const cached = this.groupNames.get(jid);
    if (cached) return cached;
    try {
      const subject = (await this.sock?.groupMetadata(jid))?.subject;
      if (subject) this.groupNames.set(jid, subject);
      return subject;
    } catch {
      return undefined;
    }
  }

  private async clearSession() {
    this.selfJid = null;
    this.selfLid = null;
    this.qr = null;
    await rm(this.sessionDir, { recursive: true, force: true }).catch((err) =>
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'could not delete WhatsApp Web session'),
    );
  }

  private clearTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setState(state: WebState, detail?: string) {
    this.state = state;
    this.detail = detail;
    if (state !== 'qr') this.qr = null;
  }
}

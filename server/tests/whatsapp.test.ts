import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import { activateAdapter, getActiveAdapter, setWhatsAppWebOptions } from '../src/messaging/registry.js';
import { normalizeJid, normalizeWaMessage, type WaRawMessage, type WaSocketLike } from '../src/messaging/whatsappWebAdapter.js';
import { WhatsAppCloudApiAdapter, parseCloudWebhook, setCloudConfig, type CloudConfig } from '../src/messaging/cloudApiAdapter.js';
import { CTR_TRANSCRIPT, app, flushJobs, login, seedTranscript, setupWorld } from './helpers.js';

const SESSION_DIR = '.test-wa-session';
const SELF = { jid: '15550001111@s.whatsapp.net', lid: '99887766@lid' };

class FakeSocket implements WaSocketLike {
  user: { id: string; lid?: string } | null = null;
  readonly sent: { jid: string; content: { text: string; mentions?: string[] }; options?: { quoted?: unknown } }[] = [];
  loggedOut = false;
  private readonly listeners = new Map<string, ((arg: never) => void)[]>();
  ev = {
    on: (event: string, listener: (arg: never) => void) => {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    },
  };
  emit(event: string, arg: unknown) {
    for (const l of this.listeners.get(event) ?? []) l(arg as never);
  }
  async sendMessage(jid: string, content: { text: string; mentions?: string[] }, options?: { quoted?: unknown }) {
    this.sent.push({ jid, content, options });
    return { key: { id: `wa-out-${this.sent.length}` } };
  }
  async groupMetadata() {
    return { subject: 'Batch 7' };
  }
  async logout() {
    this.loggedOut = true;
  }
  end() {}
}

const waText = (p: { id: string; chat: string; participant?: string; participantAlt?: string; text: string; mentions?: string[]; fromMe?: boolean }): WaRawMessage => ({
  key: { remoteJid: p.chat, participant: p.participant, participantAlt: p.participantAlt, id: p.id, fromMe: p.fromMe ?? false },
  pushName: 'Asha',
  messageTimestamp: Math.floor(Date.now() / 1000),
  message: p.mentions ? { extendedTextMessage: { text: p.text, contextInfo: { mentionedJid: p.mentions } } } : { conversation: p.text },
});

describe('WhatsApp Web message normalization', () => {
  it('normalizes private and group messages, preferring phone-number JIDs over LIDs', () => {
    const priv = normalizeWaMessage(waText({ id: 'A1', chat: '919876543210@s.whatsapp.net', text: 'What is CTR?' }), SELF)!;
    expect(priv).toMatchObject({ channel: 'WHATSAPP_WEB', chatType: 'PRIVATE', senderId: '919876543210@s.whatsapp.net', senderPhone: '+919876543210', text: 'What is CTR?' });

    const grp = normalizeWaMessage(
      waText({ id: 'G1', chat: '1203@g.us', participant: '5555@lid', participantAlt: '919876543210@s.whatsapp.net', text: '@tutor what is ROAS?', mentions: ['99887766@lid'] }),
      SELF,
    )!;
    expect(grp.chatType).toBe('GROUP');
    expect(grp.senderId).toBe('919876543210@s.whatsapp.net');
    // A mention of the tutor's LID is reported as the bot id the router compares against.
    expect(grp.mentionedIds).toEqual([SELF.jid]);
  });

  it('skips status broadcasts, reactions and unwraps disappearing messages', () => {
    expect(normalizeWaMessage(waText({ id: 'S1', chat: 'status@broadcast', text: 'hi' }), SELF)).toBeNull();
    expect(normalizeWaMessage({ key: { remoteJid: '1@s.whatsapp.net', id: 'R1' }, message: { reactionMessage: {} } }, SELF)).toBeNull();
    const eph = normalizeWaMessage({ key: { remoteJid: '1@s.whatsapp.net', id: 'E1' }, message: { ephemeralMessage: { message: { conversation: 'hello' } } } }, SELF)!;
    expect(eph.text).toBe('hello');
    expect(normalizeJid('123:7@s.whatsapp.net')).toBe('123@s.whatsapp.net');
    expect(normalizeJid('123@c.us')).toBe('123@s.whatsapp.net');
  });

  it('marks the tutor’s own messages as fromMe', () => {
    const own = normalizeWaMessage(waText({ id: 'O1', chat: '1@s.whatsapp.net', text: 'answer', fromMe: true }), SELF)!;
    expect(own.fromMe).toBe(true);
  });
});

describe('WhatsApp Web adapter (fake socket)', () => {
  let sock: FakeSocket;

  beforeEach(async () => {
    await setupWorld({ settings: { auto_reply_enabled: true, require_enrollment: false } });
    await seedTranscript(CTR_TRANSCRIPT, { moduleName: 'Module 1', lessonTitle: 'CTR basics' });
    sock = new FakeSocket();
    setWhatsAppWebOptions({ sessionDir: SESSION_DIR, socketFactory: async () => sock });
  });

  afterEach(async () => {
    await activateAdapter('mock');
    setWhatsAppWebOptions({});
  });

  async function enableWeb() {
    const sup = await login('SUPER_ADMIN');
    expect((await sup.patch('/api/settings', { messaging_adapter: 'whatsapp_web' })).status).toBe(400); // risk not acknowledged
    await sup.patch('/api/settings', { whatsapp_web_risk_acknowledged: true });
    expect((await sup.patch('/api/settings', { messaging_adapter: 'whatsapp_web' })).status).toBe(200);
    return sup;
  }

  function linkDevice() {
    sock.user = { id: '15550001111:12@s.whatsapp.net', lid: '99887766:12@lid' };
    sock.emit('connection.update', { connection: 'open' });
  }

  it('is off by default, requires the risk acknowledgement, and shows a QR to super admins only', async () => {
    const sup = await enableWeb();
    expect(getActiveAdapter()?.name).toBe('whatsapp_web');

    sock.emit('connection.update', { qr: 'test-qr-payload' });
    const overview = await sup.get('/api/settings/messaging');
    expect(overview.body.login).toEqual({ supported: true, qrAvailable: true });
    expect(overview.body.experimental).toBe(true);
    expect(JSON.stringify(overview.body)).not.toContain('test-qr-payload');

    const qr = await sup.get('/api/settings/messaging/qr');
    expect(qr.body.qr).toMatch(/^data:image\/png;base64,/);
    const reviewer = await login('REVIEWER');
    expect((await reviewer.get('/api/settings/messaging/qr')).status).toBe(403);

    linkDevice();
    const linked = await sup.get('/api/settings/messaging');
    expect(linked.body.status).toMatchObject({ state: 'connected', botId: '15550001111@s.whatsapp.net' });
    expect((await sup.get('/api/settings/messaging/qr')).body.qr).toBeNull();
  });

  it('answers a private message through the normal AI pipeline and quotes the question', async () => {
    await enableWeb();
    linkDevice();
    sock.emit('messages.upsert', { type: 'notify', messages: [waText({ id: 'IN1', chat: '919876543210@s.whatsapp.net', text: 'What is CTR?' })] });
    // Wait until ingest has finished and queued the question (the adapter dispatches
    // the message fire-and-forget, so the row exists before the job is enqueued).
    await vi.waitFor(async () => expect(await prisma.incomingMessage.count({ where: { processingStatus: 'QUEUED' } })).toBe(1));
    await flushJobs();

    const job = await prisma.responseJob.findFirstOrThrow({ include: { delivery: true } });
    expect(job.status).toBe('SENT');
    expect(sock.sent).toHaveLength(1);
    expect(sock.sent[0].jid).toBe('919876543210@s.whatsapp.net');
    expect(sock.sent[0].options?.quoted).toBeTruthy();
    expect(job.delivery?.externalMessageId).toBe('wa-out-1');
  });

  it('replies in an allowlisted group only on a native mention (also via LID) and tags the student', async () => {
    await enableWeb();
    linkDevice();
    await prisma.group.create({ data: { channel: 'WHATSAPP_WEB', externalChatId: '1203@g.us', enabled: true } });
    sock.emit('messages.upsert', {
      type: 'notify',
      messages: [
        waText({ id: 'G1', chat: '1203@g.us', participant: '919876543210@s.whatsapp.net', text: 'just chatting' }),
        waText({ id: 'G2', chat: '1203@g.us', participant: '5555@lid', participantAlt: '919811111111@s.whatsapp.net', text: '@tutor what is CTR?', mentions: ['99887766@lid'] }),
      ],
    });
    await vi.waitFor(async () => expect(await prisma.incomingMessage.count()).toBe(2));
    await flushJobs();

    expect(await prisma.responseJob.count()).toBe(1);
    expect(sock.sent).toHaveLength(1);
    expect(sock.sent[0].content.mentions).toEqual(['919811111111@s.whatsapp.net']);
    expect(sock.sent[0].content.text.startsWith('@919811111111 ')).toBe(true);
    expect((await prisma.group.findFirstOrThrow()).name).toBe('Batch 7');
  });

  it('logout unlinks the device and deletes the stored session', async () => {
    const sup = await enableWeb();
    linkDevice();
    mkdirSync(SESSION_DIR, { recursive: true });
    writeFileSync(`${SESSION_DIR}/creds.json`, '{}');
    const res = await sup.post('/api/settings/messaging/logout');
    expect(res.status).toBe(200);
    expect(res.body.status.state).toBe('disconnected');
    expect(sock.loggedOut).toBe(true);
    expect(existsSync(SESSION_DIR)).toBe(false);
  });
});

const CLOUD: CloudConfig = {
  graphUrl: 'https://graph.test',
  apiVersion: 'v23.0',
  phoneNumberId: '1098765',
  accessToken: 'test-token',
  appSecret: 'app-secret',
  verifyToken: 'verify-me',
};

const sign = (body: string, secret = CLOUD.appSecret!) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const cloudPayload = (value: object) =>
  JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { metadata: { phone_number_id: CLOUD.phoneNumberId }, ...value } }] }] });

const textMessage = (id: string, body: string) =>
  cloudPayload({ contacts: [{ wa_id: '919876543210', profile: { name: 'Asha' } }], messages: [{ from: '919876543210', id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }] });

const postWebhook = (body: string, signature = sign(body)) =>
  request(app).post('/api/webhooks/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', signature).send(body);

describe('WhatsApp Cloud API adapter (fake Graph API)', () => {
  let calls: { url: string; init?: RequestInit }[];

  beforeEach(async () => {
    await setupWorld({ settings: { auto_reply_enabled: true, require_enrollment: false } });
    await seedTranscript(CTR_TRANSCRIPT, { moduleName: 'Module 1', lessonTitle: 'CTR basics' });
    calls = [];
    setCloudConfig(CLOUD);
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/messages')) return Response.json({ messages: [{ id: `wamid.out${calls.length}` }] });
      return Response.json({ display_phone_number: '+91 80000 00000', verified_name: 'Adways Academy' });
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    setCloudConfig(null);
    await activateAdapter('mock');
  });

  async function enableCloud() {
    const sup = await login('SUPER_ADMIN');
    await sup.patch('/api/settings', { cloud_api_policy_acknowledged: true });
    expect((await sup.patch('/api/settings', { messaging_adapter: 'whatsapp_cloud' })).status).toBe(200);
    return sup;
  }

  it('verifies the webhook subscription handshake only with the right token', async () => {
    const ok = await request(app).get('/api/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '12345' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('12345');
    const bad = await request(app).get('/api/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' });
    expect(bad.status).toBe(403);
  });

  it('connects with the configured number and reports which settings are present, never their values', async () => {
    const sup = await enableCloud();
    const res = await sup.get('/api/settings/messaging');
    expect(res.body.status).toMatchObject({ state: 'connected', botId: '1098765' });
    expect(res.body.status.detail).toContain('Adways Academy');
    expect(res.body.cloud).toMatchObject({ phoneNumberId: '1098765', accessTokenSet: true, appSecretSet: true, missing: [] });
    expect(JSON.stringify(res.body)).not.toContain('test-token');
    expect(JSON.stringify(res.body)).not.toContain('app-secret');
  });

  it('rejects webhooks with a missing or wrong signature', async () => {
    await enableCloud();
    const body = textMessage('wamid.in1', 'What is CTR?');
    expect((await postWebhook(body, 'sha256=deadbeef')).status).toBe(401);
    expect((await postWebhook(body, sign(body, 'other-secret'))).status).toBe(401);
    expect(await prisma.incomingMessage.count()).toBe(0);
  });

  it('answers a signed inbound message, drops a retried duplicate and records receipts', async () => {
    await enableCloud();
    const body = textMessage('wamid.in1', 'What is CTR?');
    expect((await postWebhook(body)).status).toBe(200);
    expect((await postWebhook(body)).status).toBe(200); // Meta retry
    expect(await prisma.incomingMessage.count()).toBe(1);
    await flushJobs();

    const job = await prisma.responseJob.findFirstOrThrow({ include: { delivery: true } });
    expect(job.status).toBe('SENT');
    const send = calls.find((c) => c.url.endsWith('/1098765/messages'))!;
    const sent = JSON.parse(String(send.init!.body));
    expect(sent).toMatchObject({ messaging_product: 'whatsapp', to: '919876543210', type: 'text', context: { message_id: 'wamid.in1' } });
    expect((send.init!.headers as Record<string, string>).authorization).toBe('Bearer test-token');

    const outId = job.delivery!.externalMessageId!;
    const receipt = (status: string, extra: object = {}) =>
      cloudPayload({ statuses: [{ id: outId, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '919876543210', ...extra }] });
    await postWebhook(receipt('read'));
    await postWebhook(receipt('delivered')); // out of order: must not downgrade
    expect((await prisma.messageDelivery.findFirstOrThrow()).providerStatus).toBe('read');

    await postWebhook(receipt('failed', { errors: [{ code: 131026, title: 'Message undeliverable' }] }));
    const failed = await prisma.responseJob.findFirstOrThrow({ include: { delivery: true } });
    expect(failed.status).toBe('FAILED');
    expect(failed.delivery?.status).toBe('FAILED');
    expect(failed.lastError).toMatch(/131026/);
  });

  it('explains the 24-hour window error and never sends to groups', async () => {
    const adapter = new WhatsAppCloudApiAdapter(CLOUD, (async (url: string) =>
      url.endsWith('/messages')
        ? Response.json({ error: { message: 'Re-engagement message', code: 131047 } }, { status: 400 })
        : Response.json({ display_phone_number: '+91' })) as typeof fetch);
    await adapter.connect();
    await expect(adapter.sendMessage({ channel: 'WHATSAPP_CLOUD', chatId: '1', chatType: 'PRIVATE' }, 'hi')).rejects.toThrow(/24-hour/);
    await expect(adapter.sendMessage({ channel: 'WHATSAPP_CLOUD', chatId: 'g', chatType: 'GROUP' }, 'hi')).rejects.toThrow(/GROUP/);
  });

  it('ignores webhook entries for other phone numbers', () => {
    const other = JSON.parse(textMessage('wamid.x', 'hi'));
    other.entry[0].changes[0].value.metadata.phone_number_id = 'someone-else';
    expect(parseCloudWebhook(other, CLOUD.phoneNumberId).messages).toHaveLength(0);
  });
});

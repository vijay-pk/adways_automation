import { describe, expect, it } from 'vitest';
import { normalizeWaMessage, type WaRawMessage } from '../src/messaging/whatsappWebAdapter.js';

const SELF = { jid: '917560923240@s.whatsapp.net', lid: '123456@lid' };

function groupMention(mentioned: string[]): WaRawMessage {
  return {
    key: { remoteJid: 'group-1@g.us', participant: '917560923202@s.whatsapp.net', id: 'M1', fromMe: false },
    message: { extendedTextMessage: { text: '@CourseAI what is CTR?', contextInfo: { mentionedJid: mentioned } } },
    pushName: 'Student',
    messageTimestamp: 1_700_000_000,
  };
}

describe('WhatsApp Web mention normalization', () => {
  it('keeps a mention that targets the bot LID as a raw LID (no collapse to the phone JID)', () => {
    const msg = normalizeWaMessage(groupMention([SELF.lid]), SELF);
    expect(msg?.mentionedIds).toEqual([SELF.lid]);
  });

  it('keeps a mention that targets the bot phone JID as-is', () => {
    const msg = normalizeWaMessage(groupMention([SELF.jid]), SELF);
    expect(msg?.mentionedIds).toEqual([SELF.jid]);
  });

  it('normalizes a device-suffixed mention JID', () => {
    const msg = normalizeWaMessage(groupMention(['917560923240:12@s.whatsapp.net']), SELF);
    expect(msg?.mentionedIds).toEqual([SELF.jid]);
  });
});

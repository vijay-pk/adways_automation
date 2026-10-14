import express, { Router } from 'express';
import { safeEqual } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { recordProviderStatus } from '../responses/deliveryService.js';
import { getActiveAdapter } from './registry.js';
import { WhatsAppCloudApiAdapter, getCloudConfig, parseCloudWebhook, verifyCloudSignature } from './cloudApiAdapter.js';

/**
 * Public webhook for the WhatsApp Cloud API (configure in Meta: <APP_ORIGIN>/api/webhooks/whatsapp).
 * Mounted before the JSON parser so the signature is checked against the exact raw body.
 */
export const cloudWebhookRouter = Router();

// Meta's subscription handshake.
cloudWebhookRouter.get('/', (req, res) => {
  const { verifyToken } = getCloudConfig();
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && verifyToken && typeof token === 'string' && safeEqual(token, verifyToken) && typeof challenge === 'string') {
    res.type('text/plain').send(challenge);
    return;
  }
  res.sendStatus(403);
});

cloudWebhookRouter.post('/', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const cfg = getCloudConfig();
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!cfg.appSecret || !verifyCloudSignature(raw, req.get('x-hub-signature-256'), cfg.appSecret)) {
    res.sendStatus(401);
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    res.sendStatus(400);
    return;
  }

  const { messages, statuses } = parseCloudWebhook(payload, cfg.phoneNumberId);
  try {
    for (const s of statuses) await recordProviderStatus(s);
    const adapter = getActiveAdapter();
    if (adapter instanceof WhatsAppCloudApiAdapter) await adapter.receive(messages);
    else if (messages.length) logger.warn({ count: messages.length }, 'Cloud API messages received while the Cloud API adapter is not active; ignored');
  } catch {
    res.sendStatus(500); // Meta retries; duplicate message ids are dropped on ingest
    return;
  }
  res.sendStatus(200);
});

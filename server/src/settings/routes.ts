import { Router } from 'express';
import { z } from 'zod';
import { requireRole, SUPER, CAN_REVIEW } from '../auth/middleware.js';
import { getSettings, updateSettings, type Settings } from './settingsService.js';
import { audit } from '../audit/auditService.js';
import { parseBody } from '../lib/validate.js';
import { badRequest } from '../lib/errors.js';
import {
  activateAdapter,
  adapterOverview,
  assertAdapterAllowed,
  connectActive,
  disconnectActive,
  getLoginQr,
  logoutActive,
} from '../messaging/registry.js';
import { queueStats } from '../jobs/queue.js';
import QRCode from 'qrcode';
import { env } from '../config/env.js';

export const settingsRouter = Router();

settingsRouter.get('/', async (_req, res) => {
  res.json(await getSettings());
});

/** Full settings changes are restricted to super admins. */
settingsRouter.patch('/', requireRole(...SUPER), async (req, res) => {
  const patch = (req.body ?? {}) as Partial<Settings>;
  if ('platform_data_ai_training_allowed' in patch && patch.platform_data_ai_training_allowed !== false) {
    throw badRequest('Using platform message data for AI training is prohibited and cannot be enabled.');
  }
  const before = await getSettings();
  if (patch.messaging_adapter && patch.messaging_adapter !== before.messaging_adapter) {
    assertAdapterAllowed(patch.messaging_adapter, { ...before, ...patch } as Settings);
  }
  const after = await updateSettings(patch, req.auth!.admin.id);
  const changed = Object.keys(patch).filter((k) => JSON.stringify(before[k as keyof Settings]) !== JSON.stringify(after[k as keyof Settings]));
  await audit(req.auth!.admin.id, 'settings.update', 'settings', undefined, {
    changes: Object.fromEntries(changed.map((k) => [k, { from: before[k as keyof Settings], to: after[k as keyof Settings] }])),
  });
  if (after.messaging_adapter !== before.messaging_adapter) await activateAdapter(after.messaging_adapter, after);
  else if (after.messaging_connection_enabled !== before.messaging_connection_enabled) {
    if (after.messaging_connection_enabled) await connectActive();
    else await disconnectActive();
  }
  res.json(after);
});

const emergencySchema = z
  .object({
    pause_all_outgoing: z.boolean(),
    pause_group_replies: z.boolean(),
    pause_private_replies: z.boolean(),
    auto_reply_enabled: z.literal(false),
    messaging_connection_enabled: z.boolean(),
  })
  .partial();

const STOP_ONLY: Record<string, unknown> = {
  pause_all_outgoing: true,
  pause_group_replies: true,
  pause_private_replies: true,
  messaging_connection_enabled: false,
};

/**
 * Emergency controls. Reviewers may engage any stop; only super admins may lift one.
 * Takes effect immediately: the router and delivery worker read settings fresh from the DB.
 */
settingsRouter.post('/emergency', requireRole(...CAN_REVIEW), async (req, res) => {
  const body = parseBody(emergencySchema, req.body ?? {});
  const isSuper = req.auth!.admin.role === 'SUPER_ADMIN';
  for (const [k, v] of Object.entries(body)) {
    const isStop = k === 'auto_reply_enabled' ? v === false : STOP_ONLY[k] === v;
    if (!isStop && !isSuper) throw badRequest('Only a super admin can lift an emergency stop');
  }
  const after = await updateSettings(body, req.auth!.admin.id);
  if (body.messaging_connection_enabled === false) await disconnectActive();
  if (body.messaging_connection_enabled === true) await connectActive();
  await audit(req.auth!.admin.id, 'emergency.update', 'settings', undefined, body);
  res.json(after);
});

settingsRouter.get('/messaging', async (_req, res) => {
  const [overview, settings] = await Promise.all([adapterOverview(), getSettings()]);
  res.json({
    ...overview,
    queue: await queueStats(),
    webChatEnabled: settings.web_chat_enabled,
    cloudWebhookUrl: `${env.APP_ORIGIN.replace(/\/+$/, '')}/api/webhooks/whatsapp`,
  });
});

/** Login QR for a linked-device adapter, as an image. It links a device to this server, so super admins only. */
settingsRouter.get('/messaging/qr', requireRole(...SUPER), async (_req, res) => {
  const qr = getLoginQr();
  res.set('Cache-Control', 'no-store');
  res.json({ qr: qr ? await QRCode.toDataURL(qr, { margin: 1, width: 280 }) : null });
});

/** Starts (or retries) the active adapter's connection, e.g. to show a fresh QR code. */
settingsRouter.post('/messaging/connect', requireRole(...SUPER), async (req, res) => {
  const settings = await getSettings();
  if (!settings.messaging_connection_enabled) throw badRequest('Messaging connection is switched off in emergency controls');
  await connectActive();
  await audit(req.auth!.admin.id, 'messaging.connect', 'settings');
  res.json(await adapterOverview());
});

/** Unlinks the WhatsApp Web device and deletes the stored session. */
settingsRouter.post('/messaging/logout', requireRole(...SUPER), async (req, res) => {
  await logoutActive();
  await audit(req.auth!.admin.id, 'messaging.logout', 'settings');
  res.json(await adapterOverview());
});

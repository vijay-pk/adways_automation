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
  getActiveAdapter,
  getLoginQr,
  logoutActive,
} from '../messaging/registry.js';
import { queueStats } from '../jobs/queue.js';
import { prisma } from '../db/prisma.js';
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
  // Acknowledging the gate for the already-selected adapter should bring it up, since
  // activation was refused (at boot or when it was selected) while it was unacknowledged.
  const nowAcknowledged =
    (after.messaging_adapter === 'whatsapp_web' && !before.whatsapp_web_risk_acknowledged && after.whatsapp_web_risk_acknowledged) ||
    (after.messaging_adapter === 'whatsapp_cloud' && !before.cloud_api_policy_acknowledged && after.cloud_api_policy_acknowledged);
  if (after.messaging_adapter !== before.messaging_adapter || (nowAcknowledged && getActiveAdapter()?.name !== after.messaging_adapter)) {
    await activateAdapter(after.messaging_adapter, after);
  } else if (after.messaging_connection_enabled !== before.messaging_connection_enabled) {
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

type InboundRow = {
  processingStatus: string;
  isMention: boolean;
  mentionMetadata: unknown;
  conversation: { chatType: string };
  student: { enrollmentStatus: string } | null;
};

/** Plain-language reason a captured message was accepted, held as context, or blocked. */
function describeInbound(m: InboundRow, settings: Settings): string {
  switch (m.processingStatus) {
    case 'QUEUED':
    case 'CONSUMED':
      return 'Accepted for AI processing';
    case 'CONTEXT_ONLY':
      return m.conversation.chatType === 'GROUP'
        ? 'Group message without a tutor mention — kept as context only'
        : 'Replies are turned off for this chat type — kept as context only';
    case 'BLOCKED':
      return settings.require_enrollment && m.student?.enrollmentStatus !== 'ACTIVE'
        ? `Sender not enrolled — enrollment is required (sender is ${m.student?.enrollmentStatus ?? 'unknown'})`
        : 'Per-sender rate limit reached';
    case 'IGNORED':
      return 'Ignored';
    default:
      return 'Received — not yet processed';
  }
}

/**
 * Recent inbound-message diagnostics: shows why each captured message was accepted,
 * held as context, or blocked, so an empty approval queue can be explained. Super admins
 * only; returns metadata and a derived reason, never the message text.
 */
settingsRouter.get('/messaging/inbound-log', requireRole(...SUPER), async (_req, res) => {
  const [settings, rows] = await Promise.all([
    getSettings(),
    prisma.incomingMessage.findMany({
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: {
        id: true,
        channel: true,
        senderExternalId: true,
        isMention: true,
        mentionMetadata: true,
        processingStatus: true,
        createdAt: true,
        conversation: { select: { chatType: true } },
        student: { select: { enrollmentStatus: true } },
      },
    }),
  ]);
  const adapter = getActiveAdapter();
  res.set('Cache-Control', 'no-store');
  res.json({
    bot: {
      botId: adapter?.botId() ?? null,
      botLid: (adapter as { botLid?(): string | null } | null)?.botLid?.() ?? null,
    },
    items: rows.map((m) => {
      const meta = m.mentionMetadata as { via?: string; mentionedIds?: string[] } | null;
      return {
        id: m.id,
        channel: m.channel,
        chatType: m.conversation.chatType,
        sender: m.senderExternalId,
        isMention: m.isMention,
        mentionedIds: meta?.mentionedIds ?? [],
        via: meta?.via ?? null,
        status: m.processingStatus,
        reason: describeInbound(m as InboundRow, settings),
        at: m.createdAt,
      };
    }),
  });
});

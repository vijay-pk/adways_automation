import { z } from 'zod';
import { prisma, type Db } from '../db/prisma.js';
import { badRequest } from '../lib/errors.js';

/**
 * Typed application settings. Secrets (API keys, passwords) never live here —
 * they stay in environment variables.
 */
export const settingsSchema = z.object({
  auto_reply_enabled: z.boolean(),
  pause_all_outgoing: z.boolean(),
  pause_group_replies: z.boolean(),
  pause_private_replies: z.boolean(),
  messaging_connection_enabled: z.boolean(),
  messaging_adapter: z.enum(['mock', 'whatsapp_web', 'whatsapp_cloud']),
  group_replies_enabled: z.boolean(),
  private_replies_enabled: z.boolean(),
  text_command_mode_enabled: z.boolean(),
  text_command: z.string().min(1).max(30),
  bot_display_name: z.string().min(1).max(60),
  require_enrollment: z.boolean(),
  max_response_chars: z.number().int().min(200).max(4000),
  context_window_minutes: z.number().int().min(1).max(60),
  context_max_messages: z.number().int().min(1).max(30),
  followup_window_minutes: z.number().int().min(1).max(240),
  debounce_seconds: z.number().int().min(0).max(60),
  student_daily_limit: z.number().int().min(1).max(500),
  student_per_minute_limit: z.number().int().min(1).max(30),
  retrieval_top_k: z.number().int().min(1).max(15),
  example_top_k: z.number().int().min(0).max(10),
  semantic_min_similarity: z.number().min(0).max(1),
  max_upload_mb: z.number().min(1).max(500),
  message_retention_days: z.number().int().min(1).max(3650),
  daily_ai_budget_usd: z.number().min(0).max(1000),
  web_chat_enabled: z.boolean(),
  web_chat_url: z.string().max(300),
  // Compliance: message data is never used to train/improve AI models. Locked false.
  platform_data_ai_training_allowed: z.literal(false),
  cloud_api_policy_acknowledged: z.boolean(),
  whatsapp_web_risk_acknowledged: z.boolean(),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = {
  auto_reply_enabled: false,
  pause_all_outgoing: false,
  pause_group_replies: false,
  pause_private_replies: false,
  messaging_connection_enabled: true,
  messaging_adapter: 'mock',
  group_replies_enabled: true,
  private_replies_enabled: true,
  text_command_mode_enabled: false,
  text_command: '!tutor',
  bot_display_name: 'CourseAI',
  require_enrollment: true,
  max_response_chars: 1500,
  context_window_minutes: 5,
  context_max_messages: 10,
  followup_window_minutes: 15,
  debounce_seconds: 6,
  student_daily_limit: 30,
  student_per_minute_limit: 4,
  retrieval_top_k: 6,
  example_top_k: 3,
  semantic_min_similarity: 0.3,
  max_upload_mb: 20,
  message_retention_days: 30,
  daily_ai_budget_usd: 5,
  web_chat_enabled: true,
  web_chat_url: '',
  platform_data_ai_training_allowed: false,
  cloud_api_policy_acknowledged: false,
  whatsapp_web_risk_acknowledged: false,
};

/** Read settings fresh from the DB (no cache) so emergency switches take effect immediately. */
export async function getSettings(db: Db = prisma): Promise<Settings> {
  const rows = await db.applicationSetting.findMany();
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (row.key in DEFAULT_SETTINGS) merged[row.key] = row.value;
  }
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS, ...partialValid(merged) };
}

function partialValid(merged: Record<string, unknown>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) {
    const r = settingsSchema.shape[key].safeParse(merged[key]);
    if (r.success) out[key] = r.data;
  }
  return out as Partial<Settings>;
}

export async function updateSettings(
  patch: Partial<Record<string, unknown>>,
  adminId: string | null,
  db: Db = prisma,
): Promise<Settings> {
  const parsed = settingsSchema.partial().strict().safeParse(patch);
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path}: ${i.message}`).join('; '));
  for (const [key, value] of Object.entries(parsed.data)) {
    await db.applicationSetting.upsert({
      where: { key },
      create: { key, value: value as never, updatedById: adminId },
      update: { value: value as never, updatedById: adminId },
    });
  }
  return getSettings(db);
}

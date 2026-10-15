import type { FileStorage } from '../storage/index.js';

/** Storage key for the single JSON blob that holds the WhatsApp Web linked-device session. */
export const WA_SESSION_KEY = 'wa-session/auth.json';

type MultiFileAuthReturn = Awaited<ReturnType<typeof import('@whiskeysockets/baileys').useMultiFileAuthState>>;

/**
 * Baileys auth state persisted as a single JSON blob in FileStorage instead of the local
 * filesystem. With STORAGE_PROVIDER=supabase this keeps the linked-device session in the private
 * Supabase bucket, so it survives container restarts and redeploys (no QR re-scan). The blob holds
 * the credentials and signal keys, so it is as sensitive as the session files; the bucket is private
 * and read only with the service-role key.
 */
export async function useRemoteAuthState(storage: FileStorage, key = WA_SESSION_KEY): Promise<MultiFileAuthReturn> {
  const { initAuthCreds, BufferJSON, proto } = await import('@whiskeysockets/baileys');

  let loaded: { creds?: unknown; keys?: Record<string, Record<string, unknown>> } = {};
  try {
    const buf = await storage.get(key);
    loaded = JSON.parse(buf.toString('utf8'), BufferJSON.reviver);
  } catch {
    loaded = {}; // no saved session yet (or unreadable) → start fresh and show a QR
  }

  const creds = (loaded.creds as ReturnType<typeof initAuthCreds>) ?? initAuthCreds();
  const keys: Record<string, Record<string, unknown>> = loaded.keys ?? {};

  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = async () => {
    timer = null;
    const body = Buffer.from(JSON.stringify({ creds, keys }, BufferJSON.replacer), 'utf8');
    await storage.put(key, body, 'application/json');
  };
  // Signal keys are written often during the handshake; coalesce writes, but persist creds at once.
  const schedule = () => {
    if (!timer) timer = setTimeout(() => void flush().catch(() => undefined), 400);
  };

  const state = {
    creds,
    keys: {
      get: (type: string, ids: string[]) => {
        const store = keys[type] ?? {};
        const out: Record<string, unknown> = {};
        for (const id of ids) {
          let value = store[id];
          if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
          out[id] = value;
        }
        return out;
      },
      set: (data: Record<string, Record<string, unknown>>) => {
        for (const type of Object.keys(data)) {
          keys[type] ??= {};
          for (const id of Object.keys(data[type])) {
            const value = data[type][id];
            if (value) keys[type][id] = value;
            else delete keys[type][id];
          }
        }
        schedule();
      },
    },
  };

  return { state, saveCreds: flush } as unknown as MultiFileAuthReturn;
}

/** Deletes the stored session (used on logout so the next connect shows a fresh QR). */
export async function clearRemoteAuthState(storage: FileStorage, key = WA_SESSION_KEY) {
  await storage.delete(key).catch(() => undefined);
}

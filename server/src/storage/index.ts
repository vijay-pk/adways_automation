import { join } from 'node:path';
import { env } from '../config/env.js';
import type { FileStorage } from './types.js';
import { LocalFileStorage } from './localStorage.js';
import { SupabaseFileStorage } from './supabaseStorage.js';

export type { FileStorage } from './types.js';

let instance: FileStorage | null = null;

export function getStorage(): FileStorage {
  instance ??=
    env.STORAGE_PROVIDER === 'supabase'
      ? new SupabaseFileStorage(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, env.SUPABASE_STORAGE_BUCKET, env.MAX_UPLOAD_MB * 1024 * 1024)
      : new LocalFileStorage(join(env.UPLOAD_DIR, 'originals'));
  return instance;
}

/** Test hook. */
export const setStorage = (s: FileStorage) => {
  instance = s;
};

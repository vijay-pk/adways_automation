/** Where original transcript files live. Keys are opaque, e.g. "transcripts/<sha256>.pdf". */
export interface FileStorage {
  readonly name: 'local' | 'supabase';
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Creates the bucket/directory if needed and verifies it is private. */
  ensureReady(): Promise<void>;
}

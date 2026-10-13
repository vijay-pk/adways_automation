import type { FileStorage } from './types.js';

/**
 * Private Supabase Storage bucket accessed only from the server with the service-role key.
 * The key never leaves the backend; files are never given public URLs.
 */
export class SupabaseFileStorage implements FileStorage {
  readonly name = 'supabase' as const;
  private readonly base: string;

  constructor(
    url: string,
    private readonly serviceKey: string,
    private readonly bucket: string,
    private readonly maxBytes?: number,
  ) {
    this.base = `${url.replace(/\/+$/, '')}/storage/v1`;
  }

  private headers(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.serviceKey}`, apikey: this.serviceKey, ...extra };
  }

  private objectUrl(key: string) {
    return `${this.base}/object/${encodeURIComponent(this.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async fail(res: Response, action: string): Promise<never> {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase Storage ${action} failed (${res.status}): ${body.slice(0, 200)}`);
  }

  async ensureReady() {
    const res = await fetch(`${this.base}/bucket/${encodeURIComponent(this.bucket)}`, { headers: this.headers() });
    if (res.ok) {
      const bucket = (await res.json()) as { public?: boolean };
      if (bucket.public) throw new Error(`Supabase bucket "${this.bucket}" is public; make it private before storing transcripts`);
      return;
    }
    const created = await fetch(`${this.base}/bucket`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ id: this.bucket, name: this.bucket, public: false, ...(this.maxBytes ? { file_size_limit: this.maxBytes } : {}) }),
    });
    if (!created.ok) await this.fail(created, 'bucket creation');
  }

  async put(key: string, data: Buffer, contentType: string) {
    const res = await fetch(this.objectUrl(key), {
      method: 'POST',
      headers: this.headers({ 'content-type': contentType || 'application/octet-stream', 'x-upsert': 'true' }),
      body: new Uint8Array(data),
    });
    if (!res.ok) await this.fail(res, 'upload');
  }

  async get(key: string) {
    const res = await fetch(this.objectUrl(key), { headers: this.headers() });
    if (!res.ok) await this.fail(res, 'download');
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string) {
    const res = await fetch(`${this.base}/object/${encodeURIComponent(this.bucket)}`, {
      method: 'DELETE',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ prefixes: [key] }),
    });
    if (!res.ok && res.status !== 404) await this.fail(res, 'delete');
  }
}

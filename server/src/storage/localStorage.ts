import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { FileStorage } from './types.js';

/** Stores originals on the server's disk (outside any publicly served directory). */
export class LocalFileStorage implements FileStorage {
  readonly name = 'local' as const;
  constructor(private readonly root: string) {}

  private path(key: string) {
    const root = resolve(this.root);
    const full = resolve(root, key);
    if (!full.startsWith(root + sep)) throw new Error('Invalid storage key');
    return full;
  }

  async ensureReady() {
    await mkdir(resolve(this.root), { recursive: true });
  }

  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }

  async get(key: string) {
    return readFile(this.path(key));
  }

  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}

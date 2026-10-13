import type { Embedder } from './index.js';
import { extractKeywords } from '../retrieval/query.js';

const DIMS = 1024;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic local embedding (hashed words + character trigrams) for development and tests.
 * Tolerates spelling variants the full-text index misses; not a substitute for a real model.
 */
export class MockEmbedder implements Embedder {
  readonly id = 'mock:hash-1024';
  failNext = 0;
  calls = 0;

  vector(text: string): number[] {
    const v = new Array<number>(DIMS).fill(0);
    for (const word of extractKeywords(text)) {
      v[hash(`w:${word}`) % DIMS] += 3;
      const padded = `_${word}_`;
      for (let i = 0; i + 3 <= padded.length; i++) v[hash(`t:${padded.slice(i, i + 3)}`) % DIMS] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }

  async embed(texts: string[]) {
    this.calls++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('Simulated embedding provider failure');
    }
    return { vectors: texts.map((t) => this.vector(t)), inputTokens: texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0) };
  }
}

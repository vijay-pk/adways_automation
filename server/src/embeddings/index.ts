import { env } from '../config/env.js';
import { recordUsage } from '../ai/index.js';

export interface Embedder {
  /** Identifier stored with each chunk, e.g. "openai_compatible:text-embedding-3-small". */
  readonly id: string;
  embed(texts: string[]): Promise<{ vectors: number[][]; inputTokens: number }>;
}

/**
 * Any OpenAI-compatible /embeddings endpoint (OpenAI, Together, Mistral, Jina, Ollama, ...).
 * Groq's chat API is not used for embeddings.
 */
export class OpenAICompatibleEmbedder implements Embedder {
  readonly id: string;
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly dimensions?: number,
  ) {
    this.id = `openai_compatible:${model}${dimensions ? `:${dimensions}` : ''}`;
  }

  async embed(texts: string[]) {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: texts, ...(this.dimensions ? { dimensions: this.dimensions } : {}) }),
        signal: AbortSignal.timeout(env.AI_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { data: { index: number; embedding: number[] }[]; usage?: { prompt_tokens?: number; total_tokens?: number } };
        const vectors = [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
        if (vectors.length !== texts.length) throw new Error('Embedding provider returned an unexpected number of vectors');
        return { vectors, inputTokens: body.usage?.prompt_tokens ?? body.usage?.total_tokens ?? 0 };
      }
      const text = await res.text().catch(() => '');
      lastErr = new Error(`Embedding API ${res.status}: ${text.slice(0, 300)}`);
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    throw lastErr;
  }
}

let instance: Embedder | null | undefined;

export async function createDefaultEmbedder(): Promise<Embedder | null> {
  if (env.EMBEDDING_PROVIDER === 'openai_compatible') {
    return new OpenAICompatibleEmbedder(env.EMBEDDING_BASE_URL, env.EMBEDDING_API_KEY!, env.EMBEDDING_MODEL, env.EMBEDDING_DIMENSIONS);
  }
  if (env.EMBEDDING_PROVIDER === 'mock') {
    const { MockEmbedder } = await import('./mockEmbedder.js');
    return new MockEmbedder();
  }
  return null;
}

/** Returns the configured embedder, or null when semantic search is disabled. */
export async function getEmbedder(): Promise<Embedder | null> {
  if (instance === undefined) instance = await createDefaultEmbedder();
  return instance;
}

/** Test hook. */
export const setEmbedder = (e: Embedder | null) => {
  instance = e;
};

/** Embeds texts in batches and records the estimated cost. */
export async function embedAll(embedder: Embedder, texts: string[], responseJobId: string | null = null): Promise<number[][]> {
  const out: number[][] = [];
  let tokens = 0;
  for (let i = 0; i < texts.length; i += env.EMBEDDING_BATCH_SIZE) {
    const { vectors, inputTokens } = await embedder.embed(texts.slice(i, i + env.EMBEDDING_BATCH_SIZE));
    out.push(...vectors);
    tokens += inputTokens;
  }
  const [provider, model] = embedder.id.split(':');
  await recordUsage({ provider: provider === 'mock' ? 'mock' : `embedding:${provider}`, model: model ?? embedder.id, inputTokens: tokens, outputTokens: 0 }, 'embedding', responseJobId);
  return out;
}

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { getStorage } from '../storage/index.js';
import { getEmbedder } from '../embeddings/index.js';
import { detectVectorBackend } from '../embeddings/vectorStore.js';
import { adapterOverview } from '../messaging/registry.js';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  latencyMs?: number;
}

async function timed(name: string, fn: () => Promise<string>): Promise<Check> {
  const start = Date.now();
  try {
    return { name, ok: true, detail: await fn(), latencyMs: Date.now() - start };
  } catch (err) {
    return { name, ok: false, detail: (err instanceof Error ? err.message : String(err)).slice(0, 300), latencyMs: Date.now() - start };
  }
}

/** Lists models with the configured key: verifies reachability and credentials without spending tokens. */
async function pingModels(baseUrl: string, apiKey: string, label: string) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${label} responded ${res.status}`);
  return `${label} reachable, credentials accepted`;
}

let cache: { at: number; checks: Check[] } | null = null;

/** Health of every external dependency. Cached briefly so the dashboard cannot hammer providers. */
export async function integrationHealth(force = false): Promise<Check[]> {
  if (!force && cache && Date.now() - cache.at < 30_000) return cache.checks;
  const checks = await Promise.all([
    timed('database', async () => {
      await prisma.$queryRaw`SELECT 1`;
      const backend = await detectVectorBackend();
      return `connected · embedding column: ${backend.kind}`;
    }),
    timed('ai_generation', async () => {
      if (env.AI_PROVIDER === 'mock') return 'mock provider (development only)';
      return pingModels(env.GROQ_BASE_URL, env.GROQ_API_KEY ?? '', 'Groq');
    }),
    timed('embeddings', async () => {
      const e = await getEmbedder();
      if (!e) return 'disabled (full-text search only)';
      if (env.EMBEDDING_PROVIDER !== 'openai_compatible') return `${e.id} (development only)`;
      return `${await pingModels(env.EMBEDDING_BASE_URL, env.EMBEDDING_API_KEY ?? '', 'Embedding API')} · ${e.id}`;
    }),
    timed('file_storage', async () => {
      const s = getStorage();
      await s.ensureReady();
      return s.name === 'supabase' ? `Supabase bucket "${env.SUPABASE_STORAGE_BUCKET}" (private)` : 'local disk';
    }),
    timed('messaging', async () => {
      const o = await adapterOverview();
      if (!o.adapter) throw new Error(o.lastError ?? 'no adapter active');
      if (o.status.state !== 'connected') throw new Error(`${o.adapter}: ${o.status.state}${o.lastError ? ` – ${o.lastError}` : ''}`);
      return `${o.adapter} connected`;
    }),
    timed('job_queue', async () => {
      const [pending, failed, stale] = await Promise.all([
        prisma.job.count({ where: { status: 'PENDING', runAt: { lt: new Date(Date.now() - 5 * 60_000) } } }),
        prisma.job.count({ where: { status: 'FAILED', updatedAt: { gt: new Date(Date.now() - 86_400_000) } } }),
        prisma.job.count({ where: { status: 'RUNNING', lockedAt: { lt: new Date(Date.now() - 10 * 60_000) } } }),
      ]);
      if (pending > 20 || stale > 0) throw new Error(`${pending} overdue, ${stale} stuck jobs — is the worker running?`);
      return `${failed} failed in last 24h`;
    }),
  ]);
  cache = { at: Date.now(), checks };
  return checks;
}

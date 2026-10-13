import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  APP_ORIGIN: z.string().default('http://localhost:5173'),
  SESSION_TTL_HOURS: z.coerce.number().default(8),
  UPLOAD_DIR: z.string().default('uploads'),
  // Hard ceiling for any upload; the admin-configurable limit (settings) applies below this.
  MAX_UPLOAD_MB: z.coerce.number().default(25),
  // Original transcript files: "local" disk or a private Supabase Storage bucket.
  STORAGE_PROVIDER: z.enum(['local', 'supabase']).default('local'),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('transcripts'),
  // Embeddings are configured independently of the Groq chat model.
  EMBEDDING_PROVIDER: z.enum(['none', 'openai_compatible', 'mock']).default('none'),
  EMBEDDING_BASE_URL: z.string().default('https://api.openai.com/v1'),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().optional(),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(256).default(64),
  EMBEDDING_PRICE_PER_M: z.coerce.number().default(0.02),
  AI_PROVIDER: z.enum(['groq', 'mock']).default('mock'),
  GROQ_API_KEY: z.string().optional(),
  GROQ_BASE_URL: z.string().default('https://api.groq.com/openai/v1'),
  GROQ_ANSWER_MODEL: z.string().default('llama-3.3-70b-versatile'),
  GROQ_FAST_MODEL: z.string().default('llama-3.1-8b-instant'),
  // USD per 1M tokens, used for cost estimates only.
  AI_PRICE_INPUT_PER_M: z.coerce.number().default(0.59),
  AI_PRICE_OUTPUT_PER_M: z.coerce.number().default(0.79),
  AI_TIMEOUT_MS: z.coerce.number().default(30000),
  WORKER_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  WORKER_POLL_MS: z.coerce.number().default(1000),
  SERVE_WEB_DIST: z.string().optional(),
  ENABLE_DEV_ROUTES: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.string().default('info'),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  if (parsed.data.AI_PROVIDER === 'groq' && !parsed.data.GROQ_API_KEY) {
    throw new Error('AI_PROVIDER=groq requires GROQ_API_KEY');
  }
  if (parsed.data.STORAGE_PROVIDER === 'supabase' && (!parsed.data.SUPABASE_URL || !parsed.data.SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error('STORAGE_PROVIDER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  if (parsed.data.EMBEDDING_PROVIDER === 'openai_compatible' && !parsed.data.EMBEDDING_API_KEY) {
    throw new Error('EMBEDDING_PROVIDER=openai_compatible requires EMBEDDING_API_KEY');
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.ENABLE_DEV_ROUTES) {
    throw new Error('ENABLE_DEV_ROUTES must not be enabled in production');
  }
  return parsed.data;
}

export const env = load();
export const isProd = env.NODE_ENV === 'production';

import { z } from 'zod';
import { env } from '../config/env.js';
import { buildCorrelatePrompt, buildGeneratePrompt } from './prompts.js';
import type { AIResult, CorrelateInput, CorrelateResult, GenerateInput, GenerateResult, TutorAI } from './types.js';

interface ChatResponse {
  choices: { message: { content: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  model: string;
}

const correlateSchema = z.object({
  intent: z.enum(['new', 'followup', 'correction', 'clarification']).catch('new'),
  relevantMessageIds: z.array(z.string()).catch([]),
  normalizedQuestion: z.string().catch(''),
  searchTerms: z.array(z.string()).catch([]),
  language: z.string().catch('en'),
  usesPrior: z.boolean().catch(false),
  needsClarification: z.boolean().catch(false),
  clarificationQuestion: z.string().optional().catch(undefined),
});

const generateSchema = z.object({
  answer: z.string(),
  sourceRefs: z.array(z.string()).catch([]),
  evidenceSufficient: z.boolean().catch(false),
  confidence: z.number().min(0).max(1).catch(0.5),
});

/** Groq (OpenAI-compatible chat completions API). */
export class GroqTutorAI implements TutorAI {
  readonly name = 'groq';

  constructor(
    private apiKey = env.GROQ_API_KEY ?? '',
    private baseUrl = env.GROQ_BASE_URL,
  ) {}

  private async chat(model: string, system: string, user: string, maxTokens: number) {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(env.AI_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as ChatResponse;
        return {
          content: body.choices[0]?.message?.content ?? '{}',
          usage: {
            provider: this.name,
            model: body.model ?? model,
            inputTokens: body.usage?.prompt_tokens ?? 0,
            outputTokens: body.usage?.completion_tokens ?? 0,
          },
        };
      }
      const text = await res.text().catch(() => '');
      lastErr = new Error(`Groq API ${res.status}: ${text.slice(0, 300)}`);
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    throw lastErr;
  }

  async correlate(input: CorrelateInput): Promise<AIResult<CorrelateResult>> {
    const { system, user } = buildCorrelatePrompt(input);
    const { content, usage } = await this.chat(env.GROQ_FAST_MODEL, system, user, 500);
    return { data: correlateSchema.parse(safeJson(content)), usage };
  }

  async generate(input: GenerateInput): Promise<AIResult<GenerateResult>> {
    const { system, user } = buildGeneratePrompt(input);
    const maxTokens = Math.min(2000, Math.ceil(input.maxChars / 3) + 150);
    const { content, usage } = await this.chat(env.GROQ_ANSWER_MODEL, system, user, maxTokens);
    return { data: generateSchema.parse(safeJson(content)), usage };
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('AI response was not valid JSON');
  }
}

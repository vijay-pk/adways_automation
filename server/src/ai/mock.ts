import type {
  AIResult,
  CorrelateInput,
  CorrelateResult,
  GenerateInput,
  GenerateResult,
  Intent,
  TutorAI,
} from './types.js';
import { extractKeywords } from '../retrieval/query.js';

const FOLLOWUP = /^(why|how come|and\b|another|more|give (me )?(another|more)|explain (it|that|this)|simpler|in simple|can you (simplify|explain more)|what about|example)/i;
const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Deterministic AI used in development without an API key and in automated tests.
 * It records every request so tests can assert exactly what context was supplied.
 */
export class MockTutorAI implements TutorAI {
  readonly name = 'mock';
  readonly correlateCalls: CorrelateInput[] = [];
  readonly generateCalls: GenerateInput[] = [];
  failNext = 0;

  async correlate(input: CorrelateInput): Promise<AIResult<CorrelateResult>> {
    this.correlateCalls.push(input);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('Simulated AI provider failure');
    }
    const stripped = input.messages.map((m) => ({ ...m, text: m.text.replace(/^@\S+\s*/, '').trim() }));
    const trigger = stripped.find((m) => m.id === input.triggerMessageId) ?? stripped[stripped.length - 1];
    const isFollowup = !!input.prior && stripped.length <= 2 && FOLLOWUP.test(trigger?.text ?? '');
    const intent: Intent = isFollowup ? 'followup' : 'new';
    const parts = stripped.map((m) => m.text).filter(Boolean);
    let normalized = parts.join(' ').trim();
    if (isFollowup && input.prior) normalized = `${input.prior.question} — follow-up: ${normalized}`;
    const needsClarification = normalized.length < 3;
    const data: CorrelateResult = {
      intent,
      relevantMessageIds: input.messages.map((m) => m.id),
      normalizedQuestion: normalized,
      searchTerms: extractKeywords(normalized).slice(0, 8),
      language: 'en',
      usesPrior: isFollowup,
      needsClarification,
      clarificationQuestion: needsClarification ? 'Could you type your question so I can help?' : undefined,
    };
    const prompt = JSON.stringify(input);
    return { data, usage: { provider: 'mock', model: 'mock-fast', inputTokens: estimateTokens(prompt), outputTokens: 50 } };
  }

  async generate(input: GenerateInput): Promise<AIResult<GenerateResult>> {
    this.generateCalls.push(input);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('Simulated AI provider failure');
    }
    const top = input.passages[0];
    const example = input.examples[0];
    let answer: string;
    if (!top) {
      answer = 'Here is a concise, practical answer to help with your question.';
    } else {
      answer = `${example ? `${example.answer}\n\n` : ''}From the course: ${top.content.slice(0, 400)}`;
    }
    const data: GenerateResult = {
      answer: answer.slice(0, input.maxChars),
      sourceRefs: top ? [top.ref] : [],
      evidenceSufficient: !!top,
      confidence: top ? 0.8 : 0.2,
    };
    return {
      data,
      usage: { provider: 'mock', model: 'mock-answer', inputTokens: estimateTokens(JSON.stringify(input)), outputTokens: estimateTokens(answer) },
    };
  }
}

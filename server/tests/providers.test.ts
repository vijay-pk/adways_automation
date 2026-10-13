import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SupabaseFileStorage } from '../src/storage/supabaseStorage.js';
import { OpenAICompatibleEmbedder } from '../src/embeddings/index.js';
import { GroqTutorAI } from '../src/ai/groq.js';

interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

/** Starts a local HTTP stub; `reply` decides each response. */
async function stub(reply: (req: Captured) => { status?: number; json?: unknown; body?: Buffer | string }) {
  const calls: Captured[] = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const captured = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) };
    calls.push(captured);
    const r = reply(captured);
    res.statusCode = r.status ?? 200;
    if (r.json !== undefined) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(r.json));
    } else res.end(r.body ?? '');
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, calls };
}

describe('Supabase Storage provider', () => {
  it('creates a private bucket and uses the service key only in server-side headers', async () => {
    const objects = new Map<string, Buffer>();
    const { url, calls } = await stub((req) => {
      if (req.method === 'GET' && req.url === '/storage/v1/bucket/transcripts') return { status: 404, json: { error: 'not found' } };
      if (req.method === 'POST' && req.url === '/storage/v1/bucket') return { json: { name: 'transcripts' } };
      if (req.method === 'POST' && req.url.startsWith('/storage/v1/object/transcripts/')) {
        objects.set(req.url, req.body);
        return { json: { Key: req.url } };
      }
      if (req.method === 'GET' && objects.has(req.url)) return { body: objects.get(req.url) };
      if (req.method === 'DELETE') return { json: [] };
      return { status: 404, json: { error: 'missing' } };
    });
    const s = new SupabaseFileStorage(url, 'service-role-secret', 'transcripts', 1024);
    await s.ensureReady();
    const create = calls.find((c) => c.method === 'POST' && c.url === '/storage/v1/bucket')!;
    expect(JSON.parse(create.body.toString())).toMatchObject({ id: 'transcripts', public: false, file_size_limit: 1024 });

    await s.put('transcripts/abc.pdf', Buffer.from('%PDF-data'), 'application/pdf');
    const upload = calls.find((c) => c.url === '/storage/v1/object/transcripts/transcripts/abc.pdf' && c.method === 'POST')!;
    expect(upload.headers.authorization).toBe('Bearer service-role-secret');
    expect(upload.headers['content-type']).toBe('application/pdf');
    expect((await s.get('transcripts/abc.pdf')).toString()).toBe('%PDF-data');

    await s.delete('transcripts/abc.pdf');
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url).toBe('/storage/v1/object/transcripts');
    expect(JSON.parse(del.body.toString())).toEqual({ prefixes: ['transcripts/abc.pdf'] });
  });

  it('refuses a public bucket and surfaces storage errors', async () => {
    const { url } = await stub((req) =>
      req.url === '/storage/v1/bucket/transcripts' ? { json: { id: 'transcripts', public: true } } : { status: 500, body: 'boom' },
    );
    const s = new SupabaseFileStorage(url, 'k', 'transcripts');
    await expect(s.ensureReady()).rejects.toThrow(/public/);
    await expect(s.put('a.txt', Buffer.from('x'), 'text/plain')).rejects.toThrow(/upload failed \(500\)/);
  });
});

describe('OpenAI-compatible embedding provider', () => {
  it('sends model, input and dimensions and returns vectors in input order', async () => {
    const { url, calls } = await stub(() => ({
      json: { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 7 } },
    }));
    const e = new OpenAICompatibleEmbedder(url, 'emb-key', 'text-embedding-3-small', 2);
    const r = await e.embed(['first', 'second']);
    expect(r.vectors).toEqual([[1, 0], [0, 1]]);
    expect(r.inputTokens).toBe(7);
    expect(calls[0].url).toBe('/embeddings');
    expect(calls[0].headers.authorization).toBe('Bearer emb-key');
    expect(JSON.parse(calls[0].body.toString())).toEqual({ model: 'text-embedding-3-small', input: ['first', 'second'], dimensions: 2 });
    expect(e.id).toBe('openai_compatible:text-embedding-3-small:2');
  });

  it('does not retry client errors', async () => {
    const { url, calls } = await stub(() => ({ status: 401, json: { error: 'bad key' } }));
    await expect(new OpenAICompatibleEmbedder(url, 'k', 'm').embed(['x'])).rejects.toThrow(/401/);
    expect(calls).toHaveLength(1);
  });
});

describe('Groq answer generation', () => {
  it('sends retrieved passages and approved examples with grounding instructions and parses the answer', async () => {
    const { url, calls } = await stub(() => ({
      json: {
        model: 'llama-3.3-70b-versatile',
        choices: [{ message: { content: JSON.stringify({ answer: 'ROAS = revenue / ad spend.', sourceRefs: ['S1'], evidenceSufficient: true, confidence: 0.9 }) } }],
        usage: { prompt_tokens: 500, completion_tokens: 40 },
      },
    }));
    const groq = new GroqTutorAI('groq-key', url);
    const out = await groq.generate({
      question: 'What is ROAS?',
      intent: 'new',
      contextMessages: [{ id: 'm1', text: 'What is ROAS?', timestamp: new Date() }],
      prior: null,
      passages: [
        { ref: 'S1', chunkId: 'c1', transcriptId: 't1', filename: 'roas.txt', moduleName: 'Module 2', lessonTitle: 'ROAS', timestampStart: '00:10:05', timestampEnd: null, content: 'ROAS is revenue from ads divided by ad spend.', rank: 1 },
      ],
      examples: [{ ref: 'E1', exampleId: 'e1', question: 'What is ROAS?', answer: 'Approved: ROAS compares revenue to spend.', updatedAt: new Date(), wasEdited: true }],
      maxChars: 1200,
      language: 'en',
    });
    expect(out.data).toMatchObject({ answer: 'ROAS = revenue / ad spend.', sourceRefs: ['S1'], evidenceSufficient: true });
    expect(out.usage).toMatchObject({ provider: 'groq', inputTokens: 500, outputTokens: 40 });
    const body = JSON.parse(calls[0].body.toString());
    expect(calls[0].url).toBe('/chat/completions');
    expect(calls[0].headers.authorization).toBe('Bearer groq-key');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].content).toMatch(/Do not invent statements attributed to the instructor/);
    expect(body.messages[0].content).toMatch(/does not support an answer/);
    expect(body.messages[1].content).toContain('<passage ref="S1" source="Module 2 / ROAS @ 00:10:05">');
    expect(body.messages[1].content).toContain('Approved: ROAS compares revenue to spend.');
  });
});

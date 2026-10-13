import type { Segment } from './extract/index.js';

export interface Chunk {
  index: number;
  content: string;
  timestampStart: string | null;
  timestampEnd: string | null;
  tokenEstimate: number;
}

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

const FILLERS = /\b(um+|uh+|erm+|hmm+)\b[,.]?\s*/gi;
const ARTIFACTS = /\[(music|applause|laughter|inaudible|crosstalk|silence|background noise)\]|\((music|applause|laughter)\)/gi;

/** Removes obvious transcription artifacts without changing meaning. */
export function cleanText(text: string): string {
  return text
    .replace(ARTIFACTS, ' ')
    .replace(FILLERS, '')
    .replace(/\b(\w+)(\s+\1\b)+/gi, '$1') // "the the" -> "the"
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Splits long segments (e.g. PDFs without timestamps) at sentence boundaries. */
function splitLong(seg: Segment, maxChars: number): Segment[] {
  if (seg.text.length <= maxChars) return [seg];
  const sentences = seg.text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [seg.text];
  const out: Segment[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length > maxChars) {
      out.push({ ...seg, text: cur.trim() });
      cur = '';
    }
    if (s.length > maxChars) {
      for (let i = 0; i < s.length; i += maxChars) out.push({ ...seg, text: s.slice(i, i + maxChars).trim() });
      continue;
    }
    cur += s;
  }
  if (cur.trim()) out.push({ ...seg, text: cur.trim() });
  return out;
}

/**
 * Groups segments into overlapping chunks of roughly targetTokens (500–1,000 range),
 * keeping the first/last timestamps covered by each chunk.
 */
export function chunkSegments(segments: Segment[], targetTokens = 800, overlapTokens = 120): Chunk[] {
  const maxChars = targetTokens * 4;
  const overlapChars = overlapTokens * 4;
  const pieces = segments
    .map((s) => ({ ...s, text: cleanText(s.text) }))
    .filter((s) => s.text)
    .flatMap((s) => splitLong(s, Math.floor(maxChars / 2)));

  const chunks: Chunk[] = [];
  let i = 0;
  while (i < pieces.length) {
    let len = 0;
    let j = i;
    while (j < pieces.length && (len === 0 || len + pieces[j].text.length + 1 <= maxChars)) {
      len += pieces[j].text.length + 1;
      j++;
    }
    const group = pieces.slice(i, j);
    const content = group.map((p) => p.text).join(' ');
    chunks.push({
      index: chunks.length,
      content,
      timestampStart: group.find((p) => p.start)?.start ?? null,
      timestampEnd: [...group].reverse().find((p) => p.end || p.start)?.end ?? [...group].reverse().find((p) => p.start)?.start ?? null,
      tokenEstimate: estimateTokens(content),
    });
    if (j >= pieces.length) break;
    // Step back to create overlap, but always advance at least one piece.
    let back = j;
    let overlap = 0;
    while (back - 1 > i && overlap + pieces[back - 1].text.length <= overlapChars) {
      back--;
      overlap += pieces[back].text.length;
    }
    i = back > i ? back : j;
  }
  return chunks;
}

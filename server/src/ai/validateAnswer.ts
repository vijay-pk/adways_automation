import type { GenerateResult, Passage } from './types.js';

export interface SourceRef {
  ref: string;
  chunkId: string;
  transcriptId: string;
  filename: string;
  moduleName: string | null;
  lessonTitle: string | null;
  timestampStart: string | null;
}

export interface ValidatedAnswer {
  text: string;
  sources: SourceRef[];
  evidenceSufficient: boolean;
  confidence: number;
  issues: string[];
}

export const NO_EVIDENCE_NOTE =
  'Note: I could not find this in the course transcripts, so this is not from the class material.';

/**
 * Checks a generated answer before it reaches approval or sending:
 * citations must map to passages actually retrieved from the database,
 * length is enforced, and missing evidence is stated explicitly.
 */
export function validateAnswer(result: GenerateResult, passages: Passage[], maxChars: number): ValidatedAnswer {
  const issues: string[] = [];
  let body = (result.answer ?? '').trim();
  if (!body) throw new Error('AI returned an empty answer');

  // Remove inline [S9]-style markers; citations are rendered from DB records instead.
  body = body.replace(/\[(S|E)\d+\]/g, '').replace(/[ \t]{2,}/g, ' ').trim();

  const byRef = new Map(passages.map((p) => [p.ref, p]));
  const validRefs = [...new Set(result.sourceRefs)].filter((r) => byRef.has(r));
  const invalid = result.sourceRefs.filter((r) => !byRef.has(r));
  if (invalid.length) issues.push(`Dropped citations not in retrieved passages: ${invalid.join(', ')}`);

  let evidenceSufficient = result.evidenceSufficient && validRefs.length > 0 && passages.length > 0;
  if (result.evidenceSufficient && !evidenceSufficient) issues.push('Model claimed sufficient evidence without valid citations');
  if (!passages.length) evidenceSufficient = false;

  if (!evidenceSufficient && !/course (material|transcript)s?|class material|not (covered|in the course)/i.test(body)) {
    body = `${NO_EVIDENCE_NOTE}\n\n${body}`;
  }

  const sources: SourceRef[] = validRefs.map((r) => {
    const p = byRef.get(r)!;
    return {
      ref: r,
      chunkId: p.chunkId,
      transcriptId: p.transcriptId,
      filename: p.filename,
      moduleName: p.moduleName,
      lessonTitle: p.lessonTitle,
      timestampStart: p.timestampStart,
    };
  });

  const footer = sources.length ? `\n\nSources: ${formatSources(sources)}` : '';
  const budget = Math.max(100, maxChars - footer.length);
  if (body.length > budget) {
    issues.push(`Answer truncated from ${body.length} to ${budget} characters`);
    body = truncateAtSentence(body, budget);
  }

  const confidence = Math.max(0, Math.min(1, evidenceSufficient ? result.confidence : Math.min(result.confidence, 0.3)));
  return { text: body + footer, sources, evidenceSufficient, confidence, issues };
}

export function formatSources(sources: SourceRef[]): string {
  const labels = sources.map((s) => {
    const where = [s.moduleName, s.lessonTitle].filter(Boolean).join(' – ') || s.filename;
    return s.timestampStart ? `${where} (${s.timestampStart})` : where;
  });
  return [...new Set(labels)].join('; ');
}

function truncateAtSentence(text: string, max: number) {
  const cut = text.slice(0, max - 1);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('\n'));
  return (lastStop > max * 0.5 ? cut.slice(0, lastStop + 1) : cut).trim() + '…';
}

import type { Segment } from './index.js';
import { normalizeTimestamp } from './subtitle.js';

// Matches "[00:12:30]", "(12:30)", "00:12:30 -" or "12:30 Speaker:" at line start.
const INLINE_TS = /^\s*[[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})(?:[.,]\d+)?[\])]?\s*[-–:]?\s*/;

/**
 * Splits plain text into paragraph segments, preserving inline timestamps
 * when a line starts with one.
 */
export function segmentPlainText(raw: string): Segment[] {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r/g, '');
  const lines = text.split('\n');
  const segments: Segment[] = [];
  let buf: string[] = [];
  let start: string | undefined;

  const flush = () => {
    const joined = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) segments.push({ text: joined, start });
    buf = [];
    start = undefined;
  };

  for (const line of lines) {
    const ts = line.match(INLINE_TS);
    if (ts && /\d:\d{2}/.test(ts[1])) {
      flush();
      start = normalizeTimestamp(ts[1]);
      buf.push(line.slice(ts[0].length));
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // Markdown headings become their own segment for clearer chunks.
    if (/^#{1,6}\s/.test(line)) {
      flush();
      segments.push({ text: line.replace(/^#{1,6}\s+/, '').trim() });
      continue;
    }
    buf.push(line.trim());
  }
  flush();

  // Fill end timestamps from the next timestamped segment.
  for (let i = 0; i < segments.length; i++) {
    if (!segments[i].start) continue;
    const next = segments.slice(i + 1).find((s) => s.start);
    if (next) segments[i].end = next.start;
  }
  return segments;
}

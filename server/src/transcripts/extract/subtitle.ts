import type { Segment } from './index.js';

const TIME = /(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/;
const CUE = new RegExp(`^\\s*(${TIME.source})\\s*-->\\s*(${TIME.source})`);

/** Normalises "00:01:02,500" / "01:02.500" to "00:01:02". */
export function normalizeTimestamp(t: string): string {
  const parts = t.replace(',', '.').split('.')[0].split(':');
  while (parts.length < 3) parts.unshift('0');
  return parts.map((p) => p.padStart(2, '0')).join(':');
}

/** Parses SRT and WebVTT cues into timestamped segments. */
export function parseSubtitles(raw: string): Segment[] {
  const lines = raw.replace(/^﻿/, '').replace(/\r/g, '').split('\n');
  const segments: Segment[] = [];
  let current: Segment | null = null;
  for (const line of lines) {
    const cue = line.match(CUE);
    if (cue) {
      if (current?.text) segments.push(current);
      current = { text: '', start: normalizeTimestamp(cue[1]), end: normalizeTimestamp(cue[3]) };
      continue;
    }
    const trimmed = line.trim();
    if (!current) continue; // WEBVTT header, NOTE blocks before first cue
    if (!trimmed) {
      if (current.text) {
        segments.push(current);
        current = null;
      }
      continue;
    }
    if (/^\d+$/.test(trimmed) && !current.text) continue; // SRT index line
    const text = trimmed.replace(/<[^>]+>/g, '').replace(/\{\\[^}]+\}/g, '');
    current.text = current.text ? `${current.text} ${text}` : text;
  }
  if (current?.text) segments.push(current);
  return dedupeRollingCaptions(segments);
}

/** Auto-generated captions often repeat the previous line; drop exact consecutive repeats. */
function dedupeRollingCaptions(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segments) {
    const prev = out[out.length - 1];
    if (prev && prev.text === s.text) {
      prev.end = s.end;
      continue;
    }
    if (prev && s.text.startsWith(prev.text) && prev.text.length > 10) {
      prev.text = s.text;
      prev.end = s.end;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

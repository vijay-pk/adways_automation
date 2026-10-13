import { describe, expect, it } from 'vitest';
import { parseSubtitles } from '../src/transcripts/extract/subtitle.js';
import { segmentPlainText } from '../src/transcripts/extract/plain.js';
import { chunkSegments, cleanText } from '../src/transcripts/chunk.js';
import { buildTsQuery } from '../src/retrieval/query.js';

const SRT = `1
00:00:01,000 --> 00:00:04,000
Welcome to lesson three on retargeting.

2
00:00:04,500 --> 00:00:09,000
Retargeting shows ads to people who [inaudible] visited your website.
`;

const VTT = `WEBVTT

00:01:00.000 --> 00:01:05.000
<v Instructor>Lookalike audiences are built from a seed audience.

00:01:05.000 --> 00:01:09.000
Lookalike audiences are built from a seed audience.
`;

describe('extraction and chunking', () => {
  it('parses SRT with timestamps and removes artifacts', () => {
    const segs = parseSubtitles(SRT);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ start: '00:00:01', end: '00:00:04' });
    const chunks = chunkSegments(segs);
    expect(chunks[0].content).not.toContain('[inaudible]');
    expect(chunks[0].timestampStart).toBe('00:00:01');
    expect(chunks[0].timestampEnd).toBe('00:00:09');
  });

  it('parses VTT, strips voice tags and collapses rolling duplicates', () => {
    const segs = parseSubtitles(VTT);
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe('Lookalike audiences are built from a seed audience.');
    expect(segs[0].end).toBe('00:01:09');
  });

  it('keeps inline timestamps in plain text and markdown', () => {
    const segs = segmentPlainText('# Lesson 1\n[00:10:05] First point.\n[00:11:30] Second point.');
    expect(segs.map((s) => s.start)).toEqual([undefined, '00:10:05', '00:11:30']);
    expect(segs[1].end).toBe('00:11:30');
  });

  it('cleans fillers and repeated words without changing meaning', () => {
    expect(cleanText('um so the the ROAS is uh 4x [Music]')).toBe('so the ROAS is 4x');
  });

  it('creates overlapping chunks of roughly 500-1,000 tokens', () => {
    const segs = Array.from({ length: 200 }, (_, i) => ({ text: `Sentence number ${i} about ad budgets and bidding strategy for campaigns.`, start: `00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}` }));
    const chunks = chunkSegments(segs);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks.slice(0, -1)) {
      expect(c.tokenEstimate).toBeGreaterThan(500);
      expect(c.tokenEstimate).toBeLessThanOrEqual(1000);
    }
    const tail = chunks[0].content.slice(-60);
    expect(chunks[1].content).toContain(tail.slice(tail.indexOf('Sentence')));
  });

  it('builds OR queries with abbreviation expansion', () => {
    expect(buildTsQuery('What is CTR?')).toBe('ctr | (click & through & rate)');
    expect(buildTsQuery('???')).toBeNull();
  });
});


describe('PDF and DOCX extraction', () => {
  it('extracts every PDF reliably, keeping inline timestamps (regression: pdf-parse failures)', async () => {
    const { extractSegments } = await import('../src/transcripts/extract/index.js');
    const { makeDocx, makePdf } = await import('./fixtures.js');
    const one = await extractSegments(makePdf(['Cost per click is what you pay.']), 'a.pdf');
    expect(one.map((s) => s.text).join(' ')).toContain('Cost per click is what you pay.');
    const two = await extractSegments(makePdf(['[00:03:00] Cost per click is what you pay each time someone clicks your ad.', 'Improve relevance to lower your cost per click.']), 'b.pdf');
    expect(two[0].start).toBe('00:03:00');
    expect(two.map((s) => s.text).join(' ')).toContain('Improve relevance');
    await expect(extractSegments(makePdf([]), 'empty.pdf')).rejects.toThrow(/no extractable text/);
    const docx = await extractSegments(await makeDocx(['[00:01:00] Lookalike audiences.', 'Second paragraph.']), 'c.docx');
    expect(docx[0]).toMatchObject({ start: '00:01:00', text: 'Lookalike audiences.' });
  });
});

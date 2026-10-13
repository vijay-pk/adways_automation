import mammoth from 'mammoth';
import { parseSubtitles } from './subtitle.js';
import { segmentPlainText } from './plain.js';

export interface Segment {
  text: string;
  start?: string;
  end?: string;
}

export const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.pdf', '.docx', '.srt', '.vtt'] as const;

export function extensionOf(filename: string) {
  const m = filename.toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : '';
}

/** Magic-byte checks so a renamed file cannot masquerade as another type. */
export function sniffMatches(ext: string, buf: Buffer): boolean {
  if (ext === '.pdf') return buf.subarray(0, 5).toString('latin1') === '%PDF-';
  if (ext === '.docx') return buf[0] === 0x50 && buf[1] === 0x4b; // ZIP container
  // Text formats: reject binary content (NUL bytes in the first 8KB).
  return !buf.subarray(0, 8192).includes(0);
}

export async function extractSegments(buf: Buffer, filename: string): Promise<Segment[]> {
  const ext = extensionOf(filename);
  switch (ext) {
    case '.srt':
    case '.vtt':
      return parseSubtitles(buf.toString('utf8'));
    case '.txt':
    case '.md':
    case '.markdown':
      return segmentPlainText(buf.toString('utf8'));
    case '.docx': {
      const { value } = await mammoth.extractRawText({ buffer: buf });
      return segmentPlainText(value);
    }
    case '.pdf': {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await extractText(pdf, { mergePages: false });
      const joined = text.join('\n\n');
      if (!joined.trim()) throw new Error('PDF contains no extractable text (it may be scanned images; upload a text version)');
      return segmentPlainText(joined);
    }
    default:
      throw new Error(`Unsupported file type: ${ext || 'unknown'}`);
  }
}

export type TranscriptStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface Transcript {
  id: string;
  filename: string;
  lessonTitle: string | null;
  moduleName: string | null;
  topic: string | null;
  description: string | null;
  sourceType: 'upload' | 'paste';
  storageProvider: string;
  mimeType: string | null;
  sizeBytes: number;
  processingStatus: TranscriptStatus;
  processingError: string | null;
  processingAttempts: number;
  chunkCount: number;
  embeddedChunkCount: number;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
  extractedText?: string | null;
}

export interface Chunk {
  id: string;
  chunkIndex: number;
  content: string;
  timestampStart: string | null;
  timestampEnd: string | null;
  tokenEstimate: number;
  embeddingModel: string | null;
}

export interface KbMeta {
  modules: string[];
  topics: string[];
  statusCounts: Partial<Record<TranscriptStatus, number>>;
  maxUploadMb: number;
  storage: string;
  embeddings: { enabled: boolean; model: string | null; vectorBackend: string };
}

export const STATUS_LABEL: Record<TranscriptStatus, string> = {
  PENDING: 'Pending',
  PROCESSING: 'Processing',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
};

export const fmtSize = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

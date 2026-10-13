export type Intent = 'new' | 'followup' | 'correction' | 'clarification';

export interface ContextMessage {
  id: string;
  text: string;
  timestamp: Date;
}

export interface PriorExchange {
  jobId: string;
  question: string;
  answer: string;
  at: Date;
}

export interface CorrelateInput {
  messages: ContextMessage[];
  triggerMessageId: string;
  prior: PriorExchange | null;
  botName: string;
}

export interface CorrelateResult {
  intent: Intent;
  relevantMessageIds: string[];
  normalizedQuestion: string;
  searchTerms: string[];
  language: string;
  usesPrior: boolean;
  needsClarification: boolean;
  clarificationQuestion?: string;
}

export interface Passage {
  ref: string; // "S1", "S2", ...
  chunkId: string;
  transcriptId: string;
  filename: string;
  moduleName: string | null;
  lessonTitle: string | null;
  timestampStart: string | null;
  timestampEnd: string | null;
  content: string;
  rank: number;
}

export interface ExampleRef {
  ref: string; // "E1", ...
  exampleId: string;
  question: string;
  answer: string;
  updatedAt: Date;
  wasEdited: boolean;
}

export interface GenerateInput {
  question: string;
  intent: Intent;
  contextMessages: ContextMessage[];
  prior: PriorExchange | null;
  passages: Passage[];
  examples: ExampleRef[];
  maxChars: number;
  language: string;
  adminHint?: string;
}

export interface GenerateResult {
  answer: string;
  sourceRefs: string[];
  evidenceSufficient: boolean;
  confidence: number;
}

export interface Usage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AIResult<T> {
  data: T;
  usage: Usage;
}

/** Task-level AI interface. Provider-specific code lives behind it. */
export interface TutorAI {
  readonly name: string;
  correlate(input: CorrelateInput): Promise<AIResult<CorrelateResult>>;
  generate(input: GenerateInput): Promise<AIResult<GenerateResult>>;
}

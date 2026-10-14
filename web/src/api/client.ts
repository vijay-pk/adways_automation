let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null) => {
  csrfToken = t;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', ...init });
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = typeof data === 'object' && data && 'error' in data ? String((data as { error: string }).error) : res.statusText;
    if (res.status === 401 && !url.startsWith('/api/auth')) window.dispatchEvent(new Event('tutor:unauthorized'));
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body ?? {}),
  del: <T>(url: string) => request<T>('DELETE', url),
  upload: <T>(url: string, form: FormData) => request<T>('POST', url, form),
  postText: <T>(url: string, text: string) =>
    request<T>('POST', url, undefined, { body: text, headers: { 'content-type': 'text/csv', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) } }),
};

export type Role = 'SUPER_ADMIN' | 'REVIEWER' | 'VIEWER';

export interface Admin {
  id: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
  totpEnabled: boolean;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface Settings {
  auto_reply_enabled: boolean;
  pause_all_outgoing: boolean;
  pause_group_replies: boolean;
  pause_private_replies: boolean;
  messaging_connection_enabled: boolean;
  messaging_adapter: 'mock' | 'whatsapp_web' | 'whatsapp_cloud';
  group_replies_enabled: boolean;
  private_replies_enabled: boolean;
  text_command_mode_enabled: boolean;
  text_command: string;
  bot_display_name: string;
  require_enrollment: boolean;
  max_response_chars: number;
  context_window_minutes: number;
  context_max_messages: number;
  followup_window_minutes: number;
  debounce_seconds: number;
  student_daily_limit: number;
  student_per_minute_limit: number;
  retrieval_top_k: number;
  example_top_k: number;
  message_retention_days: number;
  daily_ai_budget_usd: number;
  web_chat_enabled: boolean;
  web_chat_url: string;
  platform_data_ai_training_allowed: false;
  cloud_api_policy_acknowledged: boolean;
  whatsapp_web_risk_acknowledged: boolean;
}

export interface Capabilities {
  receivePrivateMessages: boolean;
  sendPrivateMessages: boolean;
  receiveGroupMessages: boolean;
  sendGroupMessages: boolean;
  nativeMentions: boolean;
  quotedReplies: boolean;
  messageHistory: boolean;
  notes: string[];
}

export interface MessagingOverview {
  adapter: string | null;
  channel: string | null;
  experimental: boolean;
  status: { state: string; detail?: string; botId?: string | null };
  lastError: string | null;
  capabilities: Capabilities | null;
  webChat: { capabilities: Capabilities };
  login: { supported: boolean; qrAvailable: boolean };
  cloud: {
    phoneNumberId: string | null;
    businessAccountId: string | null;
    apiVersion: string;
    accessTokenSet: boolean;
    appSecretSet: boolean;
    verifyTokenSet: boolean;
    missing: string[];
  };
  cloudWebhookUrl?: string;
  queue?: { type: string; status: string; count: number }[];
  webChatEnabled?: boolean;
}

export interface InboundLogEntry {
  id: string;
  channel: string;
  chatType: string;
  sender: string;
  isMention: boolean;
  via: string | null;
  status: string;
  reason: string;
  at: string;
}

export type ResponseStatus = 'GENERATING' | 'PENDING_APPROVAL' | 'APPROVED' | 'SENDING' | 'SENT' | 'REJECTED' | 'CANCELLED' | 'FAILED';

export interface SourceRef {
  ref: string;
  chunkId: string;
  filename: string;
  moduleName: string | null;
  lessonTitle: string | null;
  timestampStart: string | null;
}

export interface ResponseJob {
  id: string;
  status: ResponseStatus;
  normalizedQuestion: string | null;
  intent: string | null;
  draftAnswer: string | null;
  approvedAnswer: string | null;
  evidenceSufficient: boolean | null;
  confidence: number | null;
  autoApproved: boolean;
  lastError: string | null;
  reviewerNotes: string | null;
  createdAt: string;
  approvedAt: string | null;
  sentAt: string | null;
  senderExternalId: string;
  sourceRefs: { sources: SourceRef[]; issues: string[] } | null;
  conversation: { channel: string; chatType: 'GROUP' | 'PRIVATE'; externalChatId: string };
  approvedBy: { email: string } | null;
  delivery: { status: string; attempts: number; lastError: string | null } | null;
}

export interface Example {
  id: string;
  originalQuestion: string;
  normalizedQuestion: string;
  approvedAnswer: string;
  originalDraft: string | null;
  wasEdited: boolean;
  reviewerNotes: string | null;
  topicTags: string[];
  moduleName: string | null;
  reusable: boolean;
  enabled: boolean;
  qualityStatus: string;
  usefulnessScore: number | null;
  createdAt: string;
  updatedAt: string;
}

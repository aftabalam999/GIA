const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL as string) || 'http://127.0.0.1:5001';

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: any;
  created_at: string;
}

export interface Memory {
  id: string;
  content: string;
  category?: string;
  importance: number;
  confidence: number;
  created_at: string;
}

export interface DocumentInfo {
  id: string;
  name: string;
  file_url?: string;
  mime_type?: string;
  file_size?: number;
  created_at: string;
  chunk_count?: number;
}

// REST HELPER
async function apiRequest(path: string, method: string, token?: string, body?: any) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${BACKEND_URL}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err: any) {
    throw new Error(`Unable to connect to backend service at ${BACKEND_URL}. Please ensure backend server is running.`);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `Request failed with status ${response.status}`);
  }
  return data;
}

// AUTH
export async function signup(email: string, password: string, name: string) {
  return apiRequest('/api/v1/auth/signup', 'POST', undefined, { email, password, name });
}

export async function login(email: string, password: string) {
  return apiRequest('/api/v1/auth/login', 'POST', undefined, { email, password });
}

export async function fetchMe(token?: string): Promise<{ success: boolean; user: User }> {
  return apiRequest('/api/v1/auth/me', 'GET', token);
}

export async function logout(token?: string): Promise<{ success: boolean }> {
  return apiRequest('/api/v1/auth/logout', 'POST', token);
}

export async function revokeAllSessions(token?: string): Promise<{ success: boolean }> {
  return apiRequest('/api/v1/auth/revoke-all', 'POST', token);
}

// CONVERSATIONS
export async function listConversations(token: string): Promise<Conversation[]> {
  const data = await apiRequest('/api/v1/conversations', 'GET', token);
  return data.conversations || [];
}

export async function createConversation(token: string, title: string): Promise<Conversation> {
  const data = await apiRequest('/api/v1/conversations', 'POST', token, { title });
  return data.conversation;
}

export async function deleteConversation(token: string, id: string): Promise<void> {
  await apiRequest(`/api/v1/conversations/${id}`, 'DELETE', token);
}

export async function getMessages(token: string, conversationId: string): Promise<Message[]> {
  const data = await apiRequest(`/api/v1/conversations/${conversationId}/messages`, 'GET', token);
  return data.messages || [];
}

// MESSAGE SENDERS
export async function sendMessageSync(token: string, conversationId: string, content: string): Promise<Message> {
  const data = await apiRequest(`/api/v1/conversations/${conversationId}/messages`, 'POST', token, { content });
  return data.message;
}

export async function sendMessageRAG(token: string, conversationId: string, content: string): Promise<{ message: Message; citations: any[] }> {
  const data = await apiRequest(`/api/v1/conversations/${conversationId}/messages/rag`, 'POST', token, { content });
  return {
    message: data.assistantMessage,   // Backend returns 'assistantMessage', not 'message'
    citations: data.sources || [],    // Backend returns 'sources', not 'citations'
  };
}

export async function sendMessageAgent(token: string, conversationId: string, content: string): Promise<{
  userMessage: Message;
  assistantMessage: Message;
  runId?: string;
  plan?: ExecutionPlan;
  presentation?: string;
  execution?: PlanExecutionResult;
}> {
  const data = await apiRequest(`/api/v1/conversations/${conversationId}/messages/agent`, 'POST', token, { content });
  return {
    userMessage: data.userMessage,
    assistantMessage: data.assistantMessage,
    runId: data.runId,
    plan: data.plan,
    presentation: data.presentation,
    execution: data.execution,
  };
}

// MEMORIES
export async function listMemories(token: string): Promise<Memory[]> {
  const data = await apiRequest('/api/v1/memories', 'GET', token);
  return data.memories || [];
}

export async function createMemory(token: string, content: string, importance = 5): Promise<Memory> {
  const data = await apiRequest('/api/v1/memories', 'POST', token, {
    content,
    importance,
    type: 'user_preference',   // Required by backend schema
    confidence: 0.8,           // Required by backend schema
  });
  return data.memory;
}

export async function deleteMemory(token: string, id: string): Promise<void> {
  await apiRequest(`/api/v1/memories/${id}`, 'DELETE', token);
}

// DOCUMENTS
export async function listDocuments(token: string): Promise<DocumentInfo[]> {
  const data = await apiRequest('/api/v1/documents', 'GET', token);
  return data.documents || [];
}

export async function deleteDocument(token: string, id: string): Promise<void> {
  await apiRequest(`/api/v1/documents/${id}`, 'DELETE', token);
}

export async function createDocument(
  token: string,
  title: string,
  content: string,
  sourceType = 'upload',
  sourceUrl: string | null = null
): Promise<DocumentInfo> {
  const data = await apiRequest('/api/v1/documents', 'POST', token, {
    title,
    content,
    sourceType,
    sourceUrl,
  });
  return data.document;
}

// WEBSOCKET CHAT STREAM
export function connectChatStream(
  token: string,
  conversationId: string,
  content: string,
  onChunk: (text: string) => void,
  onDone: (fullText: string) => void,
  onError: (err: string) => void
): WebSocket {
  const wsUrl = `${BACKEND_URL.replace(/^http/, 'ws')}/api/v1/chat/stream?token=${encodeURIComponent(token)}`;
  const socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    socket.send(JSON.stringify({ conversationId, content }));
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'chunk' && msg.content) {
        onChunk(msg.content);
      } else if (msg.type === 'done') {
        onDone(msg.fullText || '');
        socket.close();
      } else if (msg.type === 'error') {
        onError(msg.message || 'Stream error');
        socket.close();
      }
    } catch (err: any) {
      onError('Malformed WebSocket frame: ' + err.message);
    }
  };

  socket.onerror = () => {
    onError('WebSocket connection error');
  };

  socket.onclose = (event) => {
    if (event.code !== 1000) {
      onError('WebSocket connection closed unexpectedly');
    }
  };

  return socket;
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version?: string;
  dependencies?: {
    database: 'healthy' | 'unhealthy';
    redis: 'healthy' | 'unhealthy';
    python_ai_service: 'healthy' | 'degraded' | 'unhealthy';
    llm: 'healthy' | 'unhealthy' | 'unconfigured';
    embeddings: 'healthy' | 'unhealthy' | 'unconfigured';
  };
  python_ai_service?: {
    reachable: boolean;
    healthy: boolean;
    ready: boolean;
    subsystems?: Record<string, boolean>;
    error?: string;
  };
  latency?: Record<string, number>;
}

export async function fetchHealthStatus(): Promise<HealthResponse> {
  const response = await fetch(`${BACKEND_URL}/api/v1/health`);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData?.error?.message || `Health check failed with status ${response.status}`
    );
  }
  return response.json();
}

// VOICE API ENDPOINTS
export async function transcribeAudio(token: string, audioBlob: Blob | Buffer): Promise<any> {
  const formData = new FormData();
  formData.append('file', audioBlob as Blob, 'recording.wav');

  const response = await fetch(`${BACKEND_URL}/api/v1/voice/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || 'STT transcription failed');
  }
  return data.data || data;
}

export async function synthesizeSpeech(token: string, text: string): Promise<ArrayBuffer> {
  const response = await fetch(`${BACKEND_URL}/api/v1/voice/tts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || 'TTS synthesis failed');
  }

  return response.arrayBuffer();
}

export async function sendVoiceMessage(token: string, conversationId: string, audioBlob: Blob | Buffer): Promise<any> {
  const formData = new FormData();
  formData.append('file', audioBlob as Blob, 'voice_query.wav');
  formData.append('conversationId', conversationId);

  const response = await fetch(`${BACKEND_URL}/api/v1/conversations/${conversationId}/messages/voice`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || 'Voice orchestration failed');
  }
  return data;
}

// ==============================================================================
// PLAN, PERMISSION & EXECUTION API (PHASE 4)
// ==============================================================================

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type PlanStatus =
  | 'pending'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'modified'
  | 'modifying'
  | 'expired'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'draft';

export interface PlanStep {
  step_id: number;
  action: string;
  target?: string;
  description: string;
  tool_name?: string;
  tool_args?: Record<string, any>;
  risk_level: RiskLevel;
  requires_approval: boolean;
  depends_on: number[];
  expected_outcome?: string;
}

export interface ExecutionPlan {
  id: string;
  conversation_id: string;
  user_id: string;
  objective: string;
  status: PlanStatus;
  is_ambiguous: boolean;
  clarification_question?: string | null;
  steps: PlanStep[];
  approval: {
    required: boolean;
    approved: boolean;
    approved_at?: string | null;
    feedback?: string | null;
  };
  metadata?: Record<string, any>;
  version: number;
  created_at?: string;
  updated_at?: string;
}

export interface ExecutionTicket {
  ticketId: string;
  ticket_token?: string;
  planId: string;
  planVersion: number;
  userId: string;
  issuedAt: number;
  expiresAt: number;
  approvedSteps: number[];
  confirmedSensitiveOperations: Record<string, boolean>;
  usedSteps: number[];
}

export interface StepExecutionRecord {
  id?: string;
  executionId?: string;
  stepId: number;
  action: string;
  toolName?: string;
  toolArgs?: Record<string, any>;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';
  result?: any;
  verification?: {
    verified: boolean;
    message: string;
    details?: Record<string, any>;
  };
  error?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface PlanExecutionResult {
  executionId: string;
  planId: string;
  planVersion: number;
  userId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  totalSteps: number;
  completedSteps: number;
  failedStepId?: number;
  errorMessage?: string;
  stepRecords: StepExecutionRecord[];
  startedAt: string;
  completedAt?: string;
}

export async function getActivePlan(token: string, conversationId: string): Promise<ExecutionPlan | null> {
  const res = await apiRequest(`/api/v1/conversations/${conversationId}/plans/active`, 'GET', token);
  return res.plan || null;
}

export async function createPlan(token: string, conversationId: string, instruction: string): Promise<{ plan: ExecutionPlan; presentation: string }> {
  return apiRequest(`/api/v1/conversations/${conversationId}/plans`, 'POST', token, { instruction });
}

export async function modifyPlan(token: string, conversationId: string, planId: string, feedback: string): Promise<{ plan: ExecutionPlan; presentation: string }> {
  return apiRequest(`/api/v1/conversations/${conversationId}/plans/${planId}`, 'PUT', token, { feedback });
}

export async function approvePlan(
  token: string,
  conversationId: string,
  planId: string,
  options?: {
    planVersion?: number;
    channel?: 'web_ui' | 'voice_command' | 'api';
    explicitConfirmation?: boolean;
    voiceTranscript?: string;
    sensitiveConfirmations?: Record<string, boolean>;
    isAssistantVoice?: boolean;
  }
): Promise<{ success: boolean; plan: ExecutionPlan; ticket: ExecutionTicket; message: string }> {
  return apiRequest(`/api/v1/conversations/${conversationId}/plans/${planId}/approve`, 'POST', token, options);
}

export async function rejectPlan(token: string, conversationId: string, planId: string, reason?: string): Promise<{ success: boolean; plan: ExecutionPlan; message: string }> {
  return apiRequest(`/api/v1/conversations/${conversationId}/plans/${planId}/reject`, 'POST', token, { reason });
}

export async function executePlan(
  token: string,
  conversationId: string,
  planId: string,
  ticketToken: string,
  planVersion?: number
): Promise<{ success: boolean; execution: PlanExecutionResult }> {
  return apiRequest(`/api/v1/conversations/${conversationId}/plans/${planId}/execute`, 'POST', token, {
    ticketToken,
    planVersion,
  });
}

export async function cancelPlan(token: string, conversationId: string, planId: string): Promise<{ success: boolean; message: string }> {
  return apiRequest(`/api/v1/conversations/${conversationId}/plans/${planId}/cancel`, 'POST', token);
}

export async function getPlanExecutions(token: string, conversationId: string, planId: string): Promise<any[]> {
  const res = await apiRequest(`/api/v1/conversations/${conversationId}/plans/${planId}/executions`, 'GET', token);
  return res.executions || [];
}

export async function getStepExecutions(token: string, conversationId: string, planId: string, executionId: string): Promise<any[]> {
  const res = await apiRequest(`/api/v1/conversations/${conversationId}/plans/${planId}/executions/${executionId}/steps`, 'GET', token);
  return res.steps || [];
}

export async function sendVoicePlanCommand(token: string, conversationId: string, transcript: string, isAssistantVoice?: boolean): Promise<any> {
  return apiRequest(`/api/v1/conversations/${conversationId}/plans/voice-command`, 'POST', token, {
    transcript,
    isAssistantVoice,
  });
}




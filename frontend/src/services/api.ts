const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL as string) || 'http://localhost:5000';

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

export async function sendMessageAgent(token: string, conversationId: string, content: string): Promise<{ userMessage: Message; assistantMessage: Message; runId: string }> {
  const data = await apiRequest(`/api/v1/conversations/${conversationId}/messages/agent`, 'POST', token, { content });
  return {
    userMessage: data.userMessage,
    assistantMessage: data.assistantMessage,
    runId: data.runId,
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
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  services: {
    database: 'connected' | 'disconnected';
  };
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



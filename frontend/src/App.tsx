import React, { useState, useEffect, useRef } from 'react';
import * as api from './services/api.js';
import { VoiceStateMachine, VoiceState } from './services/voiceStateMachine.js';
import { DesktopAudioPlayer, PlaybackState } from './services/desktopAudioPlayer.js';
import { AudioRecorderService } from './services/audioRecorder.js';
import { MicTestModal } from './components/MicTestModal.js';
import './App.css';

interface MessageExt extends api.Message {
  citations?: any[];
  streaming?: boolean;
}

type UIState = 'idle' | 'chatting' | 'thinking' | 'executing' | 'error';

export default function App() {
  // Auth state
  const [token, setToken] = useState<string | null>(localStorage.getItem('gia_token'));
  const [user, setUser] = useState<api.User | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authName, setAuthName] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  // Conversations
  const [conversations, setConversations] = useState<api.Conversation[]>([]);
  const [activeConvoId, setActiveConvoId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageExt[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [sendMode, setSendMode] = useState<'stream' | 'sync' | 'rag' | 'agent'>('agent'); // Default to agent FSM orchestrator

  // UI State Model
  const [uiState, setUiState] = useState<UIState>('idle');
  const [activeTool, setActiveTool] = useState<string | null>(null);

  // Continuous Voice Mode State Machine & Desktop Audio Player & Audio Recorder
  const [voiceState, setVoiceState] = useState<VoiceState>('IDLE');
  const [playbackState, setPlaybackState] = useState<PlaybackState>('STOPPED');
  const [isVoiceModeActive, setIsVoiceModeActive] = useState<boolean>(false);
  const voiceMachineRef = useRef<VoiceStateMachine | null>(null);
  const audioPlayerRef = useRef<DesktopAudioPlayer | null>(null);
  const audioRecorderRef = useRef<AudioRecorderService | null>(null);

  useEffect(() => {
    const player = new DesktopAudioPlayer({
      onStateChange: (s) => setPlaybackState(s),
    });
    audioPlayerRef.current = player;

    const recorder = new AudioRecorderService({
      onSpeechStart: () => {
        voiceMachineRef.current?.handleSpeechStart();
      },
      onUtteranceRecorded: (blob) => {
        voiceMachineRef.current?.processSpeechUtterance(blob);
      },
      onError: (err) => setChatError('Recorder error: ' + err),
    });
    audioRecorderRef.current = recorder;

    const machine = new VoiceStateMachine({
      onStateChange: (s) => setVoiceState(s),
      onTranscript: (txt) => {
        setMessages((prev) => [
          ...prev,
          {
            id: Math.random().toString(),
            role: 'user',
            content: txt,
            created_at: new Date().toISOString(),
          },
        ]);
      },
      onAssistantResponse: (_uMsg, aMsg) => {
        if (aMsg) {
          setMessages((prev) => [...prev, aMsg]);
        }
      },
      onError: (err) => setChatError('Voice error: ' + err),
      onPauseCapture: () => recorder.pause(),
      onResumeCapture: () => recorder.resume(),
      fetchTranscribeApi: (blob) => (token ? api.transcribeAudio(token, blob) : Promise.reject('No token')),
      fetchChatApi: (convoId, txt) => (token ? api.sendMessageAgent(token, convoId, txt) : Promise.reject('No token')),
      fetchTtsApi: (txt) => (token ? api.synthesizeSpeech(token, txt) : Promise.reject('No token')),
      playAudioApi: (buf) => player.play(buf),
    });
    voiceMachineRef.current = machine;

    return () => {
      recorder.stop();
      machine.stopVoiceMode();
      player.close();
    };
  }, [token]);

  async function toggleVoiceMode() {
    if (!token || !activeConvoId || !voiceMachineRef.current) return;

    if (isVoiceModeActive) {
      setIsVoiceModeActive(false);
      audioRecorderRef.current?.stop();
      await voiceMachineRef.current.stopVoiceMode();
    } else {
      setIsVoiceModeActive(true);
      await voiceMachineRef.current.startVoiceMode(activeConvoId, token);
      try {
        await audioRecorderRef.current?.start();
      } catch (err: any) {
        setIsVoiceModeActive(false);
        await voiceMachineRef.current.stopVoiceMode();
        setChatError('Microphone permission or capture error: ' + err.message);
      }
    }
  }


  // Loaders & Errors
  const [isConversationsLoading, setIsConversationsLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  // Drawers
  const [activeDrawer, setActiveDrawer] = useState<'none' | 'memories' | 'documents' | 'settings'>('none');
  const [showConvosList, setShowConvosList] = useState(false);

  // Subsystems Data
  const [memories, setMemories] = useState<api.Memory[]>([]);
  const [newMemoryText, setNewMemoryText] = useState('');
  const [newMemoryImportance, setNewMemoryImportance] = useState(5);
  const [memoryError, setMemoryError] = useState<string | null>(null);

  const [documents, setDocuments] = useState<api.DocumentInfo[]>([]);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const [modelSlot, setModelSlot] = useState<'fast' | 'general' | 'reasoning'>('general');
  const [healthStatus, setHealthStatus] = useState<string>('Online');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);


  // Track Chatting State
  useEffect(() => {
    if (['idle', 'chatting'].includes(uiState)) {
      if (inputMessage.trim().length > 0) {
        setUiState('chatting');
      } else {
        setUiState('idle');
      }
    }
  }, [inputMessage]);

  // Microphone Permission Modal State
  const [showMicModal, setShowMicModal] = useState<boolean>(false);
  const [showMicTestModal, setShowMicTestModal] = useState<boolean>(false);
  const [micPermissionStatus, setMicPermissionStatus] = useState<'prompt' | 'granted' | 'rejected'>(
    (localStorage.getItem('gia_mic_permission') as any) || 'prompt'
  );

  // Fetch profile if token exists
  useEffect(() => {
    if (token) {
      api.fetchMe(token)
        .then((res) => {
          setUser(res.user);
          loadConversations();
          loadMemories();
          loadDocuments();
          checkBackendHealth();

          const perm = localStorage.getItem('gia_mic_permission');
          if (!perm || perm === 'prompt') {
            setShowMicModal(true);
          }
        })
        .catch(() => {
          handleLogout();
        });
    }
  }, [token]);

  async function handleGrantMicPermission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      localStorage.setItem('gia_mic_permission', 'granted');
      setMicPermissionStatus('granted');
      setShowMicModal(false);
    } catch (err: any) {
      localStorage.setItem('gia_mic_permission', 'rejected');
      setMicPermissionStatus('rejected');
      setShowMicModal(false);
      setChatError('Microphone permission request failed: ' + err.message);
    }
  }

  function handleRejectMicPermission() {
    localStorage.setItem('gia_mic_permission', 'rejected');
    setMicPermissionStatus('rejected');
    setShowMicModal(false);
  }

  // Health probe
  async function checkBackendHealth() {
    try {
      const data = await api.fetchHealthStatus();
      setHealthStatus(data.status === 'healthy' ? 'Online' : 'Degraded');
    } catch {
      setHealthStatus('Offline');
    }
  }

  // Load backend configurations
  async function loadConversations() {
    if (!token) return;
    setIsConversationsLoading(true);
    try {
      const list = await api.listConversations(token);
      setConversations(list);
      if (list.length > 0 && !activeConvoId) {
        selectConversation(list[0].id);
      }
    } catch (err: any) {
      setChatError('Failed to load conversations: ' + err.message);
    } finally {
      setIsConversationsLoading(false);
    }
  }

  async function loadMemories() {
    if (!token) return;
    try {
      const list = await api.listMemories(token);
      setMemories(list);
    } catch (err: any) {
      setMemoryError('Failed to load memories: ' + err.message);
    }
  }

  async function loadDocuments() {
    if (!token) return;
    try {
      const list = await api.listDocuments(token);
      setDocuments(list);
    } catch (err: any) {
      setDocumentError('Failed to load documents: ' + err.message);
    }
  }

  async function selectConversation(id: string) {
    if (!token) return;
    setActiveConvoId(id);
    setChatError(null);
    setShowConvosList(false);
    try {
      const msgs = await api.getMessages(token, id);
      setMessages(msgs);
    } catch (err: any) {
      setChatError('Failed to fetch message history: ' + err.message);
      setUiState('error');
    }
  }

  // Auth Operations
  async function handleAuth(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    try {
      let res;
      if (authMode === 'login') {
        res = await api.login(authEmail, authPassword);
      } else {
        res = await api.signup(authEmail, authPassword, authName);
      }
      localStorage.setItem('gia_token', res.token);
      setToken(res.token);
    } catch (err: any) {
      setAuthError(err.message || 'Authentication failed');
    }
  }

  async function handleLogout() {
    try {
      if (token) {
        await api.logout(token);
      }
    } catch {
      // ignore
    }
    localStorage.removeItem('gia_token');
    setToken(null);
    setUser(null);
    setConversations([]);
    setActiveConvoId(null);
    setMessages([]);
    setUiState('idle');
  }

  // Conversation Operations
  async function handleCreateConvo() {
    if (!token) return;
    try {
      const title = prompt('Enter conversation title:') || `Chat ${conversations.length + 1}`;
      const convo = await api.createConversation(token, title);
      setConversations([convo, ...conversations]);
      selectConversation(convo.id);
    } catch (err: any) {
      alert('Failed to create conversation: ' + err.message);
    }
  }

  async function handleDeleteConvo(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!token || !confirm('Delete conversation?')) return;
    try {
      await api.deleteConversation(token, id);
      const filtered = conversations.filter((c) => c.id !== id);
      setConversations(filtered);
      if (activeConvoId === id) {
        if (filtered.length > 0) {
          selectConversation(filtered[0].id);
        } else {
          setActiveConvoId(null);
          setMessages([]);
        }
      }
    } catch (err: any) {
      alert('Failed to delete conversation: ' + err.message);
    }
  }

  // Direct Message Sender for Voice & Standard Inputs
  async function handleSendMessageDirectly(textToSend: string) {
    if (!token || !activeConvoId || !textToSend.trim()) return;

    setChatError(null);
    setUiState('thinking');

    // Optimistically push user message
    const tempUserMsg: MessageExt = {
      id: Math.random().toString(),
      role: 'user',
      content: textToSend,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    if (sendMode === 'stream') {
      const tempAssistantMsg: MessageExt = {
        id: Math.random().toString(),
        role: 'assistant',
        content: '',
        created_at: new Date().toISOString(),
        streaming: true,
      };
      setMessages((prev) => [...prev, tempAssistantMsg]);

      api.connectChatStream(
        token,
        activeConvoId,
        textToSend,
        (chunk) => {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === tempAssistantMsg.id ? { ...msg, content: msg.content + chunk } : msg
            )
          );
        },
        async () => {
          setUiState('idle');
          const refreshed = await api.getMessages(token, activeConvoId);
          setMessages(refreshed);
        },
        (err) => {
          setChatError(err);
          setUiState('error');
          setMessages((prev) => prev.filter((msg) => msg.id !== tempAssistantMsg.id));
        }
      );
    } else if (sendMode === 'sync') {
      try {
        const response = await api.sendMessageSync(token, activeConvoId, textToSend);
        setMessages((prev) => [...prev, response]);
        setUiState('idle');
      } catch (err: any) {
        setChatError(err.message);
        setUiState('error');
      }
    } else if (sendMode === 'rag') {
      try {
        const res = await api.sendMessageRAG(token, activeConvoId, textToSend);
        const assistantMsg: MessageExt = {
          ...res.message,
          citations: res.citations,
        };
        setMessages((prev) => [...prev, assistantMsg]);
        setUiState('idle');
      } catch (err: any) {
        setChatError(err.message);
        setUiState('error');
      }
    } else if (sendMode === 'agent') {
      // Simulate real-time transitions to tool execution node
      const toolCheck = textToSend.toLowerCase();
      let hasToolTrigger = false;
      if (toolCheck.includes('time') || toolCheck.includes('date') || toolCheck.includes('remember') || toolCheck.includes('note') || toolCheck.includes('document')) {
        hasToolTrigger = true;
      }

      const executionTimer = setTimeout(() => {
        if (hasToolTrigger) {
          setUiState('executing');
          setActiveTool(toolCheck.includes('time') ? 'get_current_time' : toolCheck.includes('document') ? 'list_documents' : 'search_memories');
        }
      }, 700);

      try {
        await api.sendMessageAgent(token, activeConvoId, textToSend);
        clearTimeout(executionTimer);
        const refreshed = await api.getMessages(token, activeConvoId);
        setMessages(refreshed);
        setUiState('idle');
      } catch (err: any) {
        clearTimeout(executionTimer);
        setChatError(err.message);
        setUiState('error');
      }
    }
  }

  // Trigger from Input Composer
  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!inputMessage.trim() || ['thinking', 'executing'].includes(uiState)) return;
    const text = inputMessage.trim();
    setInputMessage('');
    await handleSendMessageDirectly(text);
  }



  // Subsystem Operations
  async function handleAddMemory(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !newMemoryText.trim()) return;
    setMemoryError(null);
    try {
      const mem = await api.createMemory(token, newMemoryText.trim(), newMemoryImportance);
      setMemories([mem, ...memories]);
      setNewMemoryText('');
      setNewMemoryImportance(5);
    } catch (err: any) {
      setMemoryError(err.message);
    }
  }

  async function handleDeleteMemory(id: string) {
    if (!token || !confirm('Delete memory?')) return;
    try {
      await api.deleteMemory(token, id);
      setMemories(memories.filter((m) => m.id !== id));
    } catch (err: any) {
      setMemoryError(err.message);
    }
  }

  async function handleUploadDocument(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!token || !file) return;
    setDocumentError(null);
    setIsUploading(true);

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const textContent = event.target?.result as string;
        const doc = await api.createDocument(token, file.name, textContent, 'upload');
        setDocuments((prev) => [doc, ...prev]);
      } catch (err: any) {
        setDocumentError(err.message);
      } finally {
        setIsUploading(false);
      }
    };
    reader.onerror = () => {
      setDocumentError('Failed to read file.');
      setIsUploading(false);
    };
    reader.readAsText(file);

    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handleDeleteDocument(id: string) {
    if (!token || !confirm('Delete document?')) return;
    try {
      await api.deleteDocument(token, id);
      setDocuments(documents.filter((d) => d.id !== id));
    } catch (err: any) {
      setDocumentError(err.message);
    }
  }

  // Auth Screen
  if (!token) {
    return (
      <main className="auth-container">
        <div className="auth-card backdrop-blur">
          <div className="logo-section">
            <svg className="icon-glow animate-pulse" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18a3.75 3.75 0 0 0 .495-7.467 5.99 5.99 0 0 0-1.925 3.546 5.974 5.974 0 0 1-2.133-1A3.75 3.75 0 0 0 12 18Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18a3.75 3.75 0 0 0-.495-7.467 5.99 5.99 0 0 0 1.925 3.546 5.974 5.974 0 0 1 2.133-1A3.75 3.75 0 0 0 12 18Z" />
            </svg>
            <h2>GIA Assistant</h2>
            <p className="subtitle">Secure local cognitive portal</p>
          </div>

          <div className="tabs">
            <button className={`tab ${authMode === 'login' ? 'active' : ''}`} onClick={() => setAuthMode('login')}>Login</button>
            <button className={`tab ${authMode === 'signup' ? 'active' : ''}`} onClick={() => setAuthMode('signup')}>Sign Up</button>
          </div>

          <form onSubmit={handleAuth} className="auth-form">
            {authMode === 'signup' && (
              <div className="form-group">
                <label>Name</label>
                <input type="text" placeholder="Your name" value={authName} onChange={(e) => setAuthName(e.target.value)} required />
              </div>
            )}
            <div className="form-group">
              <label>Email</label>
              <input type="email" placeholder="name@domain.com" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} required />
            </div>
            <div className="form-group">
              <label>Password</label>
              <input type="password" placeholder="••••••••" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} required />
            </div>

            {authError && <div className="alert error">{authError}</div>}

            <button type="submit" className="auth-submit-btn">
              {authMode === 'login' ? 'Authenticate' : 'Create Account'}
            </button>
          </form>
        </div>
      </main>
    );
  }

  // Desktop Assistant UI
  return (
    <div className="workspace-container">
      {/* COMPACT TOP HEADER */}
      <header className="compact-header backdrop-blur">
        <div className="header-identity">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon-glow">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 18a3.75 3.75 0 0 0 .495-7.467 5.99 5.99 0 0 0-1.925 3.546" />
          </svg>
          <div className="header-title-wrapper">
            <span className="header-title">GIA</span>
            <div className={`state-indicator ${uiState}`}>
              <span className="state-dot" />
              <span>
                {uiState === 'idle' && 'Idle'}
                {uiState === 'chatting' && 'Typing...'}
                {uiState === 'thinking' && 'Thinking...'}
                {uiState === 'executing' && `Running ${activeTool}...`}
                {uiState === 'error' && 'System Error'}
              </span>
            </div>
          </div>
        </div>

        <div className="header-actions">
          {/* Switch Conversation List toggle */}
          <button 
            className={`icon-btn ${showConvosList ? 'active' : ''}`} 
            onClick={() => { setShowConvosList(!showConvosList); setActiveDrawer('none'); }}
            title="Conversations"
          >
            💬
          </button>
          
          {/* Memories */}
          <button 
            className={`icon-btn ${activeDrawer === 'memories' ? 'active' : ''}`} 
            onClick={() => { setActiveDrawer(activeDrawer === 'memories' ? 'none' : 'memories'); setShowConvosList(false); }}
            title="Memory Subsystem"
          >
            🧠
          </button>

          {/* RAG Documents */}
          <button 
            className={`icon-btn ${activeDrawer === 'documents' ? 'active' : ''}`} 
            onClick={() => { setActiveDrawer(activeDrawer === 'documents' ? 'none' : 'documents'); setShowConvosList(false); }}
            title="Document Index"
          >
            📂
          </button>

          {/* System Settings */}
          <button 
            className={`icon-btn ${activeDrawer === 'settings' ? 'active' : ''}`} 
            onClick={() => { setActiveDrawer(activeDrawer === 'settings' ? 'none' : 'settings'); setShowConvosList(false); }}
            title="System Diagnostics"
          >
            ⚙️
          </button>
        </div>
      </header>

      {/* CONVERSATION SCROLL AREA */}
      <div className="chat-window">
        {activeConvoId ? (
          <div className="messages-flow">
            {messages.length === 0 ? (
              <div className="welcome-chat">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.5 }}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18a3.75 3.75 0 0 0 .495-7.467 5.99 5.99 0 0 0-1.925 3.546" />
                </svg>
                <h2>GIA Assistant</h2>
                <p>Ready to assist. Speak or type your request below.</p>
              </div>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`message-row ${m.role}`}>
                  <div className="message-bubble">
                    <div className="msg-content">{m.content}</div>

                    {/* RAG Source Citations */}
                    {m.citations && m.citations.length > 0 && (
                      <div className="citations-list">
                        <span className="cite-lbl">Sources:</span>
                        {m.citations.map((cite: any, idx: number) => (
                          <span key={idx} className="cite-chip" title={cite.file_url}>
                            📄 {cite.name}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Agent FSM steps */}
                    {m.metadata && m.metadata.steps && (
                      <details className="telemetry-details">
                        <summary>Check GIA execution steps ({m.metadata.steps.length})</summary>
                        <div className="telemetry-step-list">
                          {m.metadata.steps.map((step: any, idx: number) => (
                            <div key={idx} className="telemetry-step-item">
                              <span className="step-node">Node: <strong>{step.node}</strong></span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="welcome-chat">
            <h2>No Conversation</h2>
            <p>Switch to or create a conversation using the chat menu.</p>
          </div>
        )}
      </div>

      {/* DETECTED DYNAMIC STATE INTERFACE OVERLAYS */}
      
      {/* COMPOSER FOOTER BAR */}
      {activeConvoId && (
        <footer className="composer-bar backdrop-blur">
          {/* Continuous Voice Mode Active State Banner */}
          {isVoiceModeActive && (
            <div className={`state-banner voice-banner voice-${voiceState.toLowerCase()}`}>
              <div className="spinner" />
              <span>
                {voiceState === 'STARTING' && '⚙️ Starting voice mode...'}
                {voiceState === 'LISTENING' && '🎙️ Listening... (Speak now)'}
                {voiceState === 'SPEECH_DETECTED' && '🗣️ Speech detected'}
                {voiceState === 'TRANSCRIBING' && '⚡ Transcribing Python STT...'}
                {voiceState === 'PROCESSING' && '🤖 Orchestrating response...'}
                {voiceState === 'SYNTHESIZING' && '🔊 Synthesizing Python TTS...'}
                {voiceState === 'PLAYING' && '🔊 GIA speaking... 🔇 (Mic muted - Feedback blocked)'}
                {voiceState === 'STOPPING' && '⏹️ Stopping voice mode...'}
              </span>

              <div className="voice-controls-group">
                {voiceState === 'PLAYING' && (
                  <button
                    type="button"
                    className="pause-voice-btn"
                    onClick={() => {
                      if (playbackState === 'PLAYING') audioPlayerRef.current?.pause();
                      else if (playbackState === 'PAUSED') audioPlayerRef.current?.resume();
                    }}
                  >
                    {playbackState === 'PAUSED' ? '▶️ Resume' : '⏸️ Pause'}
                  </button>
                )}

                <button type="button" className="stop-voice-btn" onClick={toggleVoiceMode}>
                  ⏹️ Stop Voice Mode
                </button>
              </div>
            </div>
          )}

          {/* Inline Active State Banners */}
          {uiState === 'executing' && (
            <div className="state-banner executing">
              <div className="spinner" />
              <span>🔧 Executing tool: <strong>{activeTool}</strong></span>
            </div>
          )}

          {uiState === 'thinking' && (
            <div className="state-banner">
              <div className="spinner" />
              <span>🤖 GIA thinking...</span>
            </div>
          )}

          {chatError && (
            <div className="state-banner error-banner">
              <span>⚠️ Error: {chatError}</span>
              <button className="dismiss-error-btn" onClick={() => setUiState('idle')}>&times;</button>
            </div>
          )}

          <form onSubmit={handleSendMessage} className="composer-form">
            <div className="composer-row">
              <input 
                type="text" 
                placeholder={isVoiceModeActive ? "Continuous Voice Mode active..." : "Ask GIA anything..."} 
                value={inputMessage} 
                onChange={(e) => setInputMessage(e.target.value)} 
                disabled={['thinking', 'executing'].includes(uiState) || isVoiceModeActive} 
              />

              <button
                type="button"
                className={`voice-mode-toggle-btn ${isVoiceModeActive ? 'active' : ''}`}
                onClick={toggleVoiceMode}
                title={isVoiceModeActive ? "Stop Voice Mode" : "Start Continuous Voice Mode"}
              >
                🎙️ {isVoiceModeActive ? 'ON' : 'OFF'}
              </button>

              <button 
                type="submit" 
                className="send-btn" 
                disabled={!inputMessage.trim() || ['thinking', 'executing'].includes(uiState) || isVoiceModeActive}
              >
                ➔
              </button>
            </div>

            {/* Compact Chat Mode Selector */}
            <div className="composer-selectors">
              <label className={`selector-chip ${sendMode === 'agent' ? 'active' : ''}`}>
                <input type="radio" name="sendMode" value="agent" checked={sendMode === 'agent'} onChange={() => setSendMode('agent')} />
                🤖 Agent
              </label>
              <label className={`selector-chip ${sendMode === 'stream' ? 'active' : ''}`}>
                <input type="radio" name="sendMode" value="stream" checked={sendMode === 'stream'} onChange={() => setSendMode('stream')} />
                ⚡ Stream
              </label>
              <label className={`selector-chip ${sendMode === 'rag' ? 'active' : ''}`}>
                <input type="radio" name="sendMode" value="rag" checked={sendMode === 'rag'} onChange={() => setSendMode('rag')} />
                🔍 RAG
              </label>
              <label className={`selector-chip ${sendMode === 'sync' ? 'active' : ''}`}>
                <input type="radio" name="sendMode" value="sync" checked={sendMode === 'sync'} onChange={() => setSendMode('sync')} />
                💬 Sync
              </label>
            </div>
          </form>
        </footer>
      )}

      {/* OVERLAY PANEL DRAWERS */}

      {/* 1. Switch Conversation overlay */}
      {showConvosList && (
        <div className="convo-switcher-drawer backdrop-blur">
          <div className="drawer-header">
            <h4>Select Discussion</h4>
            <button className="close-drawer-btn" onClick={() => setShowConvosList(false)}>&times;</button>
          </div>
          <button className="new-convo-btn" onClick={handleCreateConvo}>+ Start New Chat</button>
          <div className="convo-list-scroll">
            {isConversationsLoading ? (
              <div className="empty-state">Loading discussions...</div>
            ) : conversations.length === 0 ? (
              <div className="empty-state">No discussions found.</div>
            ) : (
              conversations.map((c) => (
                <div key={c.id} className={`convo-item ${activeConvoId === c.id ? 'active' : ''}`} onClick={() => selectConversation(c.id)}>
                  <div className="convo-title-box">
                    <span>💬</span>
                    <span className="convo-title-text">{c.title}</span>
                  </div>
                  <button className="delete-convo-btn" onClick={(e) => handleDeleteConvo(c.id, e)}>&times;</button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* 2. Memories overlay */}
      {activeDrawer === 'memories' && (
        <div className="drawer-panel backdrop-blur">
          <div className="drawer-header">
            <h4>🧠 Memory Subsystem</h4>
            <button className="close-drawer-btn" onClick={() => setActiveDrawer('none')}>&times;</button>
          </div>
          <div className="drawer-content">
            <div className="drawer-inner">
              <form onSubmit={handleAddMemory} className="drawer-form">
                <div className="form-group">
                  <label>Store user preferences & facts</label>
                  <textarea placeholder="The user prefers typescript..." value={newMemoryText} onChange={(e) => setNewMemoryText(e.target.value)} required />
                </div>
                <div className="form-group">
                  <label>Importance (1 - 10)</label>
                  <input type="number" min="1" max="10" value={newMemoryImportance} onChange={(e) => setNewMemoryImportance(Number(e.target.value))} />
                </div>
                <button type="submit" className="auth-submit-btn">Save preference</button>
              </form>

              {memoryError && <div className="alert error">{memoryError}</div>}

              <div className="drawer-list">
                <h5>Extracted Facts ({memories.length})</h5>
                {memories.length === 0 ? (
                  <div className="empty-state">No items stored.</div>
                ) : (
                  memories.map((m) => (
                    <div key={m.id} className="drawer-item">
                      <div className="item-text">{m.content}</div>
                      <div className="item-meta">
                        <span>Importance: {m.importance}</span>
                        <button className="del-item-btn" onClick={() => handleDeleteMemory(m.id)}>Delete</button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 3. Documents overlay */}
      {activeDrawer === 'documents' && (
        <div className="drawer-panel backdrop-blur">
          <div className="drawer-header">
            <h4>📂 Document Index (RAG)</h4>
            <button className="close-drawer-btn" onClick={() => setActiveDrawer('none')}>&times;</button>
          </div>
          <div className="drawer-content">
            <div className="drawer-inner">
              <div className="upload-box">
                <label className="upload-label">
                  <input type="file" ref={fileInputRef} onChange={handleUploadDocument} disabled={isUploading} style={{ display: 'none' }} />
                  <span>{isUploading ? 'Ingesting chunks...' : '📄 Click to upload document'}</span>
                </label>
              </div>

              {documentError && <div className="alert error">{documentError}</div>}

              <div className="drawer-list">
                <h5>Indexed Files ({documents.length})</h5>
                {documents.length === 0 ? (
                  <div className="empty-state">No documents indexed.</div>
                ) : (
                  documents.map((d) => (
                    <div key={d.id} className="drawer-item">
                      <div className="item-text">{d.name}</div>
                      <div className="item-meta">
                        <span>{(d.file_size ? d.file_size / 1024 : 0).toFixed(1)} KB</span>
                        <button className="del-item-btn" onClick={() => handleDeleteDocument(d.id)}>Delete</button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. Settings/Specs overlay */}
      {activeDrawer === 'settings' && (
        <div className="drawer-panel backdrop-blur">
          <div className="drawer-header">
            <h4>⚙️ Diagnostics & Gateways</h4>
            <button className="close-drawer-btn" onClick={() => setActiveDrawer('none')}>&times;</button>
          </div>
          <div className="drawer-content">
            <div className="drawer-inner">
              <div className="form-group">
                <label>Active Cognitive LLM Slot</label>
                <select value={modelSlot} onChange={(e) => setModelSlot(e.target.value as any)}>
                  <option value="fast">Fast Completion Engine (Gemini)</option>
                  <option value="general">General (OpenAI)</option>
                  <option value="reasoning">Deep Reasoning (Anthropic)</option>
                </select>
              </div>

              <div className="system-specs">
                <h5>System Specs</h5>
                <ul>
                  <li><span>Health Status</span> <span style={{color: healthStatus === 'Online' ? 'var(--success-color)' : 'var(--error-color)'}}>{healthStatus}</span></li>
                  <li><span>Mic Permission</span> <span style={{textTransform: 'capitalize'}}>{micPermissionStatus}</span></li>
                  <li><span>Gateway Mode</span> <span>Dynamic Router</span></li>
                  <li><span>Max Agent Steps</span> <span>5 steps limit</span></li>
                </ul>
                <button
                  type="button"
                  className="btn-grant-access"
                  style={{ marginTop: '12px', fontSize: '0.8rem', padding: '8px 12px' }}
                  onClick={() => setShowMicTestModal(true)}
                >
                  🎙️ Run Native Microphone Capture Test
                </button>
              </div>

              <div className="settings-user-bar">
                <div>
                  <div style={{fontSize: '0.8rem', fontWeight: 600}}>{user?.name}</div>
                  <div style={{fontSize: '0.7rem', color: 'var(--text-secondary)'}}>{user?.email}</div>
                </div>
                <button className="del-item-btn" onClick={handleLogout}>Log out</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* NATIVE MICROPHONE BOUNDARY TEST MODAL */}
      <MicTestModal isOpen={showMicTestModal} onClose={() => setShowMicTestModal(false)} />

      {/* MICROPHONE ACCESS PERMISSION MODAL */}
      {showMicModal && (
        <div className="modal-overlay">
          <div className="mic-modal-card backdrop-blur">
            <div className="mic-icon-wrapper">🎙️</div>
            <h3>Microphone Access Required</h3>
            <p>
              GIA Assistant requires desktop microphone access to enable continuous voice interaction, speech-to-text recognition, and hands-free control.
            </p>
            <div className="mic-modal-actions">
              <button type="button" className="btn-grant-access" onClick={handleGrantMicPermission}>
                Give Access
              </button>
              <button type="button" className="btn-reject-access" onClick={handleRejectMicPermission}>
                Reject
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

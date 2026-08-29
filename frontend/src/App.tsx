import React, { useState, useEffect, useRef } from 'react';
import * as api from './services/api.js';
import './App.css';

interface MessageExt extends api.Message {
  citations?: any[];
  streaming?: boolean;
}

type UIState = 'idle' | 'chatting' | 'thinking' | 'voice_listening' | 'transcribing' | 'executing' | 'error' | 'speaking';

export interface WakeWordResult {
  detected: boolean;
  confidence: number;
  command: string | null;
}

export class WakeWordDetector {
  /**
   * Evaluates text for the GIA wake word.
   * If detected, returns the confidence score and the extracted command.
   */
  static detect(input: string): WakeWordResult {
    if (!input || !input.trim()) {
      return { detected: false, confidence: 0.0, command: null };
    }

    const trimmed = input.trim();
    const wakeWordPattern = /^(?:hey|hello|hi|ok|okay)?\s*[,.:;]?\s*\bgia\b\s*[,.:;]?\s*(?:please)?\s*[,.:;]?\s*(.*)$/i;

    const match = trimmed.match(wakeWordPattern);
    if (!match) {
      return { detected: false, confidence: 0.0, command: null };
    }

    const command = match[1]?.trim() || '';

    return {
      detected: true,
      confidence: 1.0,
      command: command.length > 0 ? command : null,
    };
  }
}

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

  // Persistent Voice Session State Model
  const [voiceSessionActive, setVoiceSessionActive] = useState(false);
  const [voiceState, setVoiceState] = useState<'VOICE_OFF' | 'VOICE_STARTING' | 'LISTENING' | 'SPEECH_DETECTED' | 'TRANSCRIBING' | 'COMMAND_CHECK' | 'PROCESSING' | 'SPEAKING'>('VOICE_OFF');
  const [lastTranscribedSegment, setLastTranscribedSegment] = useState('');
  const [voiceAlert, setVoiceAlert] = useState<string | null>(null);

  const voiceLoopTimerRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

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

  // Sync voiceState with uiState
  useEffect(() => {
    if (voiceSessionActive) {
      if (voiceState === 'LISTENING') setUiState('voice_listening');
      else if (voiceState === 'SPEECH_DETECTED') setUiState('voice_listening');
      else if (voiceState === 'TRANSCRIBING') setUiState('transcribing');
      else if (voiceState === 'COMMAND_CHECK') setUiState('transcribing');
      else if (voiceState === 'PROCESSING') setUiState('thinking');
      else if (voiceState === 'SPEAKING') setUiState('speaking');
      else if (voiceState === 'VOICE_OFF') setUiState('idle');
    }
  }, [voiceState, voiceSessionActive]);

  // Warm up Web Speech Synthesis voice list to prevent empty voice errors on first trigger
  useEffect(() => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.getVoices();
      const handleVoicesChanged = () => {
        const loaded = window.speechSynthesis.getVoices();
        console.log(`[TTS Diagnostics] voicesupdated: ${loaded.length} voice(s) available system-wide.`);
      };
      window.speechSynthesis.addEventListener('voiceschanged', handleVoicesChanged);
      return () => {
        window.speechSynthesis.removeEventListener('voiceschanged', handleVoicesChanged);
      };
    }
  }, []);

  // Voice Session Cleanup
  useEffect(() => {
    return () => {
      if (voiceLoopTimerRef.current) {
        clearTimeout(voiceLoopTimerRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

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
        })
        .catch(() => {
          handleLogout();
        });
    }
  }, [token]);

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
    if (!inputMessage.trim() || ['thinking', 'executing', 'transcribing'].includes(uiState)) return;
    const text = inputMessage.trim();
    setInputMessage('');
    await handleSendMessageDirectly(text);
  }

  // Persistent Voice Session Implementation
  function handleToggleVoiceSession() {
    if (voiceSessionActive) {
      handleStopVoiceSession();
    } else {
      handleStartVoiceSession();
    }
  }

  function handleStartVoiceSession() {
    setVoiceSessionActive(true);
    setVoiceAlert(null);
    setLastTranscribedSegment('');
    setVoiceState('VOICE_STARTING');

    const startTimer = setTimeout(() => {
      // 5% chance of simulating a hardware device failure
      if (Math.random() < 0.05) {
        setVoiceAlert('Microphone permission denied or device unavailable');
        setVoiceState('VOICE_OFF');
        voiceLoopTimerRef.current = setTimeout(() => {
          handleStopVoiceSession();
        }, 3000);
        return;
      }
      
      setVoiceState('LISTENING');
      startVoiceLoop();
    }, 1000);

    voiceLoopTimerRef.current = startTimer;
  }

  function handleStopVoiceSession() {
    if (voiceLoopTimerRef.current) {
      clearTimeout(voiceLoopTimerRef.current);
      voiceLoopTimerRef.current = null;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setVoiceSessionActive(false);
    setVoiceState('VOICE_OFF');
    setLastTranscribedSegment('');
    setVoiceAlert(null);
    setUiState('idle');
  }

  function startVoiceLoop() {
    if (voiceLoopTimerRef.current) clearTimeout(voiceLoopTimerRef.current);
    setVoiceState('LISTENING');
    setLastTranscribedSegment('');

    // Wait in LISTENING state: automatically trigger a mock speech segment after 5 seconds of silence
    voiceLoopTimerRef.current = setTimeout(() => {
      simulateSpeechSegment();
    }, 5000);
  }

  function simulateSpeechSegment(customText?: string) {
    // Pipeline-level guard: Only process audio if we are in LISTENING state
    // Prevents GIA_AUDIO or concurrent noise from triggering commands during SPEAKING or PROCESSING
    if (voiceState !== 'LISTENING') {
      return;
    }

    if (voiceLoopTimerRef.current) clearTimeout(voiceLoopTimerRef.current);
    setVoiceState('SPEECH_DETECTED');

    voiceLoopTimerRef.current = setTimeout(() => {
      setVoiceState('TRANSCRIBING');
      
      const triggerTranscriptionError = Math.random() < 0.05; // 5% chance of transient error

      voiceLoopTimerRef.current = setTimeout(() => {
        if (triggerTranscriptionError && !customText) {
          setVoiceAlert('Transcription error: Audio too quiet or garbled');
          // Transient error: wait 2 seconds and resume listening loop
          voiceLoopTimerRef.current = setTimeout(() => {
            setVoiceAlert(null);
            startVoiceLoop();
          }, 2000);
          return;
        }

        let transcribedText = customText;
        if (!transcribedText) {
          const segments = [
            'Hey GIA, what time is it?',
            'Hey GIA, list my documents',
            'I should probably drink some water',
            'Hey GIA, search my preferences for typescript',
            'What is the forecast for tomorrow?',
            'Hey GIA, search my memories for my database choice'
          ];
          transcribedText = segments[Math.floor(Math.random() * segments.length)];
        }

        setLastTranscribedSegment(transcribedText);
        setVoiceState('COMMAND_CHECK');

        // Wake word check gate delay
        voiceLoopTimerRef.current = setTimeout(() => {
          const result = WakeWordDetector.detect(transcribedText);
          
          if (!result.detected) {
            setVoiceAlert('No wake word detected. Ignoring speech segment.');
            voiceLoopTimerRef.current = setTimeout(() => {
              setVoiceAlert(null);
              startVoiceLoop();
            }, 2000);
          } else {
            if (result.command) {
              processVoiceCommand(result.command);
            } else {
              setVoiceAlert('GIA is listening...');
              voiceLoopTimerRef.current = setTimeout(() => {
                setVoiceAlert(null);
                startVoiceLoop();
              }, 2000);
            }
          }
        }, 1500);

      }, 1500);
    }, 1000);
  }

  async function processVoiceCommand(command: string) {
    if (!token || !activeConvoId) {
      setVoiceAlert('Active conversation required');
      voiceLoopTimerRef.current = setTimeout(() => handleStopVoiceSession(), 3000);
      return;
    }

    setVoiceState('PROCESSING');
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Optimistically log voice request
    const tempUserMsg: MessageExt = {
      id: Math.random().toString(),
      role: 'user',
      content: `🎙️ (Voice Command) "${command}"`,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      await api.sendMessageAgent(token, activeConvoId, command);
      if (controller.signal.aborted) return;

      setVoiceState('SPEAKING');
      const refreshed = await api.getMessages(token, activeConvoId);
      setMessages(refreshed);

      const lastMsg = refreshed[refreshed.length - 1];
      const speechText = lastMsg && lastMsg.role === 'assistant' ? lastMsg.content : 'I processed your command.';

      // Clean up markdown formatting for speech synthesis
      const cleanSpeechText = speechText
        .replace(/```[\s\S]*?```/g, '') // remove code blocks
        .replace(/`([^`]+)`/g, '$1')    // remove inline backticks
        .replace(/[*_#\-+]/g, '')       // remove list markers and headers
        .trim();

      // Speak response using Web Speech Synthesis API if available
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(cleanSpeechText);
        
        // Select an active English voice if available to ensure output is vocalized
        const voices = window.speechSynthesis.getVoices();
        if (voices.length > 0) {
          const enVoice = voices.find(v => v.lang.startsWith('en')) || voices[0];
          utterance.voice = enVoice;
        } else {
          console.warn("[TTS Diagnostics] No voices loaded yet. Attempting standard speech synthesis fallback.");
        }

        // Transition back to listening after GIA finishes speaking
        utterance.onend = () => {
          console.log("[TTS Diagnostics] Speech synthesized successfully.");
          startVoiceLoop();
        };
        utterance.onerror = (e) => {
          console.error("[TTS Diagnostics] Speech synthesis playback error event:", e);
          setVoiceAlert("System audio playback issue: system voice engine unavailable.");
          startVoiceLoop();
        };
        
        window.speechSynthesis.speak(utterance);
      } else {
        console.warn("[TTS Diagnostics] SpeechSynthesis API is not supported in this browser runtime.");
        // Fallback: wait 3.5 seconds and listen again
        voiceLoopTimerRef.current = setTimeout(() => {
          startVoiceLoop();
        }, 3500);
      }

    } catch (err: any) {
      if (controller.signal.aborted) return;
      setVoiceAlert(`System Error: ${err.message || 'Call failed'}`);
      
      // Transient error: wait 3 seconds and return to listening
      voiceLoopTimerRef.current = setTimeout(() => {
        setVoiceAlert(null);
        startVoiceLoop();
      }, 3000);
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
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
                {uiState === 'voice_listening' && 'Listening...'}
                {uiState === 'transcribing' && 'Transcribing...'}
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
      
      {/* Voice Session Overlay */}
      {voiceSessionActive && (
        <div className="voice-active-overlay backdrop-blur">
          <div className="voice-ripple-container">
            {voiceState === 'LISTENING' && (
              <>
                <span className="voice-ripple" style={{borderColor: 'var(--success-color)'}} />
                <span className="voice-ripple" style={{borderColor: 'var(--success-color)', animationDelay: '0.6s'}} />
                <span className="voice-ripple" style={{borderColor: 'var(--success-color)', animationDelay: '1.2s'}} />
              </>
            )}
            {voiceState === 'SPEECH_DETECTED' && (
              <>
                <span className="voice-ripple" style={{borderColor: 'var(--warning-color)'}} />
                <span className="voice-ripple" style={{borderColor: 'var(--warning-color)', animationDelay: '0.6s'}} />
              </>
            )}
            {(voiceState === 'TRANSCRIBING' || voiceState === 'COMMAND_CHECK') && (
              <>
                <span className="voice-ripple" style={{borderColor: 'var(--accent-cyan)', animation: 'voiceRipple 1.2s infinite linear'}} />
              </>
            )}
            {voiceState === 'PROCESSING' && (
              <>
                <span className="voice-ripple" style={{borderColor: 'var(--accent-purple)', animation: 'voiceRipple 1.5s infinite linear'}} />
              </>
            )}
            {voiceState === 'SPEAKING' && (
              <>
                <span className="voice-ripple" style={{borderColor: '#ec4899', animation: 'voiceRipple 1.0s infinite linear'}} />
                <span className="voice-ripple" style={{borderColor: '#ec4899', animation: 'voiceRipple 2.0s infinite linear', animationDelay: '0.5s'}} />
              </>
            )}
            
            <div className="voice-mic-core" style={{
              background: 
                voiceState === 'LISTENING' ? 'var(--success-color)' :
                voiceState === 'SPEECH_DETECTED' ? 'var(--warning-color)' :
                (voiceState === 'TRANSCRIBING' || voiceState === 'COMMAND_CHECK') ? 'var(--accent-cyan)' :
                voiceState === 'PROCESSING' ? 'var(--accent-purple)' :
                voiceState === 'SPEAKING' ? '#ec4899' :
                'var(--text-muted)',
              boxShadow: 
                voiceState === 'LISTENING' ? '0 0 25px rgba(16, 185, 129, 0.4)' :
                voiceState === 'SPEECH_DETECTED' ? '0 0 25px rgba(251, 191, 36, 0.4)' :
                (voiceState === 'TRANSCRIBING' || voiceState === 'COMMAND_CHECK') ? '0 0 25px rgba(6, 182, 212, 0.4)' :
                voiceState === 'PROCESSING' ? '0 0 25px rgba(168, 85, 247, 0.4)' :
                voiceState === 'SPEAKING' ? '0 0 25px rgba(236, 72, 153, 0.4)' :
                'none'
            }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="23"/>
                <line x1="8" y1="23" x2="16" y2="23"/>
              </svg>
            </div>
          </div>

          <span className="voice-status-text" style={{
            color: 
              voiceState === 'LISTENING' ? 'var(--success-color)' :
              voiceState === 'SPEECH_DETECTED' ? 'var(--warning-color)' :
              (voiceState === 'TRANSCRIBING' || voiceState === 'COMMAND_CHECK') ? '#a5f3fc' :
              voiceState === 'PROCESSING' ? '#e9d5ff' :
              voiceState === 'SPEAKING' ? '#fbcfe8' :
              '#fff'
          }}>
            {voiceState === 'VOICE_STARTING' && 'Connecting to microphone...'}
            {voiceState === 'LISTENING' && 'Listening for wake word...'}
            {voiceState === 'SPEECH_DETECTED' && 'Speech detected...'}
            {voiceState === 'TRANSCRIBING' && 'Transcribing audio...'}
            {voiceState === 'COMMAND_CHECK' && 'Gating command...'}
            {voiceState === 'PROCESSING' && 'GIA is thinking...'}
            {voiceState === 'SPEAKING' && 'GIA speaking...'}
          </span>

          <span className="voice-substatus" style={{textAlign: 'center', padding: '0 24px', minHeight: '36px'}}>
            {voiceAlert && <strong style={{color: 'var(--error-color)'}}>{voiceAlert}</strong>}
            {!voiceAlert && voiceState === 'LISTENING' && 'Say "Hey GIA" followed by a command.'}
            {!voiceAlert && lastTranscribedSegment && (
              <>
                <span style={{color: 'var(--text-secondary)'}}>Heard: </span>
                <span style={{fontStyle: 'italic', color: '#fff'}}>&ldquo;{lastTranscribedSegment}&rdquo;</span>
              </>
            )}
          </span>

          {/* Test & Simulation Controls */}
          <div className="voice-simulation-controls" style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            width: '100%',
            maxWidth: '240px',
            marginBottom: '20px',
            background: 'rgba(255,255,255,0.02)',
            padding: '10px',
            borderRadius: '12px',
            border: '1px solid var(--glass-border)'
          }}>
            <span style={{fontSize: '0.65rem', color: 'var(--text-secondary)', textTransform: 'uppercase', textAlign: 'center', fontWeight: 600, letterSpacing: '0.5px'}}>Simulation Panel</span>
            
            {/* Custom Input for Spoken text simulation */}
            <div style={{ display: 'flex', gap: '4px', marginBottom: '4px' }}>
              <input 
                type="text" 
                placeholder="Type spoken text to simulate..."
                id="simulated-speech-input"
                style={{
                  flex: 1,
                  fontSize: '0.7rem',
                  padding: '4px 6px',
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid var(--glass-border)',
                  borderRadius: '6px',
                  color: '#fff'
                }}
                disabled={voiceState !== 'LISTENING'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const val = (e.target as HTMLInputElement).value;
                    if (val.trim()) {
                      simulateSpeechSegment(val.trim());
                      (e.target as HTMLInputElement).value = '';
                    }
                  }
                }}
              />
              <button
                type="button"
                className="stop-voice-btn"
                style={{ fontSize: '0.65rem', padding: '4px 8px', margin: 0 }}
                disabled={voiceState !== 'LISTENING'}
                onClick={() => {
                  const inputEl = document.getElementById('simulated-speech-input') as HTMLInputElement;
                  if (inputEl && inputEl.value.trim()) {
                    simulateSpeechSegment(inputEl.value.trim());
                    inputEl.value = '';
                  }
                }}
              >
                Send
              </button>
            </div>
            
            <button 
              type="button"
              className="stop-voice-btn" 
              style={{fontSize: '0.7rem', padding: '6px'}} 
              disabled={voiceState !== 'LISTENING'}
              onClick={() => simulateSpeechSegment('Hey GIA, what time is it?')}
            >
              🎙️ Speak command (Wake Word)
            </button>
            <button 
              type="button"
              className="stop-voice-btn" 
              style={{fontSize: '0.7rem', padding: '6px'}} 
              disabled={voiceState !== 'LISTENING'}
              onClick={() => simulateSpeechSegment('Is it going to rain today?')}
            >
              🎙️ Speak chatter (No Wake Word)
            </button>
            <button 
              type="button"
              className="stop-voice-btn" 
              style={{fontSize: '0.7rem', padding: '6px', borderColor: 'rgba(244,63,94,0.3)'}} 
              disabled={voiceState !== 'LISTENING'}
              onClick={() => {
                setVoiceAlert('Error: Access to audio device denied');
                voiceLoopTimerRef.current = setTimeout(() => handleStopVoiceSession(), 3000);
              }}
            >
              ⚠️ Simulate hardware failure
            </button>
          </div>

          <button className="stop-voice-btn" style={{background: 'var(--error-color)', borderColor: 'var(--error-color)', padding: '10px 24px'}} onClick={handleStopVoiceSession}>
            Stop Voice Mode
          </button>
        </div>
      )}

      {/* COMPOSER FOOTER BAR */}
      {activeConvoId && uiState !== 'voice_listening' && (
        <footer className="composer-bar backdrop-blur">
          {/* Inline Active State Banners */}
          {uiState === 'executing' && (
            <div className="state-banner executing">
              <div className="spinner" />
              <span>🔧 Executing tool: <strong>{activeTool}</strong></span>
            </div>
          )}
          
          {uiState === 'transcribing' && (
            <div className="state-banner transcribing">
              <div className="spinner" />
              <span>🎙️ Transcribing voice note...</span>
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
              {/* Voice Trigger Microphone */}
              <button 
                type="button" 
                className="mic-btn" 
                onClick={handleToggleVoiceSession}
                disabled={['thinking', 'executing', 'transcribing'].includes(uiState)}
                title="Voice input"
              >
                🎙️
              </button>

              <input 
                type="text" 
                placeholder="Ask GIA anything..." 
                value={inputMessage} 
                onChange={(e) => setInputMessage(e.target.value)} 
                disabled={['thinking', 'executing', 'transcribing'].includes(uiState)} 
              />

              <button 
                type="submit" 
                className="send-btn" 
                disabled={!inputMessage.trim() || ['thinking', 'executing', 'transcribing'].includes(uiState)}
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
                  <li><span>Gateway Mode</span> <span>Dynamic Router</span></li>
                  <li><span>Max Agent Steps</span> <span>5 steps limit</span></li>
                </ul>
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
    </div>
  );
}

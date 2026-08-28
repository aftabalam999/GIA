import React, { useState, useEffect, useRef } from 'react';
import * as api from './services/api.js';
import './App.css';

interface MessageExt extends api.Message {
  citations?: any[];
  streaming?: boolean;
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
  const [sendMode, setSendMode] = useState<'stream' | 'sync' | 'rag' | 'agent'>('stream');

  // Loaders & Errors
  const [isSending, setIsSending] = useState(false);
  const [isConversationsLoading, setIsConversationsLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  // Settings & Drawers
  const [activeDrawer, setActiveDrawer] = useState<'none' | 'memories' | 'documents' | 'settings'>('none');
  const [memories, setMemories] = useState<api.Memory[]>([]);
  const [newMemoryText, setNewMemoryText] = useState('');
  const [newMemoryImportance, setNewMemoryImportance] = useState(5);
  const [memoryError, setMemoryError] = useState<string | null>(null);

  const [documents, setDocuments] = useState<api.DocumentInfo[]>([]);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const [modelSlot, setModelSlot] = useState<'fast' | 'general' | 'reasoning'>('general');

  // Diagnostics
  const [healthStatus, setHealthStatus] = useState<string>('Online');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Fetch user profile securely if session exists
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

  // System Diagnostics
  async function checkBackendHealth() {
    try {
      const data = await api.fetchHealthStatus();
      setHealthStatus(data.status === 'healthy' ? 'Online' : 'Degraded');
    } catch {
      setHealthStatus('Offline');
    }
  }

  // Load data
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
    try {
      const msgs = await api.getMessages(token, id);
      setMessages(msgs);
    } catch (err: any) {
      setChatError('Failed to fetch message history: ' + err.message);
    }
  }

  // Auth Action handlers
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
      // Ignore network errors on logout
    }
    localStorage.removeItem('gia_token');
    setToken(null);
    setUser(null);
    setConversations([]);
    setActiveConvoId(null);
    setMessages([]);
  }

  // Conversation Action handlers
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
    if (!token || !confirm('Are you sure you want to delete this conversation?')) return;
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

  // Message Send actions
  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !activeConvoId || !inputMessage.trim() || isSending) return;

    const userText = inputMessage.trim();
    setInputMessage('');
    setChatError(null);
    setIsSending(true);

    // Optimistically push user message
    const tempUserMsg: MessageExt = {
      id: Math.random().toString(),
      role: 'user',
      content: userText,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    if (sendMode === 'stream') {
      // WebSocket streaming mode
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
        userText,
        (chunk) => {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === tempAssistantMsg.id ? { ...msg, content: msg.content + chunk } : msg
            )
          );
        },
        async () => {
          // Completed
          setIsSending(false);
          // Reload messages from server to sync final saved state
          const refreshed = await api.getMessages(token, activeConvoId);
          setMessages(refreshed);
        },
        (err) => {
          setIsSending(false);
          setChatError('Streaming error: ' + err);
          setMessages((prev) => prev.filter((msg) => msg.id !== tempAssistantMsg.id));
        }
      );
    } else if (sendMode === 'sync') {
      try {
        const response = await api.sendMessageSync(token, activeConvoId, userText);
        setMessages((prev) => [...prev, response]);
      } catch (err: any) {
        setChatError('Error: ' + err.message);
      } finally {
        setIsSending(false);
      }
    } else if (sendMode === 'rag') {
      try {
        const res = await api.sendMessageRAG(token, activeConvoId, userText);
        const assistantMsg: MessageExt = {
          ...res.message,
          citations: res.citations,
        };
        setMessages((prev) => [...prev, assistantMsg]);
      } catch (err: any) {
        setChatError('RAG Error: ' + err.message);
      } finally {
        setIsSending(false);
      }
    } else if (sendMode === 'agent') {
      try {
        await api.sendMessageAgent(token, activeConvoId, userText);
        // Replace optimistic message list with formal logs
        const refreshed = await api.getMessages(token, activeConvoId);
        setMessages(refreshed);
      } catch (err: any) {
        setChatError('Agent Error: ' + err.message);
      } finally {
        setIsSending(false);
      }
    }
  }

  // Memory Actions
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
    if (!token || !confirm('Delete memory record?')) return;
    try {
      await api.deleteMemory(token, id);
      setMemories(memories.filter((m) => m.id !== id));
    } catch (err: any) {
      setMemoryError(err.message);
    }
  }

  // Documents Actions
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
      setDocumentError('Failed to read local file.');
      setIsUploading(false);
    };
    reader.readAsText(file);

    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handleDeleteDocument(id: string) {
    if (!token || !confirm('Delete uploaded document and delete vector chunks?')) return;
    try {
      await api.deleteDocument(token, id);
      setDocuments(documents.filter((d) => d.id !== id));
    } catch (err: any) {
      setDocumentError(err.message);
    }
  }

  // --- Auth View ---
  if (!token) {
    return (
      <main className="auth-container">
        <div className="auth-card backdrop-blur">
          <div className="logo-section">
            <svg className="icon-glow animate-pulse" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18a3.75 3.75 0 0 0 .495-7.467 5.99 5.99 0 0 0-1.925 3.546 5.974 5.974 0 0 1-2.133-1A3.75 3.75 0 0 0 12 18Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18a3.75 3.75 0 0 0-.495-7.467 5.99 5.99 0 0 0 1.925 3.546 5.974 5.974 0 0 1 2.133-1A3.75 3.75 0 0 0 12 18Z" />
            </svg>
            <h2>GIA Assistant</h2>
            <p className="subtitle">Secure modular AI systems management portal</p>
          </div>

          <div className="tabs">
            <button className={`tab ${authMode === 'login' ? 'active' : ''}`} onClick={() => setAuthMode('login')}>Login</button>
            <button className={`tab ${authMode === 'signup' ? 'active' : ''}`} onClick={() => setAuthMode('signup')}>Sign Up</button>
          </div>

          <form onSubmit={handleAuth} className="auth-form">
            {authMode === 'signup' && (
              <div className="form-group">
                <label>Name</label>
                <input type="text" placeholder="Enter name" value={authName} onChange={(e) => setAuthName(e.target.value)} required />
              </div>
            )}
            <div className="form-group">
              <label>Email Address</label>
              <input type="email" placeholder="name@domain.com" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} required />
            </div>
            <div className="form-group">
              <label>Password</label>
              <input type="password" placeholder="Enter password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} required />
            </div>

            {authError && <div className="alert error">{authError}</div>}

            <button type="submit" className="auth-submit-btn gradient-btn">
              {authMode === 'login' ? 'Authenticate System' : 'Create GIA Account'}
            </button>
          </form>
        </div>
      </main>
    );
  }

  // --- Core Application View ---
  return (
    <div className="workspace-container">
      {/* Sidebar Panel */}
      <aside className="sidebar backdrop-blur">
        <div className="sidebar-header">
          <div className="logo-box">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18a3.75 3.75 0 0 0 .495-7.467 5.99 5.99 0 0 0-1.925 3.546" />
            </svg>
            <span className="logo-text">GIA Assistant</span>
          </div>
          <span className="health-badge dot green">{healthStatus}</span>
        </div>

        <button className="new-chat-btn gradient-btn" onClick={handleCreateConvo}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          New Conversation
        </button>

        <div className="convo-scroll-area">
          {isConversationsLoading ? (
            <div className="loading-spinner-box"><div className="spinner"></div></div>
          ) : conversations.length === 0 ? (
            <div className="empty-state">No conversations found.</div>
          ) : (
            conversations.map((c) => (
              <div key={c.id} className={`convo-item ${activeConvoId === c.id ? 'active' : ''}`} onClick={() => selectConversation(c.id)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="convo-icon">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
                <span className="convo-title">{c.title}</span>
                <button className="delete-convo-btn" onClick={(e) => handleDeleteConvo(c.id, e)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                </button>
              </div>
            ))
          )}
        </div>

        {/* User bar */}
        <div className="user-profile-bar">
          <div className="user-info">
            <div className="avatar">{user?.name[0].toUpperCase()}</div>
            <div className="details">
              <span className="username">{user?.name}</span>
              <span className="useremail">{user?.email}</span>
            </div>
          </div>
          <button className="logout-btn" onClick={handleLogout} title="Logout">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
              <polyline points="16 17 21 12 16 7"></polyline>
              <line x1="21" y1="12" x2="9" y2="12"></line>
            </svg>
          </button>
        </div>
      </aside>

      {/* Main Workspace Frame */}
      <main className="workspace-main">
        <header className="workspace-header backdrop-blur">
          <div className="header-left">
            <h3>{conversations.find((c) => c.id === activeConvoId)?.title || 'Workspace'}</h3>
          </div>

          <div className="header-controls">
            <button className={`control-btn ${activeDrawer === 'memories' ? 'active' : ''}`} onClick={() => setActiveDrawer(activeDrawer === 'memories' ? 'none' : 'memories')}>
              🧠 Memories
            </button>
            <button className={`control-btn ${activeDrawer === 'documents' ? 'active' : ''}`} onClick={() => setActiveDrawer(activeDrawer === 'documents' ? 'none' : 'documents')}>
              📂 Documents
            </button>
            <button className={`control-btn ${activeDrawer === 'settings' ? 'active' : ''}`} onClick={() => setActiveDrawer(activeDrawer === 'settings' ? 'none' : 'settings')}>
              ⚙️ Settings
            </button>
          </div>
        </header>

        {/* Chat dialogue container */}
        <div className="chat-window">
          {activeConvoId ? (
            <div className="messages-flow">
              {messages.length === 0 ? (
                <div className="welcome-chat">
                  <h2>Hello, {user?.name}</h2>
                  <p>Ask a question, upload research documents, or configure cognitive memories.</p>
                </div>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={`message-row ${m.role}`}>
                    <div className="message-bubble">
                      <div className="msg-content">{m.content}</div>

                      {/* Cite chip references */}
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

                      {/* Tool Call/Agent run Telemetry list */}
                      {m.metadata && m.metadata.steps && (
                        <details className="telemetry-details">
                          <summary>🔍 Check orchestration flow steps ({m.metadata.steps.length})</summary>
                          <div className="telemetry-step-list">
                            {m.metadata.steps.map((step: any, idx: number) => (
                              <div key={idx} className="telemetry-step-item">
                                <span className="step-time">[{new Date(step.timestamp).toLocaleTimeString()}]</span>
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
              {isSending && sendMode !== 'stream' && (
                <div className="message-row assistant">
                  <div className="message-bubble typing-dots">
                    <span></span><span></span><span></span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          ) : (
            <div className="empty-chat-state">
              <h3>No Conversation Selected</h3>
              <p>Create or select a chat thread from the left menu to start typing.</p>
            </div>
          )}

          {chatError && <div className="alert error chat-alert">{chatError}</div>}
        </div>

        {/* Footer Composer bar */}
        {activeConvoId && (
          <footer className="composer-bar backdrop-blur">
            <form onSubmit={handleSendMessage} className="composer-form">
              <div className="composer-row">
                <input type="text" placeholder="Prompt GIA Assistant..." value={inputMessage} onChange={(e) => setInputMessage(e.target.value)} disabled={isSending} />
                <button type="submit" className="send-btn gradient-btn" disabled={isSending || !inputMessage.trim()}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="22" y1="2" x2="11" y2="13"></line>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                  </svg>
                </button>
              </div>

              <div className="composer-selectors">
                <label className={`selector-chip ${sendMode === 'stream' ? 'active' : ''}`}>
                  <input type="radio" name="sendMode" value="stream" checked={sendMode === 'stream'} onChange={() => setSendMode('stream')} />
                  ⚡ Stream Responses
                </label>
                <label className={`selector-chip ${sendMode === 'sync' ? 'active' : ''}`}>
                  <input type="radio" name="sendMode" value="sync" checked={sendMode === 'sync'} onChange={() => setSendMode('sync')} />
                  💬 Standard Sync
                </label>
                <label className={`selector-chip ${sendMode === 'rag' ? 'active' : ''}`}>
                  <input type="radio" name="sendMode" value="rag" checked={sendMode === 'rag'} onChange={() => setSendMode('rag')} />
                  🔍 RAG Search
                </label>
                <label className={`selector-chip ${sendMode === 'agent' ? 'active' : ''}`}>
                  <input type="radio" name="sendMode" value="agent" checked={sendMode === 'agent'} onChange={() => setSendMode('agent')} />
                  🤖 Orchestrator Agent
                </label>
              </div>
            </form>
          </footer>
        )}
      </main>

      {/* Dynamic Slide-out drawer Panels */}
      {activeDrawer !== 'none' && (
        <aside className="drawer-panel backdrop-blur">
          <div className="drawer-header">
            <h4>
              {activeDrawer === 'memories' && '🧠 Memory Subsystem'}
              {activeDrawer === 'documents' && '📂 RAG Document Store'}
              {activeDrawer === 'settings' && '⚙️ LLM Gateways'}
            </h4>
            <button className="close-drawer-btn" onClick={() => setActiveDrawer('none')}>&times;</button>
          </div>

          <div className="drawer-content">
            {/* Memories Panel */}
            {activeDrawer === 'memories' && (
              <div className="drawer-inner">
                <form onSubmit={handleAddMemory} className="drawer-form">
                  <div className="form-group">
                    <label>Save facts, names, or preferences</label>
                    <textarea placeholder="Remember that the user works in TypeScript..." value={newMemoryText} onChange={(e) => setNewMemoryText(e.target.value)} required />
                  </div>
                  <div className="form-group">
                    <label>Importance (1 - 10)</label>
                    <input type="number" min="1" max="10" value={newMemoryImportance} onChange={(e) => setNewMemoryImportance(Number(e.target.value))} />
                  </div>
                  <button type="submit" className="gradient-btn">Store Fact</button>
                </form>

                {memoryError && <div className="alert error">{memoryError}</div>}

                <div className="drawer-list">
                  <h5>Saved Preferences ({memories.length})</h5>
                  {memories.length === 0 ? (
                    <div className="list-empty">No preferences stored.</div>
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
            )}

            {/* Documents Panel */}
            {activeDrawer === 'documents' && (
              <div className="drawer-inner">
                <div className="upload-box">
                  <label className="upload-label">
                    <input type="file" ref={fileInputRef} onChange={handleUploadDocument} disabled={isUploading} style={{ display: 'none' }} />
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                      <polyline points="17 8 12 3 7 8"></polyline>
                      <line x1="12" y1="3" x2="12" y2="15"></line>
                    </svg>
                    <span>{isUploading ? 'Uploading file chunks...' : 'Upload research file'}</span>
                  </label>
                </div>

                {documentError && <div className="alert error">{documentError}</div>}

                <div className="drawer-list">
                  <h5>Indexed Files ({documents.length})</h5>
                  {documents.length === 0 ? (
                    <div className="list-empty">No documents uploaded.</div>
                  ) : (
                    documents.map((d) => (
                      <div key={d.id} className="drawer-item">
                        <div className="item-text">📄 {d.name}</div>
                        <div className="item-meta">
                          <span>{(d.file_size ? d.file_size / 1024 : 0).toFixed(1)} KB</span>
                          <button className="del-item-btn" onClick={() => handleDeleteDocument(d.id)}>Delete</button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* Settings Panel */}
            {activeDrawer === 'settings' && (
              <div className="drawer-inner">
                <div className="form-group">
                  <label>Select active cognitive LLM slot</label>
                  <select value={modelSlot} onChange={(e) => setModelSlot(e.target.value as any)}>
                    <option value="fast">Fast Completion Engine</option>
                    <option value="general">General Conversational (OpenAI / Claude)</option>
                    <option value="reasoning">Deep Reasoning Engine</option>
                  </select>
                  <p className="field-note">Models are routed dynamically at the LLM Gateway layer based on backend environment variables configuration mapping.</p>
                </div>

                <div className="system-specs">
                  <h5>Observability Specifications</h5>
                  <ul>
                    <li>JWT Auth boundaries: Enforced</li>
                    <li>RAG Cosine Similarity: {`>= 0.50`}</li>
                    <li>Max Agent FSM Steps: 5 loops limit</li>
                    <li>Vector dimensions: 1536 (pgvector standard)</li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

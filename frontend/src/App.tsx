import React, { useState, useEffect, useRef } from 'react';
import * as api from './services/api.js';
import { VoiceStateMachine, VoiceState, cleanSpokenText } from './services/voiceStateMachine.js';
import { DesktopAudioPlayer, PlaybackState } from './services/desktopAudioPlayer.js';
import { AudioRecorderService } from './services/audioRecorder.js';
import { MicTestModal } from './components/MicTestModal.js';
import { PlanCard } from './components/PlanCard.js';
import { getServiceStatuses, restartService, ServiceStatus } from './services/tauriServices.js';
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
  const [sendMode] = useState<'stream' | 'sync' | 'rag' | 'agent'>('agent'); // Default to agent FSM orchestrator

  // UI State Model
  const [uiState, setUiState] = useState<UIState>('idle');
  const [activeTool, setActiveTool] = useState<string | null>(null);

  // Plan & Approval Gate State (Phase 4)
  const [activePlan, setActivePlan] = useState<api.ExecutionPlan | null>(null);
  const [activeTicket, setActiveTicket] = useState<api.ExecutionTicket | null>(null);
  const [planExecution, setPlanExecution] = useState<api.PlanExecutionResult | null>(null);
  const [isPlanLoading, setIsPlanLoading] = useState<boolean>(false);
  const activePlanRef = useRef<api.ExecutionPlan | null>(null);

  useEffect(() => {
    activePlanRef.current = activePlan;
  }, [activePlan]);

  // Continuous Voice Mode State Machine & Desktop Audio Player & Audio Recorder
  const [voiceState, setVoiceState] = useState<VoiceState>('IDLE');
  const [playbackState, setPlaybackState] = useState<PlaybackState>('STOPPED');
  const [isVoiceModeActive, setIsVoiceModeActive] = useState<boolean>(false);
  const [isAudioOutputEnabled, setIsAudioOutputEnabled] = useState<boolean>(true); // Voice spoken by default
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null);
  const voiceMachineRef = useRef<VoiceStateMachine | null>(null);
  const audioPlayerRef = useRef<DesktopAudioPlayer | null>(null);
  const audioRecorderRef = useRef<AudioRecorderService | null>(null);

  async function playAssistantSpeech(messageId: string, textToSpeak: string) {
    if (!token || !textToSpeak || !audioPlayerRef.current) return;
    try {
      setPlayingMessageId(messageId);
      await audioPlayerRef.current.ensureUnlocked();
      const cleaned = cleanSpokenText(textToSpeak);
      if (!cleaned) return;
      const audioBuffer = await api.synthesizeSpeech(token, cleaned);
      await audioPlayerRef.current.play(audioBuffer);
    } catch (err: any) {
      console.warn('[DesktopAudioPlayer] Playback failed:', err);
    } finally {
      setPlayingMessageId((curr) => (curr === messageId ? null : curr));
    }
  }

  function stopAssistantSpeech() {
    audioPlayerRef.current?.stop();
    setPlayingMessageId(null);
  }

  function toggleAudioOutput() {
    if (isAudioOutputEnabled) {
      stopAssistantSpeech();
      setIsAudioOutputEnabled(false);
    } else {
      audioPlayerRef.current?.ensureUnlocked().catch(() => {});
      setIsAudioOutputEnabled(true);
    }
  }

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
      fetchChatApi: async (convoId, txt) => {
        if (!token) return Promise.reject('No token');
        const trimmed = txt.trim();

        setUiState('thinking');
        try {
          // Unified orchestration: text and voice route through the exact same backend engine
          const res = await api.sendMessageAgent(token, convoId, trimmed);
          if (res.plan) {
            setActivePlan(res.plan);
            if (res.plan.status === 'completed' || res.plan.status === 'rejected') {
              setTimeout(() => {
                setActivePlan(null);
                setActiveTicket(null);
              }, 4000);
            }
          }
          if (res.execution) {
            setPlanExecution(res.execution);
          }
          const spokenText = res.speechText || cleanSpokenText(res.assistantMessage?.content) || '';
          return {
            userMessage: res.userMessage,
            assistantMessage: res.assistantMessage,
            speechText: res.speechText || spokenText,
            content: spokenText,
          };
        } finally {
          setUiState('idle');
        }
      },
      fetchTtsApi: (txt) => (token ? api.synthesizeSpeech(token, cleanSpokenText(txt)) : Promise.reject('No token')),
      playAudioApi: (buf) => player.play(buf),
      stopAudioApi: () => player.stop(),
    });
    voiceMachineRef.current = machine;

    return () => {
      recorder.stop();
      machine.stopVoiceMode();
      player.close();
    };
  }, [token]);

  async function toggleVoiceMode() {
    if (!token || !voiceMachineRef.current) return;

    // Immediately unlock Web Audio API in user gesture context
    await audioPlayerRef.current?.ensureUnlocked();

    console.log('[MIC_DIAGNOSTIC] toggleVoiceMode triggered:', {
      runtimeType: typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window ? 'tauri' : 'browser',
      isVoiceModeActive,
      permissionState: micPermissionStatus,
    });

    if (isVoiceModeActive) {
      setIsVoiceModeActive(false);
      audioRecorderRef.current?.stop();
      await voiceMachineRef.current.stopVoiceMode();
    } else {
      setChatError(null);
      let targetConvoId = activeConvoId;
      if (!targetConvoId && token) {
        try {
          const convo = await api.createConversation(token, 'General Chat');
          setConversations((prev) => [convo, ...prev]);
          setActiveConvoId(convo.id);
          targetConvoId = convo.id;
        } catch (err: any) {
          setChatError('Failed to initialize conversation: ' + err.message);
          return;
        }
      }
      if (!targetConvoId) {
        setChatError('Failed to initialize conversation for voice mode');
        return;
      }
      setIsVoiceModeActive(true);
      await voiceMachineRef.current.startVoiceMode(targetConvoId, token);
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

  // Unified Menu & Settings Modal
  const [showMenuModal, setShowMenuModal] = useState<boolean>(false);
  const [menuTab, setMenuTab] = useState<'chats' | 'documents' | 'memories' | 'system'>('chats');

  // Subsystems Data
  const [memories, setMemories] = useState<api.Memory[]>([]);
  const [newMemoryText, setNewMemoryText] = useState('');
  const [newMemoryImportance, setNewMemoryImportance] = useState(5);
  const [memoryError, setMemoryError] = useState<string | null>(null);

  const [documents, setDocuments] = useState<api.DocumentInfo[]>([]);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const [healthStatus, setHealthStatus] = useState<string>('Online');
  const [healthReport, setHealthReport] = useState<api.HealthResponse | null>(null);
  const [modelStatus, setModelStatus] = useState<'ready' | 'loading' | 'failed' | 'unknown'>('unknown');
  const [serviceStatuses, setServiceStatuses] = useState<ServiceStatus[]>([]);

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
  const [micModalError, setMicModalError] = useState<string | null>(null);
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
    setMicModalError(null);
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
        localStorage.setItem('gia_mic_permission', 'granted');
        setMicPermissionStatus('granted');
        setMicModalError(null);
        setShowMicModal(false);
        setChatError(null);
        return;
      } catch (err: any) {
        console.error('[MIC_DIAGNOSTIC] WebAudio getUserMedia permission error:', err);
        const isDenied = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError';
        const errorDetail = isDenied
          ? 'Microphone access was denied by macOS or the browser.\nTo enable it, open macOS System Settings > Privacy & Security > Microphone, ensure GIA is toggled ON, and then click Retry.'
          : `Failed to acquire microphone access: ${err?.message || String(err)}`;

        localStorage.setItem('gia_mic_permission', 'rejected');
        setMicPermissionStatus('rejected');
        setMicModalError(errorDetail);
        setChatError(errorDetail);
        // Keep modal open so the user sees the explanation and can retry or dismiss
        return;
      }
    }

    const unavailMsg = 'Microphone mediaDevices API not supported in this runtime environment.';
    localStorage.setItem('gia_mic_permission', 'rejected');
    setMicPermissionStatus('rejected');
    setMicModalError(unavailMsg);
    setChatError(unavailMsg);
  }

  function handleRejectMicPermission() {
    localStorage.setItem('gia_mic_permission', 'rejected');
    setMicPermissionStatus('rejected');
    setMicModalError(null);
    setShowMicModal(false);
  }

  // Health & Model Diagnostics Probe
  async function checkBackendHealth() {
    try {
      const data = await api.fetchHealthStatus();
      setHealthReport(data);
      setHealthStatus(data.status === 'healthy' ? 'Online' : 'Degraded');

      // Determine local model lifecycle state
      if (data.dependencies?.llm === 'healthy') {
        setModelStatus('ready');
      } else if (
        data.dependencies?.python_ai_service === 'degraded' ||
        data.dependencies?.llm === 'unconfigured'
      ) {
        setModelStatus('loading');
      } else {
        setModelStatus('failed');
      }
    } catch {
      setHealthStatus('Offline');
      setModelStatus('failed');
    }

    // Also check local Tauri service manager statuses if desktop
    try {
      const svcs = await getServiceStatuses();
      setServiceStatuses(svcs);
    } catch {
      // ignore
    }
  }

  // Periodic health polling (every 20 seconds)
  useEffect(() => {
    checkBackendHealth();
    const interval = setInterval(checkBackendHealth, 20000);
    return () => clearInterval(interval);
  }, []);

  // Load backend configurations
  async function loadConversations() {
    if (!token) return;
    setIsConversationsLoading(true);
    try {
      const list = await api.listConversations(token);
      setConversations(list);
      if (list.length > 0) {
        if (!activeConvoId || !list.some((c) => c.id === activeConvoId)) {
          selectConversation(list[0].id);
        }
      } else {
        const defaultConvo = await api.createConversation(token, 'General Chat');
        setConversations([defaultConvo]);
        selectConversation(defaultConvo.id);
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

  // Load active plan for current conversation
  async function loadActivePlan(convoId?: string) {
    const id = convoId || activeConvoId;
    if (!token || !id) return;
    try {
      const plan = await api.getActivePlan(token, id);
      setActivePlan(plan);
      if (plan && (plan.status === 'executing' || plan.status === 'completed' || plan.status === 'failed')) {
        const executions = await api.getPlanExecutions(token, id, plan.id);
        if (executions && executions.length > 0) {
          const latestExec = executions[0];
          const steps = await api.getStepExecutions(token, id, plan.id, latestExec.id);
          setPlanExecution({
            executionId: latestExec.id,
            planId: plan.id,
            planVersion: plan.version,
            userId: user?.id || '',
            status: latestExec.status,
            totalSteps: plan.steps.length,
            completedSteps: steps.filter((s: any) => s.status === 'completed').length,
            failedStepId: latestExec.failed_step_id,
            errorMessage: latestExec.error_message,
            stepRecords: steps.map((s: any) => ({
              stepId: s.step_id,
              action: s.action_name || s.action || `step_${s.step_id}`,
              toolName: s.action_name,
              toolArgs: s.tool_args || {},
              status: s.status,
              durationMs: s.duration_ms,
              error: s.error_message,
              result: s.result_payload,
              verification: {
                verified: s.verified ?? true,
                message: s.verification_details || '',
              },
            })),
            startedAt: latestExec.started_at,
            completedAt: latestExec.completed_at,
          });
        }
      } else if (!plan) {
        setActiveTicket(null);
        setPlanExecution(null);
      }
    } catch (err: any) {
      console.warn('Could not load active plan:', err);
    }
  }

  // Periodic polling when execution is running
  useEffect(() => {
    if (!token || !activeConvoId || !activePlan) return;
    if (activePlan.status === 'executing') {
      const interval = setInterval(() => {
        loadActivePlan(activeConvoId);
      }, 1200);
      return () => clearInterval(interval);
    }
  }, [token, activeConvoId, activePlan?.status]);

  // Plan Action Handlers
  async function handleApprovePlan(planId: string, version: number) {
    if (!token || !activeConvoId) return;
    setIsPlanLoading(true);
    setChatError(null);
    try {
      const res = await api.approvePlan(token, activeConvoId, planId, {
        planVersion: version,
        channel: 'web_ui',
        explicitConfirmation: true,
      });
      setActivePlan(res.plan);
      setActiveTicket(res.ticket);

      // Automatically execute approved plan once ticket is issued
      const ticketTok = res.ticket?.ticketToken || res.ticket?.ticketId || res.ticket?.ticket_token;
      if (ticketTok) {
        await handleExecutePlan(res.plan.id, res.plan.version, ticketTok);
      }
    } catch (err: any) {
      setChatError('Plan approval failed: ' + (err.message || err));
    } finally {
      setIsPlanLoading(false);
    }
  }

  async function handleExecutePlan(planId: string, version: number, ticketToken?: string) {
    if (!token || !activeConvoId) return;
    const tokenToUse = ticketToken || activeTicket?.ticketToken || activeTicket?.ticketId || activeTicket?.ticket_token;
    if (!tokenToUse) {
      setChatError('No valid approval ticket found. Plan must be approved first.');
      return;
    }
    setIsPlanLoading(true);
    setChatError(null);
    setUiState('executing');
    try {
      const res = await api.executePlan(token, activeConvoId, planId, tokenToUse, version);
      setPlanExecution(res.execution);
      const updatedPlan = await api.getActivePlan(token, activeConvoId);
      if (updatedPlan) {
        setActivePlan(updatedPlan);
      } else if (res.execution) {
        setActivePlan((prev) => prev ? { ...prev, status: res.execution.status as any } : null);
      }

      // Refresh messages
      const refreshed = await api.getMessages(token, activeConvoId);
      setMessages(refreshed);

      // Play completion audio if enabled
      if (isAudioOutputEnabled) {
        let completionText = '';
        if (res.execution?.status === 'completed') {
          completionText = `Done! I have executed and verified all steps for ${activePlan?.objective || 'the requested plan'}.`;
        } else if (res.execution?.status === 'failed') {
          completionText = `Execution failed: ${res.execution?.errorMessage || 'An error occurred during execution'}.`;
        }
        if (completionText) {
          playAssistantSpeech('exec-' + planId, completionText).catch(() => {});
        }
      }

      // Auto-remove plan after completed or failed execution
      if (res.execution?.status === 'completed' || res.execution?.status === 'failed') {
        setTimeout(() => {
          setActivePlan((curr) => (curr?.id === planId ? null : curr));
          setPlanExecution((curr) => (curr?.planId === planId ? null : curr));
          setActiveTicket(null);
        }, 2500);
      }
    } catch (err: any) {
      setChatError('Plan execution failed: ' + (err.message || err));
      await loadActivePlan(activeConvoId);
    } finally {
      setIsPlanLoading(false);
      setUiState('idle');
    }
  }

  async function handleRejectPlan(planId: string, reason?: string) {
    if (!token || !activeConvoId) return;
    setIsPlanLoading(true);
    setChatError(null);
    try {
      const res = await api.rejectPlan(token, activeConvoId, planId, reason || 'User rejected the execution plan');
      setActivePlan(res.plan);
      setActiveTicket(null);
      setPlanExecution(null);

      if (isAudioOutputEnabled) {
        playAssistantSpeech('reject-' + planId, 'Plan cancelled. No actions were performed.').catch(() => {});
      }

      // Auto-remove rejected plan after brief confirmation feedback
      setTimeout(() => {
        setActivePlan((curr) => (curr?.id === planId ? null : curr));
      }, 1500);
    } catch (err: any) {
      setChatError('Plan rejection failed: ' + (err.message || err));
    } finally {
      setIsPlanLoading(false);
    }
  }

  async function handleModifyPlan(planId: string, feedback: string) {
    if (!token || !activeConvoId) return;
    setIsPlanLoading(true);
    setChatError(null);
    try {
      const res = await api.modifyPlan(token, activeConvoId, planId, feedback);
      setActivePlan(res.plan);
      setActiveTicket(null);
      setPlanExecution(null);
    } catch (err: any) {
      setChatError('Plan modification failed: ' + (err.message || err));
    } finally {
      setIsPlanLoading(false);
    }
  }

  async function handleCancelPlan(planId: string) {
    if (!token || !activeConvoId) return;
    setIsPlanLoading(true);
    try {
      await api.cancelPlan(token, activeConvoId, planId);
      const updatedPlan = await api.getActivePlan(token, activeConvoId);
      setActivePlan(updatedPlan);
      setTimeout(() => {
        setActivePlan((curr) => (curr?.id === planId ? null : curr));
        setPlanExecution(null);
        setActiveTicket(null);
      }, 1500);
    } catch (err: any) {
      setChatError('Cancel failed: ' + (err.message || err));
    } finally {
      setIsPlanLoading(false);
    }
  }

  function handleDismissPlan() {
    setActivePlan(null);
    setPlanExecution(null);
    setActiveTicket(null);
  }

  async function selectConversation(id: string) {
    if (!token) return;
    setActiveConvoId(id);
    setActivePlan(null);
    setActiveTicket(null);
    setPlanExecution(null);
    setChatError(null);
    setShowMenuModal(false);
    try {
      const msgs = await api.getMessages(token, id);
      setMessages(msgs);
      await loadActivePlan(id);
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
    setActivePlan(null);
    setActiveTicket(null);
    setPlanExecution(null);
    setMessages([]);
    setUiState('idle');
  }

  // Conversation Operations
  async function handleCreateConvo() {
    if (!token) return;
    try {
      const title = `Chat ${conversations.length + 1}`;
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
    if (!token || !textToSend.trim()) return;

    let targetConvoId = activeConvoId;
    if (!targetConvoId) {
      try {
        const convo = await api.createConversation(token, 'General Chat');
        setConversations((prev) => [convo, ...prev]);
        setActiveConvoId(convo.id);
        targetConvoId = convo.id;
      } catch (err: any) {
        setChatError('Failed to initialize conversation: ' + err.message);
        return;
      }
    }

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

    const trimmed = textToSend.trim();

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
        targetConvoId,
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
          const refreshed = await api.getMessages(token, targetConvoId);
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
        const response = await api.sendMessageSync(token, targetConvoId, textToSend);
        setMessages((prev) => [...prev, response]);
        setUiState('idle');
        if (isAudioOutputEnabled && response.content) {
          playAssistantSpeech(response.id, cleanSpokenText(response.content)).catch(() => {});
        }
      } catch (err: any) {
        setChatError(err.message);
        setUiState('error');
      }
    } else if (sendMode === 'rag') {
      try {
        const res = await api.sendMessageRAG(token, targetConvoId, textToSend);
        const assistantMsg: MessageExt = {
          ...res.message,
          citations: res.citations,
        };
        setMessages((prev) => [...prev, assistantMsg]);
        setUiState('idle');
        if (isAudioOutputEnabled && res.message.content) {
          playAssistantSpeech(res.message.id, cleanSpokenText(res.message.content)).catch(() => {});
        }
      } catch (err: any) {
        setChatError(err.message);
        setUiState('error');
      }
    } else {
      // Default: Unified Conversation Orchestrator ('agent')
      // Enforces identical plan generation, missing-param resolution, permission validation, execution & verification
      const toolCheck = trimmed.toLowerCase();
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
        const res = await api.sendMessageAgent(token, targetConvoId, textToSend);
        clearTimeout(executionTimer);
        setActiveTool(null);
        if (res.plan) {
          setActivePlan(res.plan);
          if (res.execution) {
            setPlanExecution(res.execution);
          }
          if (['completed', 'failed', 'rejected', 'cancelled'].includes(res.plan.status)) {
            const planIdToClear = res.plan.id;
            setTimeout(() => {
              setActivePlan((curr) => (curr?.id === planIdToClear ? null : curr));
              setPlanExecution(null);
              setActiveTicket(null);
            }, 3000);
          }
        }
        const refreshed = await api.getMessages(token, targetConvoId);
        setMessages(refreshed);
        setUiState('idle');

        // Play spoken response if audio output is enabled
        const speechToPlay = res.speechText || cleanSpokenText(res.assistantMessage?.content);
        if (isAudioOutputEnabled && speechToPlay) {
          const targetMsgId = res.assistantMessage?.id || refreshed[refreshed.length - 1]?.id || 'msg-' + Date.now();
          playAssistantSpeech(targetMsgId, speechToPlay).catch((err) =>
            console.warn('[App] Spoken audio playback failed:', err)
          );
        }
      } catch (err: any) {
        clearTimeout(executionTimer);
        setActiveTool(null);
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
    // User gesture unlock for Web Audio API in macOS WebKit
    audioPlayerRef.current?.ensureUnlocked().catch(() => {});
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
                {uiState === 'idle' && (
                  modelStatus === 'loading'
                    ? 'Model Loading (Qwen 3.5)...'
                    : modelStatus === 'failed'
                    ? 'AI Engine Offline'
                    : 'Ready (Qwen 3.5 4B • Local)'
                )}
                {uiState === 'chatting' && 'Typing...'}
                {uiState === 'thinking' && 'Inference Active (Qwen 3.5 4B)...'}
                {uiState === 'executing' && `Running ${activeTool}...`}
                {uiState === 'error' && 'System Error'}
              </span>
            </div>
          </div>
        </div>

        <div className="header-actions">
          <button 
            className="new-chat-pill-btn" 
            onClick={handleCreateConvo}
            title="Start New Chat"
          >
            + New
          </button>
          
          <button 
            className={`icon-btn ${showMenuModal ? 'active' : ''}`} 
            onClick={() => setShowMenuModal(!showMenuModal)}
            title="Settings & Tools"
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

                    {/* Assistant Message Voice Playback Button */}
                    {m.role === 'assistant' && m.content && (
                      <div className="msg-actions-row">
                        <button
                          type="button"
                          className={`msg-speaker-btn ${playingMessageId === m.id ? 'playing' : ''}`}
                          onClick={() =>
                            playingMessageId === m.id
                              ? stopAssistantSpeech()
                              : playAssistantSpeech(m.id, m.content)
                          }
                          title={playingMessageId === m.id ? 'Stop voice playback' : 'Play voice response'}
                        >
                          {playingMessageId === m.id ? '⏹️ Stop' : '🔊 Listen'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}

            {/* PLAN CARD INTEGRATION (Phase 4) */}
            {activePlan && (
              <div className="active-plan-banner-wrapper">
                <PlanCard
                  plan={activePlan}
                  execution={planExecution}
                  isLoading={isPlanLoading}
                  onApprove={handleApprovePlan}
                  onReject={handleRejectPlan}
                  onModify={handleModifyPlan}
                  onCancel={handleCancelPlan}
                  onExecute={(planId, version) => handleExecutePlan(planId, version)}
                  onDismiss={handleDismissPlan}
                />
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        ) : (
          <div className="welcome-chat">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.6 }}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18a3.75 3.75 0 0 0 .495-7.467 5.99 5.99 0 0 0-1.925 3.546 5.974 5.974 0 0 1-2.133-1A3.75 3.75 0 0 0 12 18Z" />
            </svg>
            <h2>Welcome to GIA</h2>
            <p>Ready to assist. Ask anything below or start voice mode.</p>
            <button className="new-chat-pill-btn" style={{ marginTop: '14px', padding: '8px 20px', fontSize: '13px' }} onClick={handleCreateConvo}>
              + Start New Conversation
            </button>
          </div>
        )}
      </div>

      {/* DETECTED DYNAMIC STATE INTERFACE OVERLAYS */}
      
      {/* COMPOSER FOOTER BAR */}
      {(() => {
        const currentVoiceInteractionState: 'IDLE' | 'LISTENING' | 'PROCESSING' | 'THINKING' | 'AWAITING_APPROVAL' | 'EXECUTING' | 'SPEAKING' | 'ERROR' = (() => {
          if (chatError) return 'ERROR';
          if (!isVoiceModeActive) return 'IDLE';
          if (voiceState === 'PLAYING' || voiceState === 'SYNTHESIZING') return 'SPEAKING';
          if (uiState === 'executing' || (activePlan && activePlan.status === 'executing')) return 'EXECUTING';
          if (activePlan && (activePlan.status === 'awaiting_approval' || activePlan.status === 'pending')) return 'AWAITING_APPROVAL';
          if (uiState === 'thinking') return 'THINKING';
          if (voiceState === 'TRANSCRIBING' || voiceState === 'SPEECH_DETECTED') return 'PROCESSING';
          if (voiceState === 'PROCESSING') return 'THINKING';
          if (voiceState === 'LISTENING') return 'LISTENING';
          return 'IDLE';
        })();

        return (
          <footer className="composer-bar backdrop-blur">
            {/* Continuous Voice Mode Active State Banner */}
            {isVoiceModeActive && (
              <div className={`state-banner voice-banner voice-${currentVoiceInteractionState.toLowerCase()}`}>
                <div className="spinner" />
                <span>
                  <strong style={{ marginRight: '6px' }}>[{currentVoiceInteractionState}]</strong>
                  {currentVoiceInteractionState === 'IDLE' && 'Voice mode idle.'}
                  {currentVoiceInteractionState === 'LISTENING' && '🎙️ Listening... (Speak now in English, Hindi, or Hinglish)'}
                  {currentVoiceInteractionState === 'PROCESSING' && '⚡ Processing speech (Silero VAD & Whisper STT)...'}
                  {currentVoiceInteractionState === 'THINKING' && '🧠 Thinking & Orchestrating with Local Qwen LLM...'}
                  {currentVoiceInteractionState === 'AWAITING_APPROVAL' && '⏳ Execution Plan Formulated — Awaiting Approval (Say "Approve" or "Reject")'}
                  {currentVoiceInteractionState === 'EXECUTING' && '⚙️ Executing approved plan with PlanExecutionEngine...'}
                  {currentVoiceInteractionState === 'SPEAKING' && '🔊 GIA speaking via Kokoro TTS... 🔇 (Microphone muted)'}
                  {currentVoiceInteractionState === 'ERROR' && `⚠️ Error: ${chatError}`}
                </span>

                <div className="voice-controls-group">
                  {currentVoiceInteractionState === 'SPEAKING' && (
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
              <button className="dismiss-error-btn" onClick={() => { setChatError(null); setUiState('idle'); }}>&times;</button>
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
                className={`audio-output-toggle-btn ${isAudioOutputEnabled ? 'active' : ''}`}
                onClick={toggleAudioOutput}
                title={isAudioOutputEnabled ? "Voice responses enabled (click to mute)" : "Voice responses muted (click to enable)"}
              >
                {isAudioOutputEnabled ? '🔊 Voice' : '🔇 Mute'}
              </button>

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

          </form>
        </footer>
        );
      })()}

      {/* UNIFIED MENU & SETTINGS DRAWER (One Modal for Chats, Documents, Memories, and System) */}
      {showMenuModal && (
        <div className="drawer-panel backdrop-blur">
          <div className="drawer-header">
            <div className="modal-tabs">
              <button className={`modal-tab ${menuTab === 'chats' ? 'active' : ''}`} onClick={() => setMenuTab('chats')}>
                💬 Chats ({conversations.length})
              </button>
              <button className={`modal-tab ${menuTab === 'documents' ? 'active' : ''}`} onClick={() => setMenuTab('documents')}>
                📂 Docs ({documents.length})
              </button>
              <button className={`modal-tab ${menuTab === 'memories' ? 'active' : ''}`} onClick={() => setMenuTab('memories')}>
                🧠 Memories ({memories.length})
              </button>
              <button className={`modal-tab ${menuTab === 'system' ? 'active' : ''}`} onClick={() => setMenuTab('system')}>
                ⚙️ System
              </button>
            </div>
            <button className="close-drawer-btn" onClick={() => setShowMenuModal(false)}>&times;</button>
          </div>

          <div className="drawer-content">
            <div className="drawer-inner">
              {menuTab === 'chats' && (
                <div>
                  <button className="new-convo-btn" onClick={() => { handleCreateConvo(); setShowMenuModal(false); }}>
                    + Start New Chat
                  </button>
                  <div className="convo-list-scroll">
                    {isConversationsLoading ? (
                      <div className="empty-state">Loading chats...</div>
                    ) : conversations.length === 0 ? (
                      <div className="empty-state">No conversations yet.</div>
                    ) : (
                      conversations.map((c) => (
                        <div key={c.id} className={`convo-item ${activeConvoId === c.id ? 'active' : ''}`} onClick={() => { selectConversation(c.id); setShowMenuModal(false); }}>
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

              {menuTab === 'documents' && (
                <div>
                  <div className="upload-box">
                    <label className="upload-label">
                      <input type="file" ref={fileInputRef} onChange={handleUploadDocument} disabled={isUploading} style={{ display: 'none' }} />
                      <span>{isUploading ? 'Ingesting chunks...' : '📄 Click to upload document (PDF, TXT, MD)'}</span>
                    </label>
                  </div>
                  {documentError && <div className="alert error">{documentError}</div>}
                  <div className="drawer-list">
                    <h5>Indexed Documents ({documents.length})</h5>
                    {documents.length === 0 ? (
                      <div className="empty-state">No documents indexed. Upload files above to enable local RAG search.</div>
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
              )}

              {menuTab === 'memories' && (
                <div>
                  <form onSubmit={handleAddMemory} className="drawer-form">
                    <div className="form-group">
                      <label>Store user preferences & facts</label>
                      <textarea placeholder="e.g., The user prefers concise code examples..." value={newMemoryText} onChange={(e) => setNewMemoryText(e.target.value)} required />
                    </div>
                    <div className="form-group">
                      <label>Importance (1 - 10)</label>
                      <input type="number" min="1" max="10" value={newMemoryImportance} onChange={(e) => setNewMemoryImportance(Number(e.target.value))} />
                    </div>
                    <button type="submit" className="auth-submit-btn">Save Preference</button>
                  </form>
                  {memoryError && <div className="alert error">{memoryError}</div>}
                  <div className="drawer-list">
                    <h5>Stored Preferences ({memories.length})</h5>
                    {memories.length === 0 ? (
                      <div className="empty-state">No preferences stored yet.</div>
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

              {menuTab === 'system' && (
                <div>
                  <div className="system-specs">
                    <h5>Local AI Architecture & Diagnostics</h5>
                    <ul>
                      <li><span>Inference Engine</span> <span>Local Qwen 3.5 4B</span></li>
                      <li>
                        <span>Model State</span>
                        <span style={{ color: modelStatus === 'ready' ? 'var(--success-color)' : modelStatus === 'loading' ? '#f59e0b' : 'var(--error-color)', fontWeight: 600 }}>
                          {modelStatus === 'ready' ? 'Ready (Apple Silicon MPS)' : modelStatus === 'loading' ? 'Loading Weights...' : 'Offline'}
                        </span>
                      </li>
                      <li><span>Speech-to-Text</span> <span>Faster-Whisper Tiny (Local Int8)</span></li>
                      <li><span>Speech Synthesis</span> <span>macOS Native say (Samantha)</span></li>
                      <li><span>Vector Embeddings</span> <span>all-MiniLM-L6-v2 (384-dim)</span></li>
                      <li><span>Wake-Word Gate</span> <span style={{ color: 'var(--success-color)' }}>Active ("Hey GIA")</span></li>
                      {healthReport?.latency?.llm !== undefined && (
                        <li><span>LLM Latency</span> <span>{healthReport.latency.llm} ms</span></li>
                      )}
                      <li><span>Overall Health</span> <span style={{ color: healthStatus === 'Online' ? 'var(--success-color)' : 'var(--error-color)' }}>{healthStatus}</span></li>
                      <li><span>Mic Permission</span> <span style={{ textTransform: 'capitalize' }}>{micPermissionStatus}</span></li>
                    </ul>

                    {serviceStatuses.length > 0 && (
                      <div style={{ marginTop: '10px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        <div style={{ fontWeight: 600, marginBottom: '4px' }}>Local Services:</div>
                        {serviceStatuses.map((s) => (
                          <div key={s.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                            <span>{s.name} (:{s.port})</span>
                            <span style={{ color: s.status === 'running' ? 'var(--success-color)' : '#f59e0b' }}>
                              {s.status} {s.is_attached ? '(attached)' : s.pid ? `(pid ${s.pid})` : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                      <button
                        type="button"
                        className="btn-grant-access"
                        style={{ flex: 1, fontSize: '0.75rem', padding: '6px 10px' }}
                        onClick={checkBackendHealth}
                      >
                        🔄 Refresh Health
                      </button>
                      {healthStatus !== 'Online' && (
                        <button
                          type="button"
                          className="del-item-btn"
                          style={{ fontSize: '0.75rem', padding: '6px 10px' }}
                          onClick={async () => {
                            await restartService('python_ai_service');
                            setTimeout(checkBackendHealth, 1500);
                          }}
                        >
                          Restart AI Service
                        </button>
                      )}
                    </div>

                    <button
                      type="button"
                      className="btn-grant-access"
                      style={{ marginTop: '8px', width: '100%', fontSize: '0.75rem', padding: '8px 12px' }}
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
                    <button className="del-item-btn" onClick={handleLogout}>Log Out</button>
                  </div>
                </div>
              )}
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
            {micModalError && (
              <div
                style={{
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: '8px',
                  padding: '10px 12px',
                  marginBottom: '16px',
                  fontSize: '0.8rem',
                  color: '#f87171',
                  textAlign: 'left',
                  lineHeight: '1.4',
                  whiteSpace: 'pre-line',
                }}
              >
                ⚠️ {micModalError}
              </div>
            )}
            <div className="mic-modal-actions">
              <button type="button" className="btn-grant-access" onClick={handleGrantMicPermission}>
                {micModalError ? 'Retry' : 'Give Access'}
              </button>
              <button type="button" className="btn-reject-access" onClick={handleRejectMicPermission}>
                {micModalError ? 'Close' : 'Reject'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

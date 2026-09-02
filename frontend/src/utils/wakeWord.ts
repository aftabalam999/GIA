export interface WakeWordResult {
  activated: boolean;
  isAuthorized: boolean;
  isGreeting: boolean;
  command: string;
}

const GREETING_PATTERN = /^(?:hi|hello|hey|what's up|whats up|how are you|good morning|good afternoon|good evening)[\s,!.?]*$/i;
const AUTHORIZED_WAKE_PATTERN = /^(?:hey|hello|hi|ok|okay|yo)?\s*[,.:;!-]?\s*\bafiya\b\s*[,.:;!-]?\s*(.*)$/i;

/**
 * Isolated Wake-Word & Greeting Detector Utility for Afiya.
 * 
 * Strong Authorization Phrases (requires "Afiya"):
 * - "afiya"
 * - "hey afiya"
 * - "hello afiya"
 * - "hi afiya"
 * - "okay afiya"
 * - "ok afiya"
 * - "yo afiya"
 * 
 * Standalone Conversational Greetings (NO tool/command authorization):
 * - "hi", "hello", "hey", "what's up", "whats up", "how are you",
 *   "good morning", "good afternoon", "good evening"
 */
export function detectWakeWord(transcript: string): WakeWordResult {
  if (!transcript || typeof transcript !== 'string') {
    return { activated: false, isAuthorized: false, isGreeting: false, command: '' };
  }

  const trimmed = transcript.trim();
  if (!trimmed) {
    return { activated: false, isAuthorized: false, isGreeting: false, command: '' };
  }

  // 1. Check strong Afiya authorization pattern (requires "Afiya" wake word)
  const authMatch = trimmed.match(AUTHORIZED_WAKE_PATTERN);
  if (authMatch) {
    const rawCommand = authMatch[1] ? authMatch[1].trim() : '';
    const cleanedCommand = rawCommand.replace(/^[^\w]+/, '').trim();
    return {
      activated: true,
      isAuthorized: true,
      isGreeting: false,
      command: cleanedCommand,
    };
  }

  // 2. Check standalone conversational greeting (e.g. "Hi", "Hello", "What's up?")
  if (GREETING_PATTERN.test(trimmed)) {
    return {
      activated: true,
      isAuthorized: false,
      isGreeting: true,
      command: trimmed,
    };
  }

  // 3. Otherwise: not authorized and not a standalone greeting (e.g. "Open VS Code", "Hi, open VS Code")
  return {
    activated: false,
    isAuthorized: false,
    isGreeting: false,
    command: '',
  };
}

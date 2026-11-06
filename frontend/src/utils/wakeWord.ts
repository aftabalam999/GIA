export interface WakeWordResult {
  activated: boolean;
  isAuthorized: boolean;
  isWakeOnly: boolean;
  wakeWord: string;
  command: string;
}

const AUTHORIZED_WAKE_PATTERN =
  /^(?:hey|hello|hi|ok|okay|yo)?\s*[,.:;!-]?\s*\b(gia|afiya)\b\s*[,.:;!-]?\s*(?:please)?\s*[,.:;!-]?\s*(.*)$/i;

const EMBEDDED_WAKE_PATTERN =
  /\b(gia|afiya)\b\s*[,.:;!-]?\s*(?:please)?\s*[,.:;!-]?\s*(.*)$/i;

/**
 * Isolated Wake-Word & Authorization Detector for GIA desktop voice assistant.
 * 
 * Enforces requirement: GIA only executes commands after wake-word authorization.
 * 
 * Supported Wake-Words:
 * - "GIA", "Hey GIA", "Hello GIA", "Hi GIA", "OK GIA", "Okay GIA", "Yo GIA"
 * - "Afiya", "Hey Afiya" (backwards compatibility)
 */
export function detectWakeWord(transcript: string): WakeWordResult {
  if (!transcript || typeof transcript !== 'string') {
    return { activated: false, isAuthorized: false, isWakeOnly: false, wakeWord: '', command: '' };
  }

  const trimmed = transcript.trim();
  if (!trimmed) {
    return { activated: false, isAuthorized: false, isWakeOnly: false, wakeWord: '', command: '' };
  }

  let match = trimmed.match(AUTHORIZED_WAKE_PATTERN);
  let detectedWord = '';
  let rawCommand = '';

  if (match) {
    detectedWord = match[1].toUpperCase();
    rawCommand = match[2] ? match[2].trim() : '';
  } else {
    const embeddedMatch = trimmed.match(EMBEDDED_WAKE_PATTERN);
    if (embeddedMatch) {
      detectedWord = embeddedMatch[1].toUpperCase();
      rawCommand = embeddedMatch[2] ? embeddedMatch[2].trim() : '';
    }
  }

  if (!detectedWord) {
    return {
      activated: false,
      isAuthorized: false,
      isWakeOnly: false,
      wakeWord: '',
      command: '',
    };
  }

  const cleanedCommand = rawCommand.replace(/^[^\w]+/, '').trim();
  const isWakeOnly = cleanedCommand.length === 0;

  return {
    activated: true,
    isAuthorized: true,
    isWakeOnly,
    wakeWord: detectedWord,
    command: cleanedCommand,
  };
}


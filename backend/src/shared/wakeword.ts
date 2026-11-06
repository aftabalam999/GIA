export interface WakeWordResult {
  detected: boolean;
  isAuthorized: boolean;
  isWakeOnly: boolean;
  wakeWord: string | null;
  command: string | null;
}

/**
 * Isolated Wake-Word Authorization Detector for GIA.
 * 
 * Enforces strict wake-word requirement:
 * GIA only executes commands after wake-word authorization.
 * 
 * Supported Wake-Words:
 * - "GIA", "Hey GIA", "Hello GIA", "Hi GIA", "OK GIA", "Okay GIA", "Yo GIA"
 * - "Afiya", "Hey Afiya" (backwards compatibility)
 */
export class WakeWordDetector {
  private static readonly WAKE_WORD_PATTERN =
    /^(?:hey|hello|hi|ok|okay|yo)?\s*[,.:;!-]?\s*\b(gia|afiya)\b\s*[,.:;!-]?\s*(?:please)?\s*[,.:;!-]?\s*(.*)$/i;

  private static readonly EMBEDDED_WAKE_PATTERN =
    /\b(gia|afiya)\b\s*[,.:;!-]?\s*(?:please)?\s*[,.:;!-]?\s*(.*)$/i;

  /**
   * Evaluates text for the GIA wake word.
   * If detected, returns authorization state and the extracted command.
   */
  static detect(input: string): WakeWordResult {
    if (!input || typeof input !== 'string' || !input.trim()) {
      return {
        detected: false,
        isAuthorized: false,
        isWakeOnly: false,
        wakeWord: null,
        command: null,
      };
    }

    const trimmed = input.trim();

    // 1. Check primary prefix-based wake word pattern (e.g. "Hey GIA, open VS Code", "GIA what time is it?")
    let match = trimmed.match(this.WAKE_WORD_PATTERN);
    let wakeWordFound: string | null = null;
    let rawCommand = '';

    if (match) {
      wakeWordFound = match[1].toUpperCase();
      rawCommand = match[2] ? match[2].trim() : '';
    } else {
      // 2. Check embedded wake word (e.g. "Please GIA open Chrome")
      const embeddedMatch = trimmed.match(this.EMBEDDED_WAKE_PATTERN);
      if (embeddedMatch) {
        wakeWordFound = embeddedMatch[1].toUpperCase();
        rawCommand = embeddedMatch[2] ? embeddedMatch[2].trim() : '';
      }
    }

    if (!wakeWordFound) {
      return {
        detected: false,
        isAuthorized: false,
        isWakeOnly: false,
        wakeWord: null,
        command: null,
      };
    }

    // Clean leading punctuation from command
    const cleanedCommand = rawCommand.replace(/^[^\w]+/, '').trim();
    const isWakeOnly = cleanedCommand.length === 0;

    return {
      detected: true,
      isAuthorized: true,
      isWakeOnly,
      wakeWord: wakeWordFound,
      command: isWakeOnly ? null : cleanedCommand,
    };
  }
}
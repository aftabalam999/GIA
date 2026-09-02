export interface WakeWordResult {
  detected: boolean;
  confidence: number;
  command: string | null;
}

export class WakeWordDetector {
  /**
   * Evaluates text for the Afiya wake word.
   * If detected, returns the confidence score and the extracted command.
   */
  static detect(input: string): WakeWordResult {
    if (!input || !input.trim()) {
      return { detected: false, confidence: 0.0, command: null };
    }

    const trimmed = input.trim();

    // Word boundary checks to avoid partial matches (e.g. "afiyat", "plagiarize")
    // Captures optional greetings, punctuation delimiters, and politeness tokens
    const wakeWordPattern = /^(?:hey|hello|hi|ok|okay|yo)?\s*[,.:;!-]?\s*\bafiya\b\s*[,.:;!-]?\s*(?:please)?\s*[,.:;!-]?\s*(.*)$/i;

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

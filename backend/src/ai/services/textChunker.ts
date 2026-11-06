export interface TextChunkerOptions {
  minChunkLength?: number; // Minimum length (default: 15) for clause-based flushing
  maxChunkLength?: number; // Maximum length (default: 100) before forced word boundary flush
}

/**
 * SpeechTextChunker converts incremental token streams into natural, speech-sized chunks
 * optimized for Text-to-Speech (TTS) audio synthesis.
 */
export class SpeechTextChunker {
  private buffer: string = '';
  private minChunkLength: number;
  private maxChunkLength: number;
  private isCancelled: boolean = false;

  constructor(options: TextChunkerOptions = {}) {
    this.minChunkLength = options.minChunkLength ?? 15;
    this.maxChunkLength = options.maxChunkLength ?? 100;
  }

  /**
   * Appends an incoming raw token to the internal buffer and returns any ready speech chunks.
   */
  public push(token: string): string[] {
    if (this.isCancelled || !token) return [];

    this.buffer += token;
    return this.extractChunks(false);
  }

  /**
   * Flushes any remaining buffered text upon stream completion and returns final speech chunks.
   */
  public flush(): string[] {
    if (this.isCancelled) return [];
    return this.extractChunks(true);
  }

  /**
   * Halts active chunking, invalidates state, and clears internal buffer.
   */
  public cancel(): void {
    this.isCancelled = true;
    this.buffer = '';
  }

  /**
   * Processes buffered text and extracts speakable sentence or clause chunks.
   */
  private extractChunks(isFinal: boolean): string[] {
    const chunks: string[] = [];

    while (this.buffer.length > 0) {
      if (this.isCancelled) break;

      const trimmedBuffer = this.buffer.trimStart();
      if (!trimmedBuffer) {
        this.buffer = '';
        break;
      }

      // 1. Look for sentence-ending punctuation (. ! ? ; \n)
      const sentenceMatch = /^([^.!?;\n]+[.!?;\n]+)(\s+|$)/s.exec(trimmedBuffer);

      if (sentenceMatch) {
        const candidate = sentenceMatch[1].trim();
        const matchedLength = sentenceMatch[0].length;

        if (candidate.length > 0) {
          chunks.push(candidate);
          this.buffer = trimmedBuffer.slice(matchedLength);
          continue;
        }
      }

      // 2. Look for clause punctuation (, : -) if buffer length >= minChunkLength
      if (trimmedBuffer.length >= this.minChunkLength) {
        const clauseRegex = /([,:-])(\s+)/g;
        let match: RegExpExecArray | null;
        let clauseFound = false;

        while ((match = clauseRegex.exec(trimmedBuffer)) !== null) {
          const endIdx = match.index + 1;
          const candidate = trimmedBuffer.slice(0, endIdx).trim();
          if (candidate.length >= this.minChunkLength) {
            chunks.push(candidate);
            this.buffer = trimmedBuffer.slice(match.index + match[0].length);
            clauseFound = true;
            break;
          }
        }

        if (clauseFound) {
          continue;
        }
      }

      // 3. Forced word boundary flush if buffer exceeds maxChunkLength
      if (trimmedBuffer.length >= this.maxChunkLength) {
        const slice = trimmedBuffer.slice(0, this.maxChunkLength);
        const lastSpaceIdx = slice.lastIndexOf(' ');
        if (lastSpaceIdx > 10) {
          const candidate = slice.slice(0, lastSpaceIdx).trim();
          chunks.push(candidate);
          this.buffer = trimmedBuffer.slice(lastSpaceIdx).trimStart();
          continue;
        }
      }

      // 4. Stream final flush: emit remaining buffer as final chunk
      if (isFinal) {
        const candidate = trimmedBuffer.trim();
        if (candidate.length > 0) {
          chunks.push(candidate);
        }
        this.buffer = '';
        break;
      }

      // Not enough content to form a confident speech chunk yet
      break;
    }

    return chunks;
  }
}

export interface TextChunkerOptions {
  minChunkLength?: number;
  maxChunkLength?: number;
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

  public push(token: string): string[] {
    if (this.isCancelled || !token) return [];

    this.buffer += token;
    return this.extractChunks(false);
  }

  public flush(): string[] {
    if (this.isCancelled) return [];
    return this.extractChunks(true);
  }

  public cancel(): void {
    this.isCancelled = true;
    this.buffer = '';
  }

  private extractChunks(isFinal: boolean): string[] {
    const chunks: string[] = [];

    while (this.buffer.length > 0) {
      if (this.isCancelled) break;

      const trimmedBuffer = this.buffer.trimStart();
      if (!trimmedBuffer) {
        this.buffer = '';
        break;
      }

      // 1. Sentence-ending punctuation (. ! ? ; \n)
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

      // 2. Clause punctuation (, : -) if buffer length >= minChunkLength
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

      break;
    }

    return chunks;
  }
}

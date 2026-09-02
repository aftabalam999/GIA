export interface VoiceLatencyTimestamps {
  micSpeechStart?: number;
  micSpeechEnd?: number;
  sttFinalTranscript?: number;
  geminiRequestStart?: number;
  firstGeminiTextChunk?: number;
  firstSpeechReadyChunk?: number;
  firstTtsRequest?: number;
  firstTtsAudioReceived?: number;
  firstAudioPlayback?: number;
  completeResponsePlayback?: number;
}

export class VoiceLatencyTracker {
  private timestamps: VoiceLatencyTimestamps = {};
  private active = false;

  public startUtterance(time = Date.now()): void {
    this.timestamps = {
      micSpeechStart: time,
    };
    this.active = true;
  }

  public record(event: keyof VoiceLatencyTimestamps, time = Date.now()): void {
    if (!this.active) return;
    if (event === 'micSpeechStart') {
      this.timestamps.micSpeechStart = time;
      return;
    }
    if (this.timestamps[event] === undefined) {
      this.timestamps[event] = time;
    }
  }

  public finishAndReport(): void {
    if (!this.active) return;
    this.timestamps.completeResponsePlayback = this.timestamps.completeResponsePlayback || Date.now();
    this.active = false;

    const t = this.timestamps;
    const speechEndToStt = t.sttFinalTranscript && t.micSpeechEnd ? Math.max(0, t.sttFinalTranscript - t.micSpeechEnd) : 0;
    const sttToGeminiFirstToken = t.firstGeminiTextChunk && t.sttFinalTranscript ? Math.max(0, t.firstGeminiTextChunk - t.sttFinalTranscript) : 0;
    const geminiFirstTokenToSpeechChunk = t.firstSpeechReadyChunk && t.firstGeminiTextChunk ? Math.max(0, t.firstSpeechReadyChunk - t.firstGeminiTextChunk) : 0;
    const speechChunkToFirstAudio = t.firstAudioPlayback && t.firstSpeechReadyChunk ? Math.max(0, t.firstAudioPlayback - t.firstSpeechReadyChunk) : 0;
    const speechEndToFirstAudio = t.firstAudioPlayback && t.micSpeechEnd ? Math.max(0, t.firstAudioPlayback - t.micSpeechEnd) : 0;
    const totalResponseLatency = t.completeResponsePlayback && t.micSpeechStart ? Math.max(0, t.completeResponsePlayback - t.micSpeechStart) : 0;

    const report = `
📊 ================= AFIYA VOICE PIPELINE LATENCY REPORT =================
⏱️  1. Microphone Speech Start    : ${t.micSpeechStart ? t.micSpeechStart + 'ms' : 'N/A'}
⏱️  2. Microphone Speech End      : ${t.micSpeechEnd ? t.micSpeechEnd + 'ms' : 'N/A'}
⏱️  3. STT Final Transcript       : ${t.sttFinalTranscript ? t.sttFinalTranscript + 'ms' : 'N/A'}
⏱️  4. Gemini Request Start       : ${t.geminiRequestStart ? t.geminiRequestStart + 'ms' : 'N/A'}
⏱️  5. First Gemini Text Chunk    : ${t.firstGeminiTextChunk ? t.firstGeminiTextChunk + 'ms' : 'N/A'}
⏱️  6. First Speech-Ready Chunk   : ${t.firstSpeechReadyChunk ? t.firstSpeechReadyChunk + 'ms' : 'N/A'}
⏱️  7. First TTS Request          : ${t.firstTtsRequest ? t.firstTtsRequest + 'ms' : 'N/A'}
⏱️  8. First TTS Audio Received   : ${t.firstTtsAudioReceived ? t.firstTtsAudioReceived + 'ms' : 'N/A'}
⏱️  9. First Audio Playback       : ${t.firstAudioPlayback ? t.firstAudioPlayback + 'ms' : 'N/A'}
⏱️ 10. Complete Response Playback : ${t.completeResponsePlayback ? t.completeResponsePlayback + 'ms' : 'N/A'}

📈 --- DERIVED LATENCY METRICS ---
⚡ speech-end → STT-final              : ${speechEndToStt} ms
⚡ STT-final → Gemini-first-token       : ${sttToGeminiFirstToken} ms
⚡ Gemini-first-token → first-speech    : ${geminiFirstTokenToSpeechChunk} ms
⚡ first-speech-chunk → first-audio     : ${speechChunkToFirstAudio} ms
🚀 speech-end → first-Afiya-audio (TTFA): ${speechEndToFirstAudio} ms
🏁 total response latency               : ${totalResponseLatency} ms
========================================================================`;

    if (typeof process === 'undefined' || process.env.NODE_ENV !== 'production') {
      console.log(report);
    }
  }
}

export const voiceLatencyTracker = new VoiceLatencyTracker();

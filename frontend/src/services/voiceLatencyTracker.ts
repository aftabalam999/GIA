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

/**
 * VoiceLatencyTracker records high-resolution pipeline timestamps T0..T7 and derived interval metrics.
 * Outputs clean structured logs with elapsed milliseconds relative to speech-end (+Xms).
 */
export class VoiceLatencyTracker {
  private timestamps: VoiceLatencyTimestamps = {};
  private active = false;

  public startUtterance(time = Date.now()): void {
    this.timestamps = {
      micSpeechStart: time,
    };
    this.active = true;
    console.log('[VOICE] speech-start');
  }

  public record(event: keyof VoiceLatencyTimestamps, time = Date.now()): void {
    if (!this.active) return;
    if (event === 'micSpeechStart') {
      this.timestamps.micSpeechStart = time;
      console.log('[VOICE] speech-start');
      return;
    }
    if (this.timestamps[event] === undefined) {
      this.timestamps[event] = time;

      const ref = this.timestamps.micSpeechEnd || this.timestamps.micSpeechStart || time;
      const elapsed = Math.max(0, time - ref);

      if (event === 'micSpeechEnd') console.log(`[VOICE] speech-end       +0ms`);
      else if (event === 'sttFinalTranscript') console.log(`[VOICE] turn-finalized   +${elapsed}ms`);
      else if (event === 'geminiRequestStart') console.log(`[VOICE] gemini-input-sent +${elapsed}ms`);
      else if (event === 'firstGeminiTextChunk') console.log(`[VOICE] first-text-chunk +${elapsed}ms`);
      else if (event === 'firstSpeechReadyChunk') console.log(`[VOICE] first-speech-chunk +${elapsed}ms`);
      else if (event === 'firstTtsAudioReceived') console.log(`[VOICE] first-audio-chunk +${elapsed}ms`);
      else if (event === 'firstAudioPlayback') console.log(`[VOICE] playback-start   +${elapsed}ms`);
      else if (event === 'completeResponsePlayback') console.log(`[VOICE] playback-end     +${elapsed}ms`);
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
⏱️  T0. Microphone Speech Start    : ${t.micSpeechStart ? t.micSpeechStart + 'ms' : 'N/A'}
⏱️  T1. Microphone Speech End      : ${t.micSpeechEnd ? t.micSpeechEnd + 'ms' : 'N/A'}
⏱️  T2. Turn Finalized (STT)       : ${t.sttFinalTranscript ? t.sttFinalTranscript + 'ms' : 'N/A'}
⏱️  T3. Gemini Request Sent       : ${t.geminiRequestStart ? t.geminiRequestStart + 'ms' : 'N/A'}
⏱️  T4. First Gemini Text Chunk    : ${t.firstGeminiTextChunk ? t.firstGeminiTextChunk + 'ms' : 'N/A'}
⏱️  T5. First Speech-Ready Chunk   : ${t.firstSpeechReadyChunk ? t.firstSpeechReadyChunk + 'ms' : 'N/A'}
⏱️  T6. First Audio Playback       : ${t.firstAudioPlayback ? t.firstAudioPlayback + 'ms' : 'N/A'}
⏱️  T7. Complete Response Playback : ${t.completeResponsePlayback ? t.completeResponsePlayback + 'ms' : 'N/A'}

📈 --- DERIVED INTERVAL METRICS ---
⚡ Turn Finalization Latency (T2 - T1)     : ${speechEndToStt} ms
⚡ Gemini First-Response Latency (T4 - T3) : ${sttToGeminiFirstToken} ms
⚡ Speech Chunking Latency                 : ${geminiFirstTokenToSpeechChunk} ms
⚡ Audio Playback Startup Latency (T6 - T5): ${speechChunkToFirstAudio} ms
🚀 Perceived Latency (TTFA = T6 - T1)      : ${speechEndToFirstAudio} ms
🏁 Total Turn Duration                     : ${totalResponseLatency} ms
========================================================================`;

    if (typeof process === 'undefined' || process.env.NODE_ENV !== 'production') {
      console.log(report);
    }
  }
}

export const voiceLatencyTracker = new VoiceLatencyTracker();

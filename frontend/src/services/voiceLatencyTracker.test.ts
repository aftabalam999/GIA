import { describe, it, expect, vi } from 'vitest';
import { VoiceLatencyTracker } from './voiceLatencyTracker.js';

describe('VoiceLatencyTracker Unit Test Suite', () => {
  it('should record all 10 pipeline timestamps and compute derived latency metrics cleanly', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tracker = new VoiceLatencyTracker();

    const baseTime = 10000;
    tracker.startUtterance();

    tracker.record('micSpeechStart', baseTime);
    tracker.record('micSpeechEnd', baseTime + 1200);
    tracker.record('sttFinalTranscript', baseTime + 1500);
    tracker.record('geminiRequestStart', baseTime + 1510);
    tracker.record('firstGeminiTextChunk', baseTime + 1750);
    tracker.record('firstSpeechReadyChunk', baseTime + 1760);
    tracker.record('firstTtsRequest', baseTime + 1765);
    tracker.record('firstTtsAudioReceived', baseTime + 2100);
    tracker.record('firstAudioPlayback', baseTime + 2110);
    tracker.record('completeResponsePlayback', baseTime + 4500);

    tracker.finishAndReport();

    expect(consoleSpy).toHaveBeenCalled();
    const logOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');

    expect(logOutput).toContain('AFIYA VOICE PIPELINE LATENCY REPORT');
    expect(logOutput).toContain('Turn Finalization Latency (T2 - T1)     : 300 ms');
    expect(logOutput).toContain('Gemini First-Response Latency (T4 - T3) : 250 ms');
    expect(logOutput).toContain('Speech Chunking Latency                 : 10 ms');
    expect(logOutput).toContain('Audio Playback Startup Latency (T6 - T5): 350 ms');
    expect(logOutput).toContain('Perceived Latency (TTFA = T6 - T1)      : 910 ms');
    expect(logOutput).toContain('Total Turn Duration                     : 4500 ms');

    consoleSpy.mockRestore();
  });
});

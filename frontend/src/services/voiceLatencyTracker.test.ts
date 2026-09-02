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
    const logOutput = consoleSpy.mock.calls[0][0];

    expect(logOutput).toContain('AFIYA VOICE PIPELINE LATENCY REPORT');
    expect(logOutput).toContain('speech-end → STT-final              : 300 ms');
    expect(logOutput).toContain('STT-final → Gemini-first-token       : 250 ms');
    expect(logOutput).toContain('Gemini-first-token → first-speech    : 10 ms');
    expect(logOutput).toContain('first-speech-chunk → first-audio     : 350 ms');
    expect(logOutput).toContain('speech-end → first-Afiya-audio (TTFA): 910 ms');
    expect(logOutput).toContain('total response latency               : 4500 ms');

    consoleSpy.mockRestore();
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { LocalVAD } from './localVad.js';

describe('LocalVAD Unit Test Suite', () => {
  let vad: LocalVAD;
  let speechStartFired: number;
  let speechEndFired: number;
  let speechEndDuration: number;

  beforeEach(() => {
    speechStartFired = 0;
    speechEndFired = 0;
    speechEndDuration = 0;

    vad = new LocalVAD(
      {
        speechThreshold: 0.015,
        minSpeechDurationMs: 100,
        silenceDurationMs: 1000,
      },
      {
        onSpeechStart: () => {
          speechStartFired++;
        },
        onSpeechEnd: (dur) => {
          speechEndFired++;
          speechEndDuration = dur;
        },
      }
    );
  });

  it('Test 1 — Silence: continuous silence frames produce no speechStart', () => {
    vad.start();
    const t0 = 1000;
    vad.processAudioFrame(0.001, 50, t0);
    vad.processAudioFrame(0.002, 50, t0 + 50);
    vad.processAudioFrame(0.005, 50, t0 + 100);

    expect(speechStartFired).toBe(0);
    expect(vad.isSpeaking).toBe(false);
  });

  it('Test 2 — Speech: sustained speech energy above threshold produces speechStart', () => {
    vad.start();
    let t = 1000;
    vad.processAudioFrame(0.05, 50, t); // 50ms speech < minSpeechDuration (100ms)
    expect(speechStartFired).toBe(0);

    t += 50;
    vad.processAudioFrame(0.08, 50, t); // 100ms continuous speech >= 100ms threshold
    expect(speechStartFired).toBe(1);
    expect(vad.isSpeaking).toBe(true);
  });

  it('Test 3 — Continuous speech: continuous speech frames produce only ONE speechStart', () => {
    vad.start();
    let t = 1000;
    vad.processAudioFrame(0.05, 50, t);
    vad.processAudioFrame(0.05, 50, t + 50);
    vad.processAudioFrame(0.05, 50, t + 100);
    vad.processAudioFrame(0.05, 50, t + 150);

    expect(speechStartFired).toBe(1);
    expect(vad.isSpeaking).toBe(true);
  });

  it('Test 4 — Short pause: short silence below hangover threshold does NOT trigger speechEnd', () => {
    vad.start();
    let t = 1000;
    vad.processAudioFrame(0.05, 50, t);
    vad.processAudioFrame(0.05, 50, t + 50); // speechStart fired at t=1050

    // Short silence pause of 300ms (< 1000ms silenceDurationMs)
    vad.processAudioFrame(0.001, 300, t + 350);

    expect(speechEndFired).toBe(0);
    expect(vad.isSpeaking).toBe(true);

    // Resumes speech
    vad.processAudioFrame(0.05, 50, t + 400);
    expect(speechEndFired).toBe(0);
    expect(vad.isSpeaking).toBe(true);
  });

  it('Test 5 — Actual end: silence exceeding hangover duration produces speechEnd', () => {
    vad.start();
    let t = 1000;
    vad.processAudioFrame(0.05, 50, t);
    vad.processAudioFrame(0.05, 50, t + 50); // speechStart at 1050

    // Silence for 1100ms (> 1000ms hangover)
    vad.processAudioFrame(0.001, 1100, t + 1150);

    expect(speechEndFired).toBe(1);
    expect(vad.isSpeaking).toBe(false);
    expect(speechEndDuration).toBeGreaterThan(0);
  });

  it('Test 6 — Reset: reset() restores VAD to initial inactive state', () => {
    vad.start();
    vad.processAudioFrame(0.05, 50, 1000);
    vad.processAudioFrame(0.05, 50, 1050);
    expect(vad.isSpeaking).toBe(true);

    vad.reset();

    expect(vad.isSpeaking).toBe(false);
  });

  it('Test 7 — Voice Mode OFF: VAD does not process frames or fire speech events when stopped/inactive', () => {
    // vad.start() NOT called (Voice Mode OFF)
    vad.processAudioFrame(0.08, 50, 1000);
    vad.processAudioFrame(0.08, 50, 1050);

    expect(speechStartFired).toBe(0);
    expect(vad.isSpeaking).toBe(false);
  });
});

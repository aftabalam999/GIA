/**
  * Deterministically converts Float32 audio samples (-1.0 to +1.0)
  * into 16-bit signed little-endian PCM bytes (Int16, -32768 to +32767).
  */
export function convertFloat32ToInt16LE(float32Array: Float32Array): Uint8Array {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1.0, Math.min(1.0, float32Array[i]));
    const val = s < 0 ? Math.floor(s * 32768) : Math.floor(s * 32767);
    view.setInt16(i * 2, val, true); // true = little-endian
  }

  return new Uint8Array(buffer);
}

/**
 * Resamples a Float32Array from inputRate to targetRate using linear interpolation.
 */
export function resampleFloat32(
  input: Float32Array,
  inputRate: number,
  targetRate: number = 16000
): Float32Array {
  if (inputRate === targetRate || input.length === 0) {
    return new Float32Array(input);
  }

  const ratio = inputRate / targetRate;
  const outputLength = Math.round(input.length / ratio);
  const result = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const origIndex = i * ratio;
    const index1 = Math.floor(origIndex);
    const index2 = Math.min(index1 + 1, input.length - 1);
    const interpolation = origIndex - index1;

    result[i] = input[index1] * (1 - interpolation) + input[index2] * interpolation;
  }

  return result;
}

export type AudioChunkCallback = (chunk: Uint8Array) => void;

/**
 * Inline AudioWorklet code string for low-latency PCM processing off the main UI thread.
 */
const WORKLET_PROCESSOR_CODE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 2048;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0]) {
      const channelData = input[0];
      for (let i = 0; i < channelData.length; i++) {
        this.buffer[this.bufferIndex++] = channelData[i];
        if (this.bufferIndex >= this.bufferSize) {
          const slice = this.buffer.slice(0, this.bufferSize);
          this.port.postMessage(slice.buffer, [slice.buffer]);
          this.bufferIndex = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
`;

export class LiveAudioCapture {
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private mediaStreamSource: MediaStreamAudioSourceNode | null = null;
  private capturing: boolean = false;
  private onChunkCallback: AudioChunkCallback | null = null;

  public get isCapturing(): boolean {
    return this.capturing;
  }

  public async start(onAudioChunk: AudioChunkCallback): Promise<void> {
    if (this.capturing) return;
    this.onChunkCallback = onAudioChunk;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.mediaStream = stream;

      const AudioContextClass =
        window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioContextClass({ sampleRate: 16000 });

      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      // Add inline AudioWorklet module
      const blob = new Blob([WORKLET_PROCESSOR_CODE], {
        type: 'application/javascript',
      });
      const workletUrl = URL.createObjectURL(blob);
      await this.audioContext.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      this.mediaStreamSource =
        this.audioContext.createMediaStreamSource(stream);
      this.workletNode = new AudioWorkletNode(
        this.audioContext,
        'pcm-capture-processor'
      );

      const nativeSampleRate = this.audioContext.sampleRate;
      const track = stream.getAudioTracks()[0];
      const trackSettings = track?.getSettings ? track.getSettings() : {};

      if (process.env.NODE_ENV !== 'production') {
        console.log('[MICROPHONE_DIAGNOSTIC]', {
          deviceSampleRate: trackSettings.sampleRate || nativeSampleRate,
          audioContextSampleRate: nativeSampleRate,
          channelCount: trackSettings.channelCount || 1,
          audioContextState: this.audioContext.state,
          mediaStreamActive: stream.active,
          trackReadyState: track?.readyState,
          workletInitialized: true,
        });
      }

      let lastDiagReportTime = Date.now();
      let framesReceivedAcc = 0;
      let pcmSamplesAcc = 0;
      let pcmBytesAcc = 0;
      let rmsSumAcc = 0;
      let peakRmsAcc = 0;

      this.workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (!this.capturing || !this.onChunkCallback) return;

        const float32Data = new Float32Array(event.data);
        framesReceivedAcc += float32Data.length;

        // Calculate RMS metrics
        let sumSquares = 0;
        for (let i = 0; i < float32Data.length; i++) {
          const sample = float32Data[i];
          sumSquares += sample * sample;
        }
        const currentRms = Math.sqrt(sumSquares / float32Data.length);
        rmsSumAcc += currentRms;
        if (currentRms > peakRmsAcc) peakRmsAcc = currentRms;

        const resampled = resampleFloat32(float32Data, nativeSampleRate, 16000);
        const int16LEBytes = convertFloat32ToInt16LE(resampled);

        pcmSamplesAcc += resampled.length;
        pcmBytesAcc += int16LEBytes.length;

        const now = Date.now();
        if (now - lastDiagReportTime >= 1000) {
          const avgRms = framesReceivedAcc > 0 ? rmsSumAcc / (framesReceivedAcc / 2048) : 0;
          if (process.env.NODE_ENV !== 'production') {
            console.log('[AUDIO DIAGNOSTICS]', {
              inputSampleRate: 16000,
              audioContextSampleRate: nativeSampleRate,
              channels: 1,
              framesReceived: framesReceivedAcc,
              pcmSamplesProduced: pcmSamplesAcc,
              pcmBytesProduced: pcmBytesAcc,
              averageRms: Number(avgRms.toFixed(4)),
              peakRms: Number(peakRmsAcc.toFixed(4)),
            });
          }
          lastDiagReportTime = now;
          framesReceivedAcc = 0;
          pcmSamplesAcc = 0;
          pcmBytesAcc = 0;
          rmsSumAcc = 0;
          peakRmsAcc = 0;
        }

        if (int16LEBytes.length > 0) {
          this.onChunkCallback(int16LEBytes);
        }
      };

      this.mediaStreamSource.connect(this.workletNode);
      this.capturing = true;
    } catch (err: unknown) {
      this.stop();
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to start live audio capture: ${errMsg}`);
    }
  }

  public stop(): void {
    this.capturing = false;
    this.onChunkCallback = null;

    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {
        // ignore
      }
      this.workletNode = null;
    }

    if (this.mediaStreamSource) {
      try {
        this.mediaStreamSource.disconnect();
      } catch {
        // ignore
      }
      this.mediaStreamSource = null;
    }

    if (this.mediaStream) {
      try {
        this.mediaStream.getTracks().forEach((track) => track.stop());
      } catch {
        // ignore
      }
      this.mediaStream = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        this.audioContext.close();
      } catch {
        // ignore
      }
      this.audioContext = null;
    }
  }
}

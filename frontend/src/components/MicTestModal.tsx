import { useState, useEffect } from 'react';
import {
  NativeMicState,
  MicPermissionResponse,
  MicCaptureTestResult,
  checkNativeMicrophonePermission,
  requestNativeMicrophonePermission,
  startNativeMicrophoneTestCapture,
  stopNativeMicrophoneTestCapture,
} from '../services/tauriMicrophone.js';

interface MicTestModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function MicTestModal({ isOpen, onClose }: MicTestModalProps) {
  const [micState, setMicState] = useState<NativeMicState>('UNKNOWN');
  const [deviceInfo, setDeviceInfo] = useState<string>('Detecting hardware...');
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<MicCaptureTestResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      handleCheckPermission();
    }
  }, [isOpen]);

  async function handleCheckPermission() {
    setMicState('CHECKING');
    setErrorMsg(null);
    const res: MicPermissionResponse = await checkNativeMicrophonePermission();

    if (res.status === 'GRANTED') {
      setMicState('GRANTED');
      setDeviceInfo(res.device_name || 'System Microphone Available');
    } else if (res.status === 'UNAVAILABLE') {
      setMicState('AVAILABLE');
      setDeviceInfo(res.message);
    } else if (res.status === 'DENIED') {
      setMicState('DENIED');
      setErrorMsg(res.message);
    } else {
      setMicState('ERROR');
      setErrorMsg(res.message);
    }
  }

  async function handleRequestPermission() {
    setMicState('REQUESTING');
    setErrorMsg(null);
    const res: MicPermissionResponse = await requestNativeMicrophonePermission();

    if (res.status === 'GRANTED') {
      setMicState('GRANTED');
      setDeviceInfo(res.device_name || 'System Microphone Acquired');
    } else if (res.status === 'DENIED') {
      setMicState('DENIED');
      setErrorMsg(res.message);
    } else {
      setMicState('ERROR');
      setErrorMsg(res.message);
    }
  }

  async function handleRunTestCapture() {
    if (isCapturing) return;

    setIsCapturing(true);
    setErrorMsg(null);
    setTestResult(null);

    try {
      const result = await startNativeMicrophoneTestCapture(5);
      setIsCapturing(false);

      if (result.success) {
        setTestResult(result);
        setMicState('GRANTED');
      } else {
        setErrorMsg(result.error || 'Test capture failed');
        setMicState('ERROR');
      }
    } catch (err: any) {
      setIsCapturing(false);
      setErrorMsg(err.message || 'Capture test execution error');
      setMicState('ERROR');
    }
  }

  async function handleStopTestCapture() {
    await stopNativeMicrophoneTestCapture();
    setIsCapturing(false);
  }

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="mic-modal-card backdrop-blur" style={{ maxWidth: '440px' }}>
        <div className="mic-icon-wrapper" style={{ fontSize: '32px' }}>
          🎙️
        </div>
        <h3>Tauri Native Microphone Boundary Test</h3>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>
          Tests hardware microphone acquisition and raw PCM audio frame capture directly in Tauri/Rust.
        </p>

        {/* State Badge */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            background: 'rgba(255, 255, 255, 0.04)',
            border: '1px solid var(--glass-border)',
            borderRadius: '20px',
            padding: '6px 14px',
            marginBottom: '16px',
            fontSize: '0.75rem',
            fontWeight: 600,
          }}
        >
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background:
                micState === 'GRANTED'
                  ? 'var(--success-color)'
                  : micState === 'DENIED' || micState === 'ERROR'
                  ? 'var(--error-color)'
                  : 'var(--warning-color)',
            }}
          />
          Microphone State: <span style={{ color: '#fff' }}>{micState}</span>
        </div>

        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>
          {deviceInfo}
        </div>

        {errorMsg && (
          <div
            style={{
              background: 'rgba(244, 63, 94, 0.1)',
              border: '1px solid rgba(244, 63, 94, 0.3)',
              borderRadius: '8px',
              padding: '8px 12px',
              fontSize: '0.75rem',
              color: '#fecdd3',
              marginBottom: '16px',
            }}
          >
            {errorMsg}
          </div>
        )}

        {/* Capture Progress */}
        {isCapturing && (
          <div style={{ marginBottom: '16px' }}>
            <div className="spinner" style={{ margin: '0 auto 8px auto' }} />
            <div style={{ fontSize: '0.8rem', color: '#a5f3fc', fontWeight: 500 }}>
              Capturing 5 seconds of native PCM audio frames...
            </div>
          </div>
        )}

        {/* Results Panel */}
        {testResult && (
          <div
            style={{
              background: 'rgba(16, 185, 129, 0.08)',
              border: '1px solid rgba(16, 185, 129, 0.25)',
              borderRadius: '12px',
              padding: '12px',
              textAlign: 'left',
              marginBottom: '16px',
              fontSize: '0.75rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <div style={{ color: '#6ee7b7', fontWeight: 600, fontSize: '0.8rem' }}>
              ✓ Native Capture Verified!
            </div>
            <div>
              <strong>PCM Samples Captured:</strong> {testResult.samples_captured.toLocaleString()}
            </div>
            <div>
              <strong>Duration:</strong> {testResult.duration_seconds.toFixed(2)} seconds
            </div>
            <div>
              <strong>Audio Format:</strong> {testResult.sample_rate} Hz, {testResult.channels} channel(s)
            </div>
            <div>
              <strong>Max Peak Amplitude:</strong> {testResult.max_amplitude.toFixed(4)}
            </div>
            <div>
              <strong>RMS Volume Level:</strong> {testResult.rms_volume.toFixed(4)}
            </div>
            <div style={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.7rem' }}>
              <strong>Saved WAV File:</strong> {testResult.wav_file_path}
            </div>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
          {micState !== 'GRANTED' && (
            <button
              type="button"
              className="btn-grant-access"
              onClick={handleRequestPermission}
              disabled={isCapturing}
            >
              Acquire Desktop Microphone
            </button>
          )}

          <button
            type="button"
            className="btn-grant-access"
            onClick={handleRunTestCapture}
            disabled={isCapturing}
            style={{
              background: isCapturing ? 'rgba(255,255,255,0.05)' : 'var(--accent-glow)',
            }}
          >
            {isCapturing ? 'Capturing Audio...' : 'Run 5s Native Capture Test'}
          </button>

          {isCapturing && (
            <button type="button" className="btn-reject-access" onClick={handleStopTestCapture}>
              Cancel Capture
            </button>
          )}

          <button type="button" className="btn-reject-access" onClick={onClose} disabled={isCapturing}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

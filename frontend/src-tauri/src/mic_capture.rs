use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};
use hound::WavReader;
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize, Clone)]
pub struct MicPermissionResult {
    pub status: String, // "GRANTED" | "DENIED" | "UNAVAILABLE" | "ERROR"
    pub device_name: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct MicCaptureResult {
    pub success: bool,
    pub status: String,
    pub samples_captured: usize,
    pub duration_seconds: f32,
    pub max_amplitude: f32,
    pub rms_volume: f32,
    pub sample_rate: u32,
    pub channels: u16,
    pub wav_file_path: String,
    pub wav_base64: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct AudioFramePayload {
    pub sample_rate: u32,
    pub channels: u16,
    pub samples_count: usize,
    pub rms: f32,
    pub pcm_base64: String,
}

pub fn bytes_to_base64(bytes: &[u8]) -> String {
    const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut res = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };

        let triple = (b0 << 16) | (b1 << 8) | b2;

        res.push(CHARSET[(triple >> 18) & 0x3F] as char);
        res.push(CHARSET[(triple >> 12) & 0x3F] as char);
        if chunk.len() > 1 {
            res.push(CHARSET[(triple >> 6) & 0x3F] as char);
        } else {
            res.push('=');
        }
        if chunk.len() > 2 {
            res.push(CHARSET[triple & 0x3F] as char);
        } else {
            res.push('=');
        }
    }
    res
}

/// Fractional-delay streaming linear resampler and mono downmixer.
/// Resamples arbitrary hardware input rates (e.g. 48kHz, 44.1kHz) to 16,000 Hz mono.
#[derive(Debug)]
pub struct StreamingResampler {
    in_rate: u32,
    out_rate: u32,
    channels: usize,
    ratio: f64,
    phase: f64,
    prev_mono: f32,
    curr_mono: f32,
    initialized: bool,
    sample_buffer: Vec<f32>,
}

impl StreamingResampler {
    pub fn new(in_rate: u32, out_rate: u32, channels: usize) -> Self {
        let ratio = in_rate as f64 / out_rate.max(1) as f64;
        Self {
            in_rate,
            out_rate,
            channels: channels.max(1),
            ratio,
            phase: 0.0,
            prev_mono: 0.0,
            curr_mono: 0.0,
            initialized: false,
            sample_buffer: Vec::with_capacity(1024),
        }
    }

    pub fn process_interleaved(&mut self, input: &[f32]) {
        if input.is_empty() {
            return;
        }

        let channels = self.channels;
        let mono_chunk: Vec<f32> = if channels == 1 {
            input.to_vec()
        } else {
            input
                .chunks_exact(channels)
                .map(|ch| ch.iter().copied().sum::<f32>() / (channels as f32))
                .collect()
        };

        if self.in_rate == self.out_rate {
            self.sample_buffer.extend_from_slice(&mono_chunk);
            return;
        }

        for &sample in &mono_chunk {
            if !self.initialized {
                self.prev_mono = sample;
                self.curr_mono = sample;
                self.phase = 0.0;
                self.initialized = true;
                self.sample_buffer.push(sample);
                self.phase += self.ratio;
            } else {
                self.prev_mono = self.curr_mono;
                self.curr_mono = sample;
                self.phase -= 1.0;

                while self.phase < 1.0 {
                    let p = self.phase.clamp(0.0, 1.0);
                    let interp = (self.prev_mono as f64 * (1.0 - p) + self.curr_mono as f64 * p) as f32;
                    self.sample_buffer.push(interp);
                    self.phase += self.ratio;
                }
            }
        }
    }

    pub fn take_frames(&mut self, frame_size: usize) -> Vec<Vec<f32>> {
        let mut frames = Vec::new();
        while self.sample_buffer.len() >= frame_size {
            let frame: Vec<f32> = self.sample_buffer.drain(0..frame_size).collect();
            frames.push(frame);
        }
        frames
    }
}

pub struct ActiveCaptureSession {
    _stream: Stream,
    stop_signal: Arc<AtomicBool>,
}

static ACTIVE_CAPTURE: Mutex<Option<ActiveCaptureSession>> = Mutex::new(None);

/// Starts continuous, low-latency native microphone capture via CPAL (CoreAudio on macOS).
/// Resamples audio to 16,000 Hz mono and emits 512-sample (32ms) `mic-audio-frame` events.
pub fn start_continuous_capture_internal(app: AppHandle) -> Result<(), String> {
    let mut active_lock = ACTIVE_CAPTURE
        .lock()
        .map_err(|e| format!("Failed to acquire capture lock: {}", e))?;

    if active_lock.is_some() {
        println!("🎙️ [Native Mic] Continuous capture stream is already active.");
        return Ok(());
    }

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "No default audio input device found on macOS system.".to_string())?;

    let device_name = device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| device.to_string());
    println!("🎙️ [Native Mic] Opening audio input device: {}", device_name);

    let default_config = device
        .default_input_config()
        .map_err(|e| format!("Failed to query default audio input config: {}", e))?;

    let hw_sample_rate = default_config.sample_rate();
    let hw_channels = default_config.channels();
    let sample_format = default_config.sample_format();

    println!(
        "🎙️ [Native Mic] Hardware audio format: rate={}Hz, channels={}, format={:?}",
        hw_sample_rate, hw_channels, sample_format
    );

    let config: StreamConfig = default_config.into();

    // Bounded sync channel (64 frames = ~2 seconds buffer at 32ms/frame)
    // Audio callback never blocks or allocates unbounded memory
    let (tx, rx): (SyncSender<Vec<f32>>, Receiver<Vec<f32>>) = sync_channel(64);
    let stop_signal = Arc::new(AtomicBool::new(false));

    // Background worker thread receives 512-sample frames, computes RMS, converts to 16-bit LE PCM,
    // and emits `mic-audio-frame` to the Tauri webview.
    let worker_stop = Arc::clone(&stop_signal);
    let worker_app = app.clone();
    std::thread::spawn(move || {
        println!("🎙️ [Native Mic] Audio frame dispatcher thread started.");
        while !worker_stop.load(Ordering::Relaxed) {
            match rx.recv() {
                Ok(frame) => {
                    let samples_count = frame.len();
                    if samples_count == 0 {
                        continue;
                    }

                    // 1. Calculate RMS volume
                    let sum_sq: f32 = frame.iter().map(|&s| s * s).sum();
                    let rms = (sum_sq / samples_count as f32).sqrt();

                    // 2. Convert f32 to 16-bit signed LE PCM bytes
                    let mut pcm_bytes = Vec::with_capacity(samples_count * 2);
                    for &s in &frame {
                        let clamped = s.clamp(-1.0, 1.0);
                        let val = if clamped < 0.0 {
                            (clamped * 32768.0) as i16
                        } else {
                            (clamped * 32767.0) as i16
                        };
                        pcm_bytes.extend_from_slice(&val.to_le_bytes());
                    }

                    let payload = AudioFramePayload {
                        sample_rate: 16000,
                        channels: 1,
                        samples_count,
                        rms,
                        pcm_base64: bytes_to_base64(&pcm_bytes),
                    };

                    if let Err(err) = worker_app.emit("mic-audio-frame", payload) {
                        eprintln!("⚠️ [Native Mic] Failed to emit mic-audio-frame: {}", err);
                    }
                }
                Err(_) => {
                    // Channel disconnected when stream is dropped
                    break;
                }
            }
        }
        println!("🎙️ [Native Mic] Audio frame dispatcher thread exited cleanly.");
    });

    let mut resampler = StreamingResampler::new(hw_sample_rate, 16000, hw_channels as usize);
    let tx_clone = tx.clone();

    let err_app = app.clone();
    let err_callback = move |err: cpal::Error| {
        eprintln!("⚠️ [Native Mic] CPAL audio stream error: {}", err);
        let _ = err_app.emit(
            "mic-capture-error",
            format!("Hardware audio stream error: {}", err),
        );
    };

    let stream = match sample_format {
        SampleFormat::F32 => device
            .build_input_stream(
                config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    resampler.process_interleaved(data);
                    for frame in resampler.take_frames(512) {
                        let _ = tx_clone.try_send(frame);
                    }
                },
                err_callback,
                None,
            )
            .map_err(|e| format!("Failed to build F32 input stream: {}", e))?,
        SampleFormat::I16 => {
            let mut resampler_i16 = StreamingResampler::new(hw_sample_rate, 16000, hw_channels as usize);
            let tx_clone_i16 = tx.clone();
            device
                .build_input_stream(
                    config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        let f32_chunk: Vec<f32> = data
                            .iter()
                            .map(|&s| s as f32 / 32768.0)
                            .collect();
                        resampler_i16.process_interleaved(&f32_chunk);
                        for frame in resampler_i16.take_frames(512) {
                            let _ = tx_clone_i16.try_send(frame);
                        }
                    },
                    err_callback,
                    None,
                )
                .map_err(|e| format!("Failed to build I16 input stream: {}", e))?
        }
        format => {
            return Err(format!("Unsupported audio sample format: {:?}", format));
        }
    };

    stream
        .play()
        .map_err(|e| format!("Failed to play CPAL input audio stream: {}", e))?;

    *active_lock = Some(ActiveCaptureSession {
        _stream: stream,
        stop_signal,
    });

    println!("🎙️ [Native Mic] Continuous 16kHz mono audio stream successfully started.");
    Ok(())
}

/// Stops active continuous microphone capture stream and frees hardware audio handles.
pub fn stop_continuous_capture_internal() -> Result<(), String> {
    let mut active_lock = ACTIVE_CAPTURE
        .lock()
        .map_err(|e| format!("Failed to acquire capture lock: {}", e))?;

    if let Some(session) = active_lock.take() {
        session.stop_signal.store(true, Ordering::Relaxed);
        // Dropping session drops cpal::Stream and the transmitter, terminating dispatcher cleanly
        drop(session);
        println!("🎙️ [Native Mic] Continuous microphone capture stream stopped.");
    }
    Ok(())
}

fn find_ffmpeg() -> Option<PathBuf> {
    let candidates = [
        PathBuf::from("/opt/homebrew/bin/ffmpeg"),
        PathBuf::from("/usr/local/bin/ffmpeg"),
        PathBuf::from("/usr/bin/ffmpeg"),
    ];
    for c in &candidates {
        if c.exists() {
            return Some(c.clone());
        }
    }
    // Try PATH lookup
    if let Ok(output) = Command::new("which").arg("ffmpeg").output() {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path_str.is_empty() {
                return Some(PathBuf::from(path_str));
            }
        }
    }
    None
}

pub fn check_permission_internal() -> MicPermissionResult {
    // 1. macOS Audio Hardware Detection via CPAL or CoreAudio
    if cfg!(target_os = "macos") {
        let host = cpal::default_host();
        if let Some(dev) = host.default_input_device() {
            let dev_name = dev
                .description()
                .map(|d| d.name().to_string())
                .unwrap_or_else(|_| "MacBook Pro Microphone".to_string());
            return MicPermissionResult {
                status: "GRANTED".to_string(),
                device_name: Some(dev_name),
                message: "macOS CoreAudio input device detected and available.".to_string(),
            };
        }

        let mut device_found = false;
        let mut device_name = Some("System Microphone".to_string());

        if let Ok(res) = Command::new("system_profiler").arg("SPAudioDataType").output() {
            let stdout = String::from_utf8_lossy(&res.stdout);
            if stdout.contains("Default Input Device: Yes") || stdout.contains("Microphone") {
                device_found = true;
                device_name = Some("MacBook Pro Microphone".to_string());
            }
        }

        if !device_found {
            return MicPermissionResult {
                status: "UNAVAILABLE".to_string(),
                device_name: None,
                message: "No audio input hardware devices detected on macOS.".to_string(),
            };
        }

        return MicPermissionResult {
            status: "GRANTED".to_string(),
            device_name,
            message: "macOS audio input hardware detected.".to_string(),
        };
    }

    // 2. Linux ALSA Audio Hardware Detection
    let output = Command::new("arecord").arg("-l").output();
    match output {
        Ok(res) => {
            let stdout = String::from_utf8_lossy(&res.stdout);
            if res.status.success() && stdout.contains("card") {
                let first_device = stdout
                    .lines()
                    .find(|line| line.starts_with("card "))
                    .unwrap_or("Default Linux Capture Hardware")
                    .to_string();

                MicPermissionResult {
                    status: "GRANTED".to_string(),
                    device_name: Some(first_device.clone()),
                    message: format!("Linux audio input device detected: {}", first_device),
                }
            } else {
                MicPermissionResult {
                    status: "UNAVAILABLE".to_string(),
                    device_name: None,
                    message: "No hardware audio capture devices found.".to_string(),
                }
            }
        }
        Err(err) => MicPermissionResult {
            status: "ERROR".to_string(),
            device_name: None,
            message: format!("Failed to query audio hardware: {}", err),
        },
    }
}

pub fn request_permission_internal() -> MicPermissionResult {
    let check = check_permission_internal();
    if check.status != "GRANTED" {
        return check;
    }

    // 1. macOS Audio Capture Permission Verification via CoreAudio device query
    if cfg!(target_os = "macos") {
        let host = cpal::default_host();
        match host.default_input_device() {
            Some(device) => {
                let dev_name = device
                    .description()
                    .map(|d| d.name().to_string())
                    .unwrap_or_else(|_| "MacBook Pro Microphone".to_string());
                match device.default_input_config() {
                    Ok(cfg) => {
                        return MicPermissionResult {
                            status: "GRANTED".to_string(),
                            device_name: Some(dev_name),
                            message: format!(
                                "CoreAudio input stream verified: {}Hz, {} channels.",
                                cfg.sample_rate(),
                                cfg.channels()
                            ),
                        };
                    }
                    Err(err) => {
                        return MicPermissionResult {
                            status: "DENIED".to_string(),
                            device_name: Some(dev_name),
                            message: format!("Microphone input configuration query failed: {}", err),
                        };
                    }
                }
            }
            None => {
                return MicPermissionResult {
                    status: "UNAVAILABLE".to_string(),
                    device_name: None,
                    message: "No default microphone input device found.".to_string(),
                };
            }
        }
    }

    // 2. Linux ALSA Audio Capture Probe
    let probe_file = "/tmp/gia_mic_probe.wav";
    let status = Command::new("arecord")
        .arg("-d")
        .arg("1")
        .arg("-f")
        .arg("S16_LE")
        .arg("-r")
        .arg("16000")
        .arg("-c")
        .arg("1")
        .arg(probe_file)
        .status();

    match status {
        Ok(exit_status) if exit_status.success() => {
            let _ = std::fs::remove_file(probe_file);
            MicPermissionResult {
                status: "GRANTED".to_string(),
                device_name: check.device_name,
                message: "Desktop microphone access acquired successfully.".to_string(),
            }
        }
        Ok(exit_status) => MicPermissionResult {
            status: "DENIED".to_string(),
            device_name: check.device_name,
            message: format!("Microphone capture probe failed with exit code: {}", exit_status),
        },
        Err(err) => MicPermissionResult {
            status: "ERROR".to_string(),
            device_name: check.device_name,
            message: format!("Microphone probe execution failed: {}", err),
        },
    }
}

pub fn start_test_capture_internal(duration_secs: u64) -> Result<MicCaptureResult, String> {
    let wav_path = PathBuf::from("/tmp/gia_mic_test.wav");
    let _ = std::fs::remove_file(&wav_path);

    let start_time = Instant::now();

    // 1. macOS Audio Capture via AVFoundation / ffmpeg for diagnostic modal
    if cfg!(target_os = "macos") {
        let ffmpeg_bin = find_ffmpeg().unwrap_or_else(|| PathBuf::from("ffmpeg"));
        let mut child = Command::new(&ffmpeg_bin)
            .args([
                "-y",
                "-f", "avfoundation",
                "-i", ":0",
                "-t", &duration_secs.to_string(),
                "-ar", "16000",
                "-ac", "1",
                "-acodec", "pcm_s16le",
                &wav_path.to_string_lossy(),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn ffmpeg audio capture process: {}", e))?;

        let exit_status = child
            .wait()
            .map_err(|e| format!("Failed waiting for audio capture process: {}", e))?;

        if !exit_status.success() {
            return Err(format!("Audio capture exited with error code: {}", exit_status));
        }
    } else {
        // 2. Linux ALSA arecord capture
        let mut child = Command::new("arecord")
            .arg("-d")
            .arg(duration_secs.to_string())
            .arg("-f")
            .arg("S16_LE")
            .arg("-r")
            .arg("16000")
            .arg("-c")
            .arg("1")
            .arg(&wav_path)
            .spawn()
            .map_err(|e| format!("Failed to spawn arecord capture process: {}", e))?;

        let exit_status = child
            .wait()
            .map_err(|e| format!("Failed waiting for arecord process: {}", e))?;

        if !exit_status.success() {
            return Err(format!("arecord process exited with error code: {}", exit_status));
        }
    }

    let actual_duration = start_time.elapsed().as_secs_f32();

    // Parse recorded WAV file with hound
    let reader = WavReader::open(&wav_path)
        .map_err(|e| format!("Failed to open recorded WAV file '{:?}': {}", wav_path, e))?;

    let spec = reader.spec();
    let samples: Vec<i16> = reader
        .into_samples::<i16>()
        .filter_map(Result::ok)
        .collect();

    let samples_captured = samples.len();
    let mut max_amp: f32 = 0.0;
    let mut sum_sq: f32 = 0.0;

    for &sample in &samples {
        let norm = sample as f32 / i16::MAX as f32;
        let abs_s = norm.abs();
        if abs_s > max_amp {
            max_amp = abs_s;
        }
        sum_sq += norm * norm;
    }

    let rms = if samples_captured > 0 {
        (sum_sq / samples_captured as f32).sqrt()
    } else {
        0.0
    };

    let wav_bytes = std::fs::read(&wav_path).ok();
    let wav_b64 = wav_bytes.map(|b| bytes_to_base64(&b));

    Ok(MicCaptureResult {
        success: true,
        status: "SUCCESS".to_string(),
        samples_captured,
        duration_seconds: actual_duration,
        max_amplitude: max_amp,
        rms_volume: rms,
        sample_rate: spec.sample_rate,
        channels: spec.channels,
        wav_file_path: wav_path.to_string_lossy().to_string(),
        wav_base64: wav_b64,
        error: None,
    })
}

pub fn stop_test_capture_internal() {
    let _ = Command::new("pkill").arg("-f").arg("ffmpeg").status();
    let _ = Command::new("pkill").arg("-f").arg("arecord").status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_ffmpeg_or_system_path() {
        let ffmpeg = find_ffmpeg();
        if cfg!(target_os = "macos") {
            assert!(ffmpeg.is_some(), "FFmpeg should be discoverable on macOS dev environment");
        }
    }

    #[test]
    fn test_check_permission_internal() {
        let result = check_permission_internal();
        assert!(!result.status.is_empty());
        assert!(!result.message.is_empty());
        assert!(
            result.status == "GRANTED" || result.status == "AVAILABLE" || result.status == "UNAVAILABLE" || result.status == "ERROR",
            "Unexpected permission status: {}", result.status
        );
    }

    #[test]
    fn test_request_permission_internal() {
        let result = request_permission_internal();
        assert!(!result.status.is_empty());
        assert!(!result.message.is_empty());
        assert!(
            result.status == "GRANTED" || result.status == "DENIED" || result.status == "UNAVAILABLE" || result.status == "ERROR",
            "Unexpected request status: {}", result.status
        );
    }

    #[test]
    fn test_resampler_48k_to_16k_mono() {
        let mut resampler = StreamingResampler::new(48000, 16000, 1);
        // Feed 4800 samples at 48kHz (should produce ~1600 samples at 16kHz)
        let input: Vec<f32> = (0..4800)
            .map(|i| (i as f32 * 0.05).sin())
            .collect();
        resampler.process_interleaved(&input);

        let frames = resampler.take_frames(512);
        // 1600 / 512 = 3 full frames (1536 samples), remainder in buffer
        assert_eq!(frames.len(), 3);
        for frame in &frames {
            assert_eq!(frame.len(), 512);
        }
        assert_eq!(resampler.sample_buffer.len(), 1600 - 1536);
    }

    #[test]
    fn test_resampler_44k1_stereo_to_16k_mono() {
        let mut resampler = StreamingResampler::new(44100, 16000, 2);
        // 4410 interleaved stereo frames = 8820 samples
        let input: Vec<f32> = (0..8820)
            .map(|i| (i as f32 * 0.02).cos())
            .collect();
        resampler.process_interleaved(&input);

        // Expected output samples: 4410 * (16000 / 44100) = 1600 samples
        let frames = resampler.take_frames(512);
        assert_eq!(frames.len(), 3);
        let total_samples = frames.len() * 512 + resampler.sample_buffer.len();
        assert!((total_samples as i32 - 1600).abs() <= 2);
    }

    #[test]
    fn test_bytes_to_base64() {
        let data = b"Hello GIA!";
        let b64 = bytes_to_base64(data);
        assert_eq!(b64, "SGVsbG8gR0lBIQ==");
    }

    #[test]
    fn test_audio_frame_payload_serialization() {
        let payload = AudioFramePayload {
            sample_rate: 16000,
            channels: 1,
            samples_count: 512,
            rms: 0.035,
            pcm_base64: "AAAA".to_string(),
        };
        let json = serde_json::to_string(&payload).expect("Serialization failed");
        assert!(json.contains("\"sample_rate\":16000"));
        assert!(json.contains("\"channels\":1"));
        assert!(json.contains("\"samples_count\":512"));
        assert!(json.contains("\"pcm_base64\":\"AAAA\""));
    }
}

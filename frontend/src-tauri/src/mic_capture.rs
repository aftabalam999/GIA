use hound::WavReader;
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Instant;

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

fn bytes_to_base64(bytes: &[u8]) -> String {
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
    // 1. macOS Audio Hardware Detection
    if cfg!(target_os = "macos") {
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

        if find_ffmpeg().is_none() {
            return MicPermissionResult {
                status: "UNAVAILABLE".to_string(),
                device_name,
                message: "Hardware detected, but FFmpeg binary not found on standard paths for audio capture.".to_string(),
            };
        }

        return MicPermissionResult {
            status: "GRANTED".to_string(),
            device_name,
            message: "macOS audio input device and capture tools ready.".to_string(),
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

    // 1. macOS Audio Capture Permission Verification via 0.5s Hardware Probe
    if cfg!(target_os = "macos") {
        let ffmpeg_bin = match find_ffmpeg() {
            Some(b) => b,
            None => {
                return MicPermissionResult {
                    status: "UNAVAILABLE".to_string(),
                    device_name: check.device_name,
                    message: "FFmpeg binary not found on macOS. Please install FFmpeg for native audio capture.".to_string(),
                };
            }
        };

        let probe_file = "/tmp/gia_mic_probe.wav";
        let _ = std::fs::remove_file(probe_file);

        let status = Command::new(&ffmpeg_bin)
            .args([
                "-y",
                "-f", "avfoundation",
                "-i", ":0",
                "-t", "0.5",
                "-ar", "16000",
                "-ac", "1",
                "-acodec", "pcm_s16le",
                probe_file,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();

        return match status {
            Ok(exit_status) if exit_status.success() => {
                let _ = std::fs::remove_file(probe_file);
                MicPermissionResult {
                    status: "GRANTED".to_string(),
                    device_name: check.device_name.or_else(|| Some("MacBook Pro Microphone".to_string())),
                    message: "Desktop microphone access acquired and verified successfully.".to_string(),
                }
            }
            Ok(exit_status) => MicPermissionResult {
                status: "DENIED".to_string(),
                device_name: check.device_name,
                message: format!("macOS microphone permission denied or device busy (exit code: {})", exit_status),
            },
            Err(err) => MicPermissionResult {
                status: "ERROR".to_string(),
                device_name: check.device_name,
                message: format!("Failed to execute microphone capture probe: {}", err),
            },
        };
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

    // 1. macOS Audio Capture via AVFoundation / ffmpeg
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
}

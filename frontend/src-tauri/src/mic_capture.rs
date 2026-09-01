use hound::WavReader;
use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;
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



pub fn check_permission_internal() -> MicPermissionResult {
    let output = Command::new("arecord").arg("-l").output();

    match output {
        Ok(res) => {
            let stdout = String::from_utf8_lossy(&res.stdout);
            if res.status.success() && stdout.contains("card") {
                // Extract first device line if available
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
                    message: "No hardware audio capture devices found (arecord -l output empty).".to_string(),
                }
            }
        }
        Err(err) => MicPermissionResult {
            status: "ERROR".to_string(),
            device_name: None,
            message: format!("Failed to query Linux audio hardware using arecord: {}", err),
        },
    }
}

pub fn request_permission_internal() -> MicPermissionResult {
    // Check permission first
    let check = check_permission_internal();
    if check.status != "GRANTED" {
        return check;
    }

    // Perform a short 0.5s probe to verify device stream acquisition
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
        Ok(exit_status) if exit_status.success() => MicPermissionResult {
            status: "GRANTED".to_string(),
            device_name: check.device_name,
            message: "Desktop microphone access acquired successfully.".to_string(),
        },
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

    // Remove old test file if present
    let _ = std::fs::remove_file(&wav_path);

    let start_time = Instant::now();

    let child = Command::new("arecord")
        .arg("-d")
        .arg(duration_secs.to_string())
        .arg("-f")
        .arg("S16_LE")
        .arg("-r")
        .arg("16000")
        .arg("-c")
        .arg("1")
        .arg(&wav_path)
        .spawn();

    let mut process = child.map_err(|e| format!("Failed to spawn arecord capture process: {}", e))?;

    let exit_status = process
        .wait()
        .map_err(|e| format!("Failed waiting for arecord process: {}", e))?;

    if !exit_status.success() {
        return Err(format!("arecord process exited with error code: {}", exit_status));
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
    let _ = Command::new("pkill").arg("-f").arg("arecord").status();
}

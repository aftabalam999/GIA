# Step 2 — Fix macOS Tauri Microphone Permissions and Application Metadata Report

**Date**: 2026-11-10  
**Platform**: macOS Darwin (Apple Silicon arm64)  
**Host Version**: Darwin Kernel Version 27.2 / macOS  
**Target Environments**:
- Browser Mode: Chrome / Safari / Firefox (`http://localhost:1420`)
- Native Desktop Mode: Tauri v2 WebKit WKWebView (`target/release/bundle/macos/GIA.app` & `target/debug/frontend`)

---

## 1. Root Causes Fixed

In Step 1, four core defects were identified in the macOS Tauri permission and metadata pipeline:

1. **Duplicate / Malformed Mach-O `__info_plist` Section**:
   - *Problem*: `frontend/src-tauri/build.rs` manually passed `-Wl,-sectcreate,__TEXT,__info_plist,...` to the Apple clang linker. Simultaneously, `tauri-codegen` generated code invoking `tauri::embed_plist::embed_info_plist!()`. Both mechanisms placed plist XML into `__TEXT,__info_plist`, resulting in two concatenated XML documents and a corrupted plist inside the Mach-O binary.
   - *Fix*: Removed the redundant manual linker invocation from `build.rs`. Tauri v2's native `tauri_build::build()` and `embed_plist` now cleanly manage the single, well-formed embedded property list.

2. **Incomplete Application Metadata in Plist**:
   - *Problem*: `frontend/src-tauri/Info.plist` lacked `CFBundleIdentifier` (`com.jasin.gia`) and application identity keys. In debug mode, macOS TCC could not associate privacy permissions with the unbundled executable.
   - *Fix*: Configured complete, valid macOS application metadata in `frontend/src-tauri/Info.plist`, including `CFBundleIdentifier: com.jasin.gia`, `CFBundleName: GIA`, `CFBundleDisplayName: GIA`, `CFBundlePackageType: APPL`, `CFBundleShortVersionString: 0.1.0`, `CFBundleVersion: 0.1.0`, and `NSMicrophoneUsageDescription`.

3. **Missing WebKit Media-Capture Permission Handler in Tauri**:
   - *Problem*: Tauri WKWebView was not intercepting and evaluating webview media permission requests. Although WRY has an internal default, there was no origin-validation hook or explicit microphone capture allowance, leaving media requests exposed to default WKUIDelegate rejections.
   - *Fix*: Registered an explicit `.on_permission_request(...)` hook on `tauri::Builder` in `frontend/src-tauri/src/lib.rs`. It verifies the request origin against trusted GIA application origins (`localhost`, `127.0.0.1`, `tauri.localhost`, `tauri://localhost`), explicitly permits `PermissionKind::Microphone` so WebKit delegates authorization to macOS TCC, and denies `PermissionKind::Camera` and all unrelated permission requests.

4. **Silent Permission Masking in `App.tsx`**:
   - *Problem*: In `handleGrantMicPermission()`, when `getUserMedia()` failed in the webview, execution fell back to `requestNativeMicrophonePermission()`. The underlying 0.5s FFmpeg probe succeeded (because the terminal/shell had mic permissions), causing `App.tsx` to record `gia_mic_permission = 'granted'` and silently close the dialog even though WebKit `getUserMedia()` remained unauthorized.
   - *Fix*: Decoupled WebAudio/WebKit permission from native capture. Removed the fake fallback approval in `handleGrantMicPermission()`. If `getUserMedia()` fails or is denied, `gia_mic_permission` is set to `'rejected'`, the permission modal remains open, and a clear diagnostic message is displayed instructing the user how to grant access in **macOS System Settings > Privacy & Security > Microphone**.

---

## 2. Modified Files

1. **`frontend/src-tauri/build.rs`**:
   - Replaced custom linker flags with standard `tauri_build::build()`. Eliminates duplicate Mach-O plist embedding.
2. **`frontend/src-tauri/Info.plist`**:
   - Added `CFBundleIdentifier` (`com.jasin.gia`), `CFBundleName`, `CFBundleDisplayName`, `CFBundlePackageType`, version numbers, and preserved `NSMicrophoneUsageDescription`.
3. **`frontend/src-tauri/src/lib.rs`**:
   - Imported `PermissionKind` and `PermissionResponse` from `tauri::webview`.
   - Added `.on_permission_request(...)` handler to `tauri::Builder::default()`. Origin-checks and allows `Microphone`, denies `Camera` and unrequested permissions.
4. **`frontend/src/App.tsx`**:
   - Added `micModalError` state.
   - Removed FFmpeg fallback from `handleGrantMicPermission()`.
   - Added clear error guidance in the permission modal with actionable steps for macOS System Settings.
   - Removed unused import `requestNativeMicrophonePermission`.

---

## 3. Exact macOS Permission Configuration

### 1. `frontend/src-tauri/Info.plist`
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.jasin.gia</string>
    <key>CFBundleName</key>
    <string>GIA</string>
    <key>CFBundleDisplayName</key>
    <string>GIA</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>0.1.0</string>
    <key>NSMicrophoneUsageDescription</key>
    <string>GIA Assistant requires microphone access for voice commands and continuous listening.</string>
</dict>
</plist>
```

### 2. `frontend/src-tauri/Entitlements.plist`
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.device.audio-input</key>
    <true/>
</dict>
</plist>
```

### 3. `frontend/src-tauri/tauri.conf.json`
```json
  "bundle": {
    "active": true,
    "targets": "all",
    "macOS": {
      "infoPlist": "Info.plist",
      "entitlements": "Entitlements.plist"
    },
    "icon": [ ... ]
  }
```

### 4. `frontend/src-tauri/src/lib.rs` (WKWebView Permission Hook)
```rust
use tauri::webview::{PermissionKind, PermissionResponse};

tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_global_shortcut::Builder::new().build())
    .on_permission_request(|webview, kind| {
        let is_allowed_origin = match webview.url() {
            Ok(url) => {
                let scheme = url.scheme();
                let host = url.host_str().unwrap_or("");
                (scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "tauri.localhost"))
                    || (scheme == "tauri" && host == "localhost")
            }
            Err(_) => false,
        };

        if !is_allowed_origin {
            eprintln!("⚠️ [Tauri Permissions] Denied {:?} request from untrusted origin: {:?}", kind, webview.url());
            return PermissionResponse::Deny;
        }

        match kind {
            PermissionKind::Microphone => {
                println!("🎙️ [Tauri Permissions] Allowing Microphone capture request for GIA Webview");
                PermissionResponse::Allow
            }
            PermissionKind::Camera => {
                println!("📷 [Tauri Permissions] Denied unrequested Camera permission");
                PermissionResponse::Deny
            }
            _ => PermissionResponse::Deny,
        }
    })
```

---

## 4. Actual `.app` Bundle and Binary Inspection Results

### 1. `plutil -lint` Verification
```bash
plutil -lint frontend/src-tauri/Info.plist
# Output: frontend/src-tauri/Info.plist: OK

plutil -lint frontend/src-tauri/Entitlements.plist
# Output: frontend/src-tauri/Entitlements.plist: OK

plutil -lint target/release/bundle/macos/GIA.app/Contents/Info.plist
# Output: target/release/bundle/macos/GIA.app/Contents/Info.plist: OK
```

### 2. Embedded Mach-O Section Inspection (`target/debug/frontend`)
Section inspected with `otool -l target/debug/frontend`:
- `sectname`: `__info_plist`
- `segname`: `__TEXT`
- `size`: `0x000000000000029a` (666 bytes)
- `offset`: `11055304`

Extracted content:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>com.jasin.gia</string>
	<key>CFBundleName</key>
	<string>GIA</string>
	<key>CFBundleDisplayName</key>
	<string>GIA</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>0.1.0</string>
	<key>CFBundleVersion</key>
	<string>0.1.0</string>
	<key>NSMicrophoneUsageDescription</key>
	<string>GIA Assistant requires microphone access for voice commands and continuous listening.</string>
</dict>
</plist>
```
**Verification**: Exactly ONE valid XML Property List document is present. No duplication. Lint result: `OK`.

### 3. Packaged `.app` Bundle Inspection (`target/release/bundle/macos/GIA.app`)
- **Bundle Path**: `target/release/bundle/macos/GIA.app`
- **Info.plist Contents**:
  - `CFBundleIdentifier`: `com.jasin.gia`
  - `CFBundleName`: `GIA`
  - `CFBundleDisplayName`: `GIA`
  - `NSMicrophoneUsageDescription`: `GIA Assistant requires microphone access for voice commands and continuous listening.`
  - `CFBundleShortVersionString`: `0.1.0`
- **Code Signing with Entitlements**:
  ```bash
  codesign -d --entitlements :- target/release/bundle/macos/GIA.app
  # Output:
  # <key>com.apple.security.device.audio-input</key>
  # <true/>
  ```

---

## 5. Build and Test Outputs

### 1. Rust Cargo Check & Tests
```bash
cargo check --manifest-path frontend/src-tauri/Cargo.toml
# Output: Finished `dev` profile in 15.55s (0 errors)

cargo test --manifest-path frontend/src-tauri/Cargo.toml
# Output:
# running 6 tests
# test mic_capture::tests::test_find_ffmpeg_or_system_path ... ok
# test service_manager::tests::test_find_workspace_root ... ok
# test service_manager::tests::test_port_check_unused_port ... ok
# test service_manager::tests::test_get_statuses ... ok
# test mic_capture::tests::test_check_permission_internal ... ok
# test mic_capture::tests::test_request_permission_internal ... ok
# test result: ok. 6 passed; 0 failed; 0 ignored; finished in 1.14s
```

### 2. Frontend Production Build
```bash
npm --prefix frontend run build
# Output:
# > frontend@1.0.0 build
# > tsc && vite build
# vite v7.3.6 building client environment for production...
# dist/index.html                   0.47 kB │ gzip:  0.31 kB
# dist/assets/index-D25nX9F9.css   26.05 kB │ gzip:  5.49 kB
# dist/assets/index-C6uoYKdh.js   278.54 kB │ gzip: 83.34 kB
# ✓ built in 479ms
```

### 3. Voice & Audio Test Suite (Vitest)
```bash
npx vitest run \
  frontend/src/services/audioRecorder.test.ts \
  frontend/src/services/tauriTtsPlayback.test.ts \
  frontend/src/services/voiceRuntimeVerification.test.ts \
  frontend/src/services/localVad.test.ts \
  frontend/src/services/voiceBargeIn.test.ts \
  frontend/src/services/liveAudioCapture.test.ts
```
**Test Results**:
- `audioRecorder.test.ts`: 5 passed
- `localVad.test.ts`: 7 passed
- `liveAudioCapture.test.ts`: 9 passed
- `voiceRuntimeVerification.test.ts`: 4 passed
- `voiceBargeIn.test.ts`: 8 passed
- `tauriTtsPlayback.test.ts`: 4 passed
- **Total**: **37 passed across 6 test suites (0 failures, 1.50s duration)**.

---

## 6. Remaining Limitations

1. **Development Runtime vs Packaged Bundle Distinction**:
   - In development mode (`tauri dev`), macOS runs `target/debug/frontend` directly. Because macOS TCC relies on application bundle boundaries (`.app`), certain macOS versions require launching the application from its bundled structure (`target/release/bundle/macos/GIA.app` or a debug bundle) for the initial TCC prompt to be presented by the OS.
2. **Live End-to-End WebKit Audio Capture**:
   - The permissions and metadata configuration is now complete and verified. The live hardware audio stream verification in the actual Tauri webview will be performed in Step 3.

---

## Conclusion

Step 2 is complete. All permission configurations, `build.rs`, application metadata, WKWebView permission handlers, and frontend permission state management have been fixed and verified. Execution is halted per instructions.


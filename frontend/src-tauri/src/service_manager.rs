use serde::{Deserialize, Serialize};
use std::io::Read;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServiceStatus {
    pub name: String,
    pub status: String, // "running" | "stopped" | "failed" | "starting"
    pub port: u16,
    pub pid: Option<u32>,
    pub is_attached: bool,
    pub error: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServiceHealthReport {
    pub python_ai: ServiceStatus,
    pub backend: ServiceStatus,
    pub all_healthy: bool,
    pub message: String,
}

pub struct ServiceManager {
    python_child: Arc<Mutex<Option<Child>>>,
    backend_child: Arc<Mutex<Option<Child>>>,
    workspace_root: PathBuf,
}

impl ServiceManager {
    pub fn new() -> Self {
        let root = Self::find_workspace_root();
        Self {
            python_child: Arc::new(Mutex::new(None)),
            backend_child: Arc::new(Mutex::new(None)),
            workspace_root: root,
        }
    }

    /// Recursively locate workspace root containing ai-service and backend
    fn find_workspace_root() -> PathBuf {
        // Try current executable directory parent
        if let Ok(mut exe_path) = std::env::current_exe() {
            for _ in 0..6 {
                if exe_path.join("ai-service").exists() && exe_path.join("backend").exists() {
                    return exe_path;
                }
                if !exe_path.pop() {
                    break;
                }
            }
        }

        // Try current working directory
        if let Ok(cwd) = std::env::current_dir() {
            let mut cur = cwd.clone();
            for _ in 0..6 {
                if cur.join("ai-service").exists() && cur.join("backend").exists() {
                    return cur;
                }
                if !cur.pop() {
                    break;
                }
            }
        }

        // Default fallback to current dir
        PathBuf::from(".")
    }

    /// Check if local TCP port is already open
    pub fn is_port_in_use(port: u16) -> bool {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
    }

    /// Find Python virtual environment executable
    fn find_python_bin(&self) -> Option<PathBuf> {
        let candidates = [
            self.workspace_root.join("ai-service/.venv/bin/python"),
            self.workspace_root.join(".venv/bin/python"),
            self.workspace_root.join("ai-service/venv/bin/python"),
            PathBuf::from("/Library/Frameworks/Python.framework/Versions/3.11/bin/python3"),
            PathBuf::from("/usr/local/bin/python3"),
            PathBuf::from("/opt/homebrew/bin/python3"),
        ];

        for c in &candidates {
            if c.exists() {
                return Some(c.clone());
            }
        }

        // Fallback to system python3 in PATH
        Self::resolve_in_path("python3")
    }

    /// Resolve an executable name in the system PATH
    fn resolve_in_path(cmd: &str) -> Option<PathBuf> {
        let candidates = [
            format!("/opt/homebrew/bin/{}", cmd),
            format!("/usr/local/bin/{}", cmd),
            format!("/usr/bin/{}", cmd),
        ];
        for c in &candidates {
            let p = PathBuf::from(c);
            if p.exists() {
                return Some(p);
            }
        }
        let output = Command::new("which").arg(cmd).output().ok()?;
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path_str.is_empty() {
                return Some(PathBuf::from(path_str));
            }
        }
        None
    }

    /// Starts Python AI service (FastAPI on port 8001)
    pub fn start_python_ai_service(&self) -> ServiceStatus {
        let port = 8001;

        // 1. Guard against duplicate model initialization:
        // If port is already in use, service is running; do not spawn a duplicate process.
        if Self::is_port_in_use(port) {
            return ServiceStatus {
                name: "python_ai_service".to_string(),
                status: "running".to_string(),
                port,
                pid: None,
                is_attached: true,
                error: None,
            };
        }

        // 2. Locate Python binary
        let python_bin = match self.find_python_bin() {
            Some(bin) => bin,
            None => {
                let err = "Python virtual environment not found. Please ensure ai-service/.venv exists with required ML packages.".to_string();
                eprintln!("❌ [Tauri ServiceManager] {}", err);
                return ServiceStatus {
                    name: "python_ai_service".to_string(),
                    status: "failed".to_string(),
                    port,
                    pid: None,
                    is_attached: false,
                    error: Some(err),
                };
            }
        };

        let ai_service_dir = self.workspace_root.join("ai-service");
        println!(
            "🚀 [Tauri ServiceManager] Launching Python AI service using {:?} in {:?}...",
            python_bin, ai_service_dir
        );

        let spawn_res = Command::new(&python_bin)
            .args(["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8001"])
            .current_dir(&ai_service_dir)
            .env("PYTHONPATH", ".")
            .env("PYTHONUNBUFFERED", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();

        match spawn_res {
            Ok(mut child) => {
                let pid = child.id();
                println!("📦 [Tauri ServiceManager] Spawned Python AI service child PID: {}", pid);

                // Wait up to 5 seconds for port 8001 to open, checking for premature exit
                let start_time = Instant::now();
                let mut is_ready = false;

                while start_time.elapsed() < Duration::from_secs(6) {
                    // Check if child exited prematurely
                    if let Ok(Some(exit_status)) = child.try_wait() {
                        let mut stderr_msg = String::new();
                        if let Some(mut stderr) = child.stderr.take() {
                            let _ = stderr.read_to_string(&mut stderr_msg);
                        }
                        let err_text = format!(
                            "Python AI service exited prematurely with code {:?}. Stderr: {}",
                            exit_status.code(),
                            stderr_msg.trim()
                        );
                        eprintln!("❌ [Tauri ServiceManager] {}", err_text);
                        return ServiceStatus {
                            name: "python_ai_service".to_string(),
                            status: "failed".to_string(),
                            port,
                            pid: Some(pid),
                            is_attached: false,
                            error: Some(err_text),
                        };
                    }

                    if Self::is_port_in_use(port) {
                        is_ready = true;
                        break;
                    }

                    std::thread::sleep(Duration::from_millis(200));
                }

                if is_ready {
                    println!("✅ [Tauri ServiceManager] Python AI service is healthy on port 8001!");
                    let mut lock = self.python_child.lock().unwrap();
                    *lock = Some(child);

                    ServiceStatus {
                        name: "python_ai_service".to_string(),
                        status: "running".to_string(),
                        port,
                        pid: Some(pid),
                        is_attached: false,
                        error: None,
                    }
                } else {
                    // Service did not become ready in time
                    println!("⏳ [Tauri ServiceManager] Python AI service started (PID: {}), still loading model weights...", pid);
                    let mut lock = self.python_child.lock().unwrap();
                    *lock = Some(child);

                    ServiceStatus {
                        name: "python_ai_service".to_string(),
                        status: "starting".to_string(),
                        port,
                        pid: Some(pid),
                        is_attached: false,
                        error: None,
                    }
                }
            }
            Err(e) => {
                let err_text = format!("Failed to spawn Python process: {}", e);
                eprintln!("❌ [Tauri ServiceManager] {}", err_text);
                ServiceStatus {
                    name: "python_ai_service".to_string(),
                    status: "failed".to_string(),
                    port,
                    pid: None,
                    is_attached: false,
                    error: Some(err_text),
                }
            }
        }
    }

    /// Starts Node.js backend service (Fastify on port 5001)
    pub fn start_backend_service(&self) -> ServiceStatus {
        let port = 5001;

        // If port is already in use, backend is already running
        if Self::is_port_in_use(port) {
            return ServiceStatus {
                name: "backend_service".to_string(),
                status: "running".to_string(),
                port,
                pid: None,
                is_attached: true,
                error: None,
            };
        }

        let backend_dir = self.workspace_root.join("backend");
        let npm_cmd = Self::resolve_in_path("npm").unwrap_or_else(|| PathBuf::from("npm"));

        println!("🚀 [Tauri ServiceManager] Launching Node.js backend service in {:?}...", backend_dir);

        let system_path = std::env::var("PATH").unwrap_or_default();
        let extended_path = format!("/opt/homebrew/bin:/usr/local/bin:{}", system_path);

        let spawn_res = Command::new(&npm_cmd)
            .args(["run", "dev"])
            .current_dir(&backend_dir)
            .env("PATH", &extended_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();

        match spawn_res {
            Ok(child) => {
                let pid = child.id();
                println!("📦 [Tauri ServiceManager] Spawned Node.js backend PID: {}", pid);

                let mut lock = self.backend_child.lock().unwrap();
                *lock = Some(child);

                ServiceStatus {
                    name: "backend_service".to_string(),
                    status: "starting".to_string(),
                    port,
                    pid: Some(pid),
                    is_attached: false,
                    error: None,
                }
            }
            Err(e) => {
                let err_text = format!("Failed to spawn backend process: {}", e);
                eprintln!("❌ [Tauri ServiceManager] {}", err_text);
                ServiceStatus {
                    name: "backend_service".to_string(),
                    status: "failed".to_string(),
                    port,
                    pid: None,
                    is_attached: false,
                    error: Some(err_text),
                }
            }
        }
    }

    /// Query current status of both services
    pub fn get_statuses(&self) -> Vec<ServiceStatus> {
        let py_port = 8001;
        let py_running = Self::is_port_in_use(py_port);
        let py_child_lock = self.python_child.lock().unwrap();
        let py_pid = py_child_lock.as_ref().map(|c| c.id());

        let py_status = ServiceStatus {
            name: "python_ai_service".to_string(),
            status: if py_running {
                "running".to_string()
            } else if py_pid.is_some() {
                "starting".to_string()
            } else {
                "stopped".to_string()
            },
            port: py_port,
            pid: py_pid,
            is_attached: py_running && py_pid.is_none(),
            error: None,
        };

        let node_port = 5001;
        let node_running = Self::is_port_in_use(node_port);
        let node_child_lock = self.backend_child.lock().unwrap();
        let node_pid = node_child_lock.as_ref().map(|c| c.id());

        let node_status = ServiceStatus {
            name: "backend_service".to_string(),
            status: if node_running {
                "running".to_string()
            } else if node_pid.is_some() {
                "starting".to_string()
            } else {
                "stopped".to_string()
            },
            port: node_port,
            pid: node_pid,
            is_attached: node_running && node_pid.is_none(),
            error: None,
        };

        vec![py_status, node_status]
    }

    /// Stops spawned child processes cleanly on shutdown
    pub fn shutdown_all(&self) {
        println!("🛑 [Tauri ServiceManager] Shutting down spawned local services...");
        if let Ok(mut lock) = self.python_child.lock() {
            if let Some(mut child) = lock.take() {
                println!("🛑 Killing Python AI child PID: {}", child.id());
                let _ = child.kill();
                let _ = child.wait();
            }
        }

        if let Ok(mut lock) = self.backend_child.lock() {
            if let Some(mut child) = lock.take() {
                println!("🛑 Killing Node.js backend child PID: {}", child.id());
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

// Using OnceLock for static singleton in modern Rust (1.70+)
use std::sync::OnceLock;

static SERVICE_MANAGER: OnceLock<ServiceManager> = OnceLock::new();

pub fn get_service_manager() -> &'static ServiceManager {
    SERVICE_MANAGER.get_or_init(ServiceManager::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_workspace_root() {
        let root = ServiceManager::find_workspace_root();
        assert!(root.exists(), "Workspace root must exist");
    }

    #[test]
    fn test_get_statuses() {
        let mgr = ServiceManager::new();
        let statuses = mgr.get_statuses();
        assert_eq!(statuses.len(), 2, "Must return Python AI and Node backend statuses");
        assert_eq!(statuses[0].name, "python_ai_service");
        assert_eq!(statuses[0].port, 8001);
        assert_eq!(statuses[1].name, "backend_service");
        assert_eq!(statuses[1].port, 5001);
    }

    #[test]
    fn test_port_check_unused_port() {
        // Port 59999 should not be in use
        let in_use = ServiceManager::is_port_in_use(59999);
        assert!(!in_use, "Unused port 59999 should report false");
    }
}

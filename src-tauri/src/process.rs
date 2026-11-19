use std::fmt;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Windows process creation flag preventing console/terminal window creation for CLI tools.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const ENGINE_VERSION_TIMEOUT: Duration = Duration::from_secs(8);
pub const FFPROBE_TIMEOUT: Duration = Duration::from_secs(15);
pub const DIAGNOSTICS_TIMEOUT: Duration = Duration::from_secs(15);
pub const COOKIE_TEST_TIMEOUT: Duration = Duration::from_secs(20);
pub const INSPECT_URL_TIMEOUT: Duration = Duration::from_secs(60);

pub const DEFAULT_MAX_STDERR_BYTES: usize = 64 * 1024;
pub const DEFAULT_MAX_STDOUT_BYTES: usize = 4 * 1024 * 1024;
pub const INSPECT_MAX_STDOUT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug)]
pub struct CapturedOutput {
    pub status: ExitStatus,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessError {
    SpawnFailed(String),
    TimedOut { duration_ms: u64 },
    Cancelled,
    OutputLimitExceeded { stream: &'static str, limit_bytes: usize },
    WaitFailed(String),
}

impl fmt::Display for ProcessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProcessError::SpawnFailed(msg) => write!(f, "Failed to spawn process: {}", msg),
            ProcessError::TimedOut { duration_ms } => {
                let secs = (*duration_ms as f64 / 1000.0).max(0.1);
                write!(f, "Process timed out after {:.1}s and was terminated", secs)
            }
            ProcessError::Cancelled => write!(f, "Operation was cancelled"),
            ProcessError::OutputLimitExceeded { stream, limit_bytes } => write!(
                f,
                "Process {} output exceeded safe limit of {} bytes",
                stream, limit_bytes
            ),
            ProcessError::WaitFailed(msg) => write!(f, "Failed waiting on process: {}", msg),
        }
    }
}

impl std::error::Error for ProcessError {}

#[derive(Clone)]
pub struct ProcessOptions {
    pub timeout: Duration,
    pub max_stdout_bytes: usize,
    pub max_stderr_bytes: usize,
    /// When true, stdout behaves as a sliding tail buffer; when false (e.g. JSON metadata),
    /// exceeding `max_stdout_bytes` kills the process and returns `OutputLimitExceeded` instead
    /// of corrupting the beginning of JSON.
    pub truncate_stdout_tail: bool,
    pub cancel_flag: Option<Arc<AtomicBool>>,
    pub pid_slot: Option<Arc<AtomicU32>>,
}

impl Default for ProcessOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(30),
            max_stdout_bytes: DEFAULT_MAX_STDOUT_BYTES,
            max_stderr_bytes: DEFAULT_MAX_STDERR_BYTES,
            truncate_stdout_tail: true,
            cancel_flag: None,
            pid_slot: None,
        }
    }
}

/// Configures a `std::process::Command` so Windows desktop builds never flash or open
/// console windows while still preserving piped `stdout`/`stderr` and direct execution.
pub fn configure_background_command(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

fn append_capped(buf: &mut Vec<u8>, chunk: &[u8], max_bytes: usize) {
    if max_bytes == 0 {
        return;
    }
    if chunk.len() >= max_bytes {
        buf.clear();
        buf.extend_from_slice(&chunk[chunk.len() - max_bytes..]);
        return;
    }
    let overflow = (buf.len() + chunk.len()).saturating_sub(max_bytes);
    if overflow > 0 {
        buf.drain(0..overflow);
    }
    buf.extend_from_slice(chunk);
}

fn clear_pid_slot(slot: &Option<Arc<AtomicU32>>) {
    if let Some(ref s) = slot {
        s.store(0, Ordering::SeqCst);
    }
}

/// Executes a background CLI command without creating a Windows console window, draining
/// stdout and stderr concurrently while enforcing timeout, cancellation, and bounded output.
pub fn run_command_with_options(
    cmd: &mut Command,
    opts: ProcessOptions,
) -> Result<CapturedOutput, ProcessError> {
    if let Some(ref flag) = opts.cancel_flag {
        if flag.load(Ordering::SeqCst) {
            return Err(ProcessError::Cancelled);
        }
    }

    configure_background_command(cmd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let start = Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|e| ProcessError::SpawnFailed(e.to_string()))?;

    let pid = child.id();
    if let Some(ref slot) = opts.pid_slot {
        slot.store(pid, Ordering::SeqCst);
    }

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let limit_exceeded = Arc::new(AtomicBool::new(false));
    let limit_exceeded_stdout = Arc::clone(&limit_exceeded);

    let (stdout_tx, stdout_rx) = mpsc::sync_channel::<Vec<u8>>(1);
    let max_stdout = opts.max_stdout_bytes;
    let truncate_stdout = opts.truncate_stdout_tail;
    thread::spawn(move || {
        let mut collected = Vec::new();
        if let Some(mut pipe) = stdout_pipe {
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if truncate_stdout {
                            append_capped(&mut collected, &chunk[..n], max_stdout);
                        } else if collected.len().saturating_add(n) > max_stdout {
                            limit_exceeded_stdout.store(true, Ordering::SeqCst);
                            kill_process_tree(pid);
                            break;
                        } else {
                            collected.extend_from_slice(&chunk[..n]);
                        }
                    }
                }
            }
        }
        let _ = stdout_tx.send(collected);
    });

    let (stderr_tx, stderr_rx) = mpsc::sync_channel::<Vec<u8>>(1);
    let max_stderr = opts.max_stderr_bytes;
    thread::spawn(move || {
        let mut collected = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => append_capped(&mut collected, &chunk[..n], max_stderr),
                }
            }
        }
        let _ = stderr_tx.send(collected);
    });

    let exit_status: ExitStatus = loop {
        if let Some(ref flag) = opts.cancel_flag {
            if flag.load(Ordering::SeqCst) {
                kill_process_tree(pid);
                let _ = child.kill();
                let _ = child.wait();
                clear_pid_slot(&opts.pid_slot);
                let _ = stdout_rx.recv_timeout(Duration::from_millis(500));
                let _ = stderr_rx.recv_timeout(Duration::from_millis(500));
                return Err(ProcessError::Cancelled);
            }
        }

        if limit_exceeded.load(Ordering::SeqCst) {
            kill_process_tree(pid);
            let _ = child.kill();
            let _ = child.wait();
            clear_pid_slot(&opts.pid_slot);
            let _ = stdout_rx.recv_timeout(Duration::from_millis(500));
            let _ = stderr_rx.recv_timeout(Duration::from_millis(500));
            return Err(ProcessError::OutputLimitExceeded {
                stream: "stdout",
                limit_bytes: max_stdout,
            });
        }

        if start.elapsed() >= opts.timeout {
            let elapsed_ms = start.elapsed().as_millis() as u64;
            kill_process_tree(pid);
            let _ = child.kill();
            let _ = child.wait();
            clear_pid_slot(&opts.pid_slot);
            let _ = stdout_rx.recv_timeout(Duration::from_millis(500));
            let _ = stderr_rx.recv_timeout(Duration::from_millis(500));
            return Err(ProcessError::TimedOut {
                duration_ms: elapsed_ms,
            });
        }

        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(e) => {
                kill_process_tree(pid);
                clear_pid_slot(&opts.pid_slot);
                return Err(ProcessError::WaitFailed(e.to_string()));
            }
        }
    };

    clear_pid_slot(&opts.pid_slot);

    let stdout_bytes = stdout_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or_default();
    let stderr_bytes = stderr_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or_default();

    if let Some(ref flag) = opts.cancel_flag {
        if flag.load(Ordering::SeqCst) {
            return Err(ProcessError::Cancelled);
        }
    }

    if limit_exceeded.load(Ordering::SeqCst) {
        return Err(ProcessError::OutputLimitExceeded {
            stream: "stdout",
            limit_bytes: max_stdout,
        });
    }

    Ok(CapturedOutput {
        status: exit_status,
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

/// Convenience wrapper for bounded command execution using default timeout & limits.
pub fn run_captured_command(cmd: &mut Command) -> Result<CapturedOutput, String> {
    run_command_with_options(cmd, ProcessOptions::default()).map_err(|e| e.to_string())
}

/// Streams stdout line-by-line while concurrently draining stderr on a background thread
/// so pipe buffers never deadlock even under verbose warnings or errors.
pub fn stream_child_lines<F>(
    mut child: Child,
    mut on_stdout_line: F,
) -> Result<(ExitStatus, String), String>
where
    F: FnMut(&str) -> bool,
{
    let pid = child.id();
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stderr_tail = Arc::new(Mutex::new(Vec::<u8>::new()));
    let stderr_tail_clone = Arc::clone(&stderr_tail);

    let (stderr_done_tx, stderr_done_rx) = mpsc::sync_channel::<()>(1);
    thread::spawn(move || {
        if let Some(mut pipe) = stderr_pipe {
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut guard = stderr_tail_clone
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        append_capped(&mut guard, &chunk[..n], DEFAULT_MAX_STDERR_BYTES);
                    }
                }
            }
        }
        let _ = stderr_done_tx.send(());
    });

    let mut aborted = false;
    let mut last_stdout_lines: Vec<String> = Vec::new();
    if let Some(pipe) = stdout_pipe {
        let reader = BufReader::new(pipe);
        for line_res in reader.lines() {
            match line_res {
                Ok(line) => {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        if last_stdout_lines.len() >= 25 {
                            last_stdout_lines.remove(0);
                        }
                        last_stdout_lines.push(trimmed.to_string());
                    }
                    if !on_stdout_line(&line) {
                        aborted = true;
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    }

    if aborted {
        kill_process_tree(pid);
        let _ = child.kill();
    }

    let status = child
        .wait()
        .map_err(|e| format!("Failed waiting for child process: {}", e))?;
    let _ = stderr_done_rx.recv_timeout(Duration::from_secs(2));

    let stderr_bytes = stderr_tail
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let mut combined_err = String::from_utf8_lossy(&stderr_bytes).trim().to_string();
    if combined_err.is_empty() && !status.success() && !last_stdout_lines.is_empty() {
        combined_err = last_stdout_lines.join("\n");
    }

    Ok((status, combined_err))
}

/// Terminates a process and its entire descendant process tree without opening a console window.
pub fn kill_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }

    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/F", "/T", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_background_command(&mut cmd);
        let _ = cmd.status();
    }

    #[cfg(unix)]
    {
        let mut term = Command::new("kill");
        term.args(["-TERM", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _ = term.status();

        thread::sleep(Duration::from_millis(50));

        let mut kill = Command::new("kill");
        kill.args(["-9", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _ = kill.status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_no_window_constant_matches_win32_spec() {
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000);
    }

    #[test]
    fn test_append_capped_preserves_latest_tail() {
        let mut buf = Vec::new();
        append_capped(&mut buf, b"123456", 5);
        assert_eq!(buf, b"23456");
        append_capped(&mut buf, b"78", 5);
        assert_eq!(buf, b"45678");
    }

    #[test]
    fn test_configure_background_command_does_not_panic() {
        let mut cmd = Command::new("echo");
        configure_background_command(&mut cmd);
    }

    #[cfg(unix)]
    #[test]
    fn test_run_captured_command_success_and_nonzero_exit() {
        let mut ok_cmd = Command::new("sh");
        ok_cmd.args(["-c", "printf 'hello-vanta'"]);
        let ok_res = run_captured_command(&mut ok_cmd).expect("command execution");
        assert!(ok_res.status.success());
        assert_eq!(ok_res.stdout, "hello-vanta");

        let mut fail_cmd = Command::new("sh");
        fail_cmd.args(["-c", "echo 'boom-err' 1>&2; exit 42"]);
        let fail_res = run_captured_command(&mut fail_cmd).expect("command returns exit status");
        assert!(!fail_res.status.success());
        assert_eq!(fail_res.status.code(), Some(42));
        assert!(fail_res.stderr.contains("boom-err"));
    }

    #[cfg(unix)]
    #[test]
    fn test_run_command_with_timeout_kills_process_and_clears_pid() {
        let pid_slot = Arc::new(AtomicU32::new(0));
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 30"]);
        let opts = ProcessOptions {
            timeout: Duration::from_millis(150),
            pid_slot: Some(Arc::clone(&pid_slot)),
            ..ProcessOptions::default()
        };

        let res = run_command_with_options(&mut cmd, opts);
        assert!(matches!(res, Err(ProcessError::TimedOut { .. })));
        assert_eq!(pid_slot.load(Ordering::SeqCst), 0);
    }

    #[cfg(unix)]
    #[test]
    fn test_run_command_with_cancellation_terminates_promptly() {
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let pid_slot = Arc::new(AtomicU32::new(0));

        let flag_clone = Arc::clone(&cancel_flag);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(120));
            flag_clone.store(true, Ordering::SeqCst);
        });

        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 30"]);
        let opts = ProcessOptions {
            timeout: Duration::from_secs(10),
            cancel_flag: Some(cancel_flag),
            pid_slot: Some(Arc::clone(&pid_slot)),
            ..ProcessOptions::default()
        };

        let start = Instant::now();
        let res = run_command_with_options(&mut cmd, opts);
        assert_eq!(res.unwrap_err(), ProcessError::Cancelled);
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_eq!(pid_slot.load(Ordering::SeqCst), 0);
    }

    #[cfg(unix)]
    #[test]
    fn test_run_command_handles_concurrent_large_stdout_and_large_stderr() {
        let mut cmd = Command::new("sh");
        cmd.args([
            "-c",
            "python3 -c \"import sys; sys.stderr.write('E'*100000); sys.stdout.write('S'*100000)\"",
        ]);
        let opts = ProcessOptions {
            timeout: Duration::from_secs(10),
            max_stdout_bytes: 200_000,
            max_stderr_bytes: 16_384,
            truncate_stdout_tail: false,
            ..ProcessOptions::default()
        };

        let res = run_command_with_options(&mut cmd, opts).expect("concurrent pipes succeed");
        assert!(res.status.success());
        assert_eq!(res.stdout.len(), 100_000);
        assert!(res.stderr.len() <= 16_384);
        assert!(!res.stderr.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn test_run_command_strict_stdout_limit_prevents_json_head_truncation() {
        let mut cmd = Command::new("sh");
        cmd.args([
            "-c",
            "python3 -c \"import sys; sys.stdout.write('{\\\"title\\\":\\\"' + 'x'*50000 + '\\\"}')\"",
        ]);
        let opts = ProcessOptions {
            timeout: Duration::from_secs(10),
            max_stdout_bytes: 1024,
            truncate_stdout_tail: false,
            ..ProcessOptions::default()
        };

        let res = run_command_with_options(&mut cmd, opts);
        assert!(matches!(
            res,
            Err(ProcessError::OutputLimitExceeded {
                stream: "stdout",
                limit_bytes: 1024
            })
        ));
    }
}

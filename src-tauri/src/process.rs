use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

/// Windows process creation flag preventing console/terminal window creation for CLI tools.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const MAX_STDERR_CAPTURE_BYTES: usize = 64 * 1024;
const MAX_STDOUT_CAPTURE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug)]
pub struct CapturedOutput {
    pub status: ExitStatus,
    pub stdout: String,
    pub stderr: String,
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

/// Executes a background CLI command without creating a Windows console window and
/// drains stdout and stderr concurrently to avoid pipe buffer deadlocks.
pub fn run_captured_command(cmd: &mut Command) -> Result<CapturedOutput, String> {
    configure_background_command(cmd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn process: {}", e))?;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stderr_handle = thread::spawn(move || -> Vec<u8> {
        let mut collected = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => append_capped(&mut collected, &chunk[..n], MAX_STDERR_CAPTURE_BYTES),
                }
            }
        }
        collected
    });

    let mut stdout_bytes = Vec::new();
    if let Some(mut pipe) = stdout_pipe {
        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => append_capped(&mut stdout_bytes, &chunk[..n], MAX_STDOUT_CAPTURE_BYTES),
            }
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("Failed waiting on process: {}", e))?;
    let stderr_bytes = stderr_handle.join().unwrap_or_default();

    Ok(CapturedOutput {
        status,
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
    })
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
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stderr_tail = Arc::new(Mutex::new(Vec::<u8>::new()));
    let stderr_tail_clone = Arc::clone(&stderr_tail);

    let stderr_thread = thread::spawn(move || {
        if let Some(mut pipe) = stderr_pipe {
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut guard = stderr_tail_clone
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        append_capped(&mut guard, &chunk[..n], MAX_STDERR_CAPTURE_BYTES);
                    }
                }
            }
        }
    });

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
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("Failed waiting for child process: {}", e))?;
    let _ = stderr_thread.join();

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

    #[cfg(unix)]
    #[test]
    fn test_run_captured_command_handles_concurrent_stdout_and_large_stderr() {
        // Ensures large stderr + stdout does not deadlock
        let mut cmd = Command::new("sh");
        cmd.args([
            "-c",
            "python3 -c \"import sys; sys.stderr.write('E'*100000); sys.stdout.write('OK_OUT')\"",
        ]);
        let res = run_captured_command(&mut cmd).expect("command execution");
        assert!(res.status.success());
        assert!(res.stdout.contains("OK_OUT"));
        assert!(res.stderr.len() <= MAX_STDERR_CAPTURE_BYTES);
        assert!(!res.stderr.is_empty());
    }
}

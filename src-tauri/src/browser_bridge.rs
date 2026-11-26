use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const BRIDGE_ADDRESS: &str = "127.0.0.1:47831";
const MAX_BODY: usize = 32 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserDownloadRequest {
    pub url: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

fn valid_media_url(raw: &str) -> bool {
    let value = raw.trim();
    if value.len() > 8192 || value.chars().any(char::is_control) {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://"))
        && url_host_present(value)
}

fn url_host_present(value: &str) -> bool {
    value.split_once("://").map(|(_, rest)| {
        let host = rest.split(&['/', '?', '#'][..]).next().unwrap_or("");
        !host.is_empty() && !host.starts_with('.') && !host.contains(' ')
    }).unwrap_or(false)
}

fn extension_origin(headers: &str) -> Option<&str> {
    headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("origin") && value.trim().starts_with("chrome-extension://") {
            Some(value.trim())
        } else { None }
    })
}

async fn respond(stream: &mut tokio::net::TcpStream, status: &str, body: &str, origin: Option<&str>) {
    let cors = origin.map(|value| format!(
        "Access-Control-Allow-Origin: {}\r\nVary: Origin\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nAccess-Control-Max-Age: 600\r\n",
        value
    )).unwrap_or_default();
    let response = format!(
        "HTTP/1.1 {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{}",
        status, body.len(), cors, body
    );
    let _ = stream.write_all(response.as_bytes()).await;
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(BRIDGE_ADDRESS).await {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("VANTA browser bridge unavailable on {}: {}", BRIDGE_ADDRESS, error);
                return;
            }
        };
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { continue };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let mut buffer = vec![0u8; MAX_BODY + 8192];
                let mut used = 0usize;
                loop {
                    if used == buffer.len() { break; }
                    match stream.read(&mut buffer[used..]).await {
                        Ok(0) => break,
                        Ok(n) => {
                            used += n;
                            let current = String::from_utf8_lossy(&buffer[..used]);
                            if let Some(split) = current.find("\r\n\r\n") {
                                let headers = &current[..split];
                                let content_length = headers.lines().find_map(|line| {
                                    let (name, value) = line.split_once(':')?;
                                    if name.eq_ignore_ascii_case("content-length") { value.trim().parse::<usize>().ok() } else { None }
                                }).unwrap_or(0);
                                let body_start = split + 4;
                                if used >= body_start + content_length { break; }
                            }
                        }
                        Err(_) => return,
                    }
                }

                let request = String::from_utf8_lossy(&buffer[..used]);
                let Some((headers, body)) = request.split_once("\r\n\r\n") else {
                    respond(&mut stream, "400 Bad Request", r#"{"ok":false,"error":"Malformed HTTP request"}"#, None).await;
                    return;
                };
                let origin = extension_origin(headers);
                let request_line = headers.lines().next().unwrap_or("");
                if request_line.starts_with("OPTIONS ") {
                    if let Some(origin) = origin {
                        respond(&mut stream, "204 No Content", "", Some(origin)).await;
                    } else {
                        respond(&mut stream, "403 Forbidden", r#"{"ok":false,"error":"Extension origin required"}"#, None).await;
                    }
                    return;
                }
                if !request_line.starts_with("POST /download ") || origin.is_none() {
                    respond(&mut stream, "403 Forbidden", r#"{"ok":false,"error":"Only browser extension requests are accepted"}"#, None).await;
                    return;
                }
                let content_length = headers.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    if name.eq_ignore_ascii_case("content-length") { value.trim().parse::<usize>().ok() } else { None }
                }).unwrap_or(0);
                if content_length == 0 || content_length > MAX_BODY || body.as_bytes().len() < content_length {
                    respond(&mut stream, "413 Payload Too Large", r#"{"ok":false,"error":"Invalid request size"}"#, origin).await;
                    return;
                }
                let body_bytes = &body.as_bytes()[..content_length];
                let body_text = match std::str::from_utf8(body_bytes) {
                    Ok(value) => value,
                    Err(_) => {
                        respond(&mut stream, "400 Bad Request", r#"{"ok":false,"error":"Request body must be UTF-8"}"#, origin).await;
                        return;
                    }
                };
                let payload: BrowserDownloadRequest = match serde_json::from_str(body_text) {
                    Ok(payload) => payload,
                    Err(_) => {
                        respond(&mut stream, "400 Bad Request", r#"{"ok":false,"error":"Invalid JSON payload"}"#, origin).await;
                        return;
                    }
                };
                if !valid_media_url(&payload.url) {
                    respond(&mut stream, "400 Bad Request", r#"{"ok":false,"error":"Only valid HTTP(S) URLs are accepted"}"#, origin).await;
                    return;
                }
                match app.emit("browser-download-request", payload) {
                    Ok(()) => respond(&mut stream, "200 OK", r#"{"ok":true}"#, origin).await,
                    Err(_) => respond(&mut stream, "503 Service Unavailable", r#"{"ok":false,"error":"VANTA could not receive the request"}"#, origin).await,
                }
            });
        }
    });
}

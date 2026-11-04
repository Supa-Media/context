//! A stdio MCP server that forwards each JSON-RPC line to Context over HTTP.

use std::fs;
use std::io::{BufRead, Write};
use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use reqwest::StatusCode;
use serde_json::{json, Value};
use tokio::sync::mpsc;

const TIMEOUT: Duration = Duration::from_secs(120);
const SESSION_HEADER: &str = "Mcp-Session-Id";

pub async fn run(grant_file: &Path, endpoint: &str) -> Result<()> {
    ensure_secure_endpoint(endpoint)?;
    let grant = read_grant(grant_file)?;
    let client = build_client()?;
    let lines = spawn_stdin_lines();
    let mut output = std::io::stdout();
    pump(lines, &mut output, client, endpoint, &grant).await
}

/// Reads stdin on a blocking thread. The channel closes at EOF.
fn spawn_stdin_lines() -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel(16);
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if tx.blocking_send(line).is_err() {
                break;
            }
        }
    });
    rx
}

fn build_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        // The grant must never follow a redirect to another host.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context("build HTTP client")
}

/// Forwards each input line as one POST. Requests get exactly one reply,
/// either the forwarded messages or a JSON-RPC error.
async fn pump<W: Write>(
    mut lines: mpsc::Receiver<String>,
    output: &mut W,
    client: reqwest::Client,
    endpoint: &str,
    grant: &str,
) -> Result<()> {
    let mut session: Option<String> = None;
    while let Some(line) = lines.recv().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let id = request_id(line);

        let mut req = client
            .post(endpoint)
            .header(AUTHORIZATION, format!("Bearer {grant}"))
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json, text/event-stream")
            .body(line.to_string());
        if let Some(s) = session.as_deref() {
            req = req.header(SESSION_HEADER, s);
        }

        // Status 0 means no HTTP response arrived.
        let resp = match req.send().await {
            Ok(resp) => resp,
            Err(_) => {
                fail(output, id.as_ref(), unreachable(0))?;
                continue;
            }
        };
        let status = resp.status();
        if let Some(s) = resp
            .headers()
            .get(SESSION_HEADER)
            .and_then(|v| v.to_str().ok())
        {
            session = Some(s.to_string());
        }
        if !status.is_success() {
            fail(output, id.as_ref(), unreachable(status.as_u16()))?;
            continue;
        }

        let ctype = resp
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let body = match resp.text().await {
            Ok(body) => body,
            Err(_) => {
                fail(output, id.as_ref(), unreachable(0))?;
                continue;
            }
        };
        if status == StatusCode::ACCEPTED
            || status == StatusCode::NO_CONTENT
            || body.trim().is_empty()
        {
            continue;
        }

        let messages = parse_body(&ctype, &body);
        if messages.is_empty() {
            fail(
                output,
                id.as_ref(),
                "Context sent no JSON-RPC reply".to_string(),
            )?;
            continue;
        }
        for msg in &messages {
            write_line(output, msg)?;
        }
    }
    Ok(())
}

fn parse_body(ctype: &str, body: &str) -> Vec<Value> {
    if ctype.starts_with("text/event-stream") {
        return parse_sse(body);
    }
    match serde_json::from_str::<Value>(body) {
        Ok(Value::Array(items)) => items,
        Ok(value) => vec![value],
        Err(_) => Vec::new(),
    }
}

/// The id of a request (a message with a method and a non-null id), if any.
/// Notifications and replies to the server return None, so they get no error.
fn request_id(line: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(line).ok()?;
    value.get("method")?;
    let id = value.get("id")?;
    (!id.is_null()).then(|| id.clone())
}

fn unreachable(status: u16) -> String {
    format!("Context is unreachable (HTTP {status})")
}

fn fail<W: Write>(out: &mut W, id: Option<&Value>, message: String) -> Result<()> {
    match id {
        Some(id) => {
            let reply =
                json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32000, "message": message}});
            write_line(out, &reply)
        }
        None => Ok(()),
    }
}

/// One message per line, flushed at once. Writes block; the reader is the coding CLI.
fn write_line<W: Write>(out: &mut W, msg: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(msg)?;
    bytes.push(b'\n');
    out.write_all(&bytes)?;
    out.flush()?;
    Ok(())
}

/// Collects the JSON of each `data:` event. Other fields and junk are ignored.
pub fn parse_sse(body: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut data: Vec<&str> = Vec::new();
    for line in body.lines() {
        if line.is_empty() {
            push_event(&mut data, &mut out);
        } else if line == "data" {
            data.push("");
        } else if let Some(rest) = line.strip_prefix("data:") {
            data.push(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    push_event(&mut data, &mut out);
    out
}

fn push_event(data: &mut Vec<&str>, out: &mut Vec<Value>) {
    if data.is_empty() {
        return;
    }
    let joined = data.join("\n");
    data.clear();
    if let Ok(value) = serde_json::from_str::<Value>(&joined) {
        out.push(value);
    }
}

/// Reads the grant and returns it trimmed. Refuses an empty file, a file
/// with spaces inside, and (on unix) a file readable by group or others.
pub fn read_grant(path: &Path) -> Result<String> {
    check_private(path)?;
    let raw =
        fs::read_to_string(path).with_context(|| format!("read grant file {}", path.display()))?;
    let grant = raw.trim();
    if grant.is_empty() {
        bail!("grant file {} is empty", path.display());
    }
    if grant.chars().any(|c| c.is_whitespace() || c.is_control()) {
        bail!("grant file {} must hold a single token", path.display());
    }
    Ok(grant.to_string())
}

#[cfg(unix)]
fn check_private(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path)
        .with_context(|| format!("read grant file {}", path.display()))?
        .permissions()
        .mode();
    if mode & 0o077 != 0 {
        bail!(
            "grant file {} is readable by other users; run chmod 600",
            path.display()
        );
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_private(_path: &Path) -> Result<()> {
    Ok(())
}

/// The grant is a bearer token, so plain http is allowed only for loopback.
pub fn ensure_secure_endpoint(endpoint: &str) -> Result<()> {
    let url = reqwest::Url::parse(endpoint).context("endpoint is not a valid URL")?;
    let loopback = matches!(
        url.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("[::1]")
    );
    match url.scheme() {
        "https" => Ok(()),
        "http" if loopback => Ok(()),
        _ => bail!("endpoint must be https:// (plain http is allowed only for localhost)"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{TcpListener, TcpStream};

    #[test]
    fn sse_single_event() {
        let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n";
        assert_eq!(
            parse_sse(body),
            vec![json!({"jsonrpc": "2.0", "id": 1, "result": {}})]
        );
    }

    #[test]
    fn sse_multiple_events() {
        let body = "data: {\"id\":1}\n\ndata: {\"id\":2}\n\n";
        assert_eq!(parse_sse(body), vec![json!({"id": 1}), json!({"id": 2})]);
    }

    #[test]
    fn sse_multi_line_data_is_joined_with_newlines() {
        let body = "data: {\"a\":\ndata: 1}\n\n";
        assert_eq!(parse_sse(body), vec![json!({"a": 1})]);
    }

    #[test]
    fn sse_ignores_junk_comments_and_unterminated_tail() {
        let body = ": ping\n\ndata: not json\n\ndata: {\"ok\":true}";
        assert_eq!(parse_sse(body), vec![json!({"ok": true})]);
    }

    #[test]
    fn https_and_loopback_endpoints_allowed() {
        assert!(ensure_secure_endpoint("https://context.example/mcp").is_ok());
        assert!(ensure_secure_endpoint("http://127.0.0.1:9/mcp").is_ok());
        assert!(ensure_secure_endpoint("http://localhost:9/mcp").is_ok());
    }

    #[test]
    fn plain_http_elsewhere_refused() {
        assert!(ensure_secure_endpoint("http://context.example/mcp").is_err());
        assert!(ensure_secure_endpoint("http://127.0.0.1.example.com/mcp").is_err());
        assert!(ensure_secure_endpoint("ftp://context.example/mcp").is_err());
        assert!(ensure_secure_endpoint("not a url").is_err());
    }

    #[cfg(unix)]
    fn grant_file(content: &str, mode: u32) -> (tempfile::TempDir, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("grant");
        fs::write(&path, content).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        (dir, path)
    }

    #[cfg(unix)]
    #[test]
    fn grant_0600_is_read_and_trimmed() {
        let (_dir, path) = grant_file("  test-grant\n", 0o600);
        assert_eq!(read_grant(&path).unwrap(), "test-grant");
    }

    #[cfg(unix)]
    #[test]
    fn grant_readable_by_others_is_refused() {
        let (_dir, path) = grant_file("test-grant\n", 0o644);
        let err = read_grant(&path).unwrap_err().to_string();
        assert!(err.contains("chmod 600"));
        assert!(!err.contains("test-grant"));
    }

    #[cfg(unix)]
    #[test]
    fn empty_grant_is_refused() {
        let (_dir, path) = grant_file(" \n\t", 0o600);
        assert!(read_grant(&path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn grant_with_inner_space_is_refused() {
        let (_dir, path) = grant_file("two words\n", 0o600);
        assert!(read_grant(&path).is_err());
    }

    /// Reads one HTTP/1.1 request; returns its lowercased headers.
    async fn read_request(sock: &mut BufReader<TcpStream>) -> Option<HashMap<String, String>> {
        let mut headers = HashMap::new();
        loop {
            let mut line = String::new();
            if sock.read_line(&mut line).await.ok()? == 0 {
                return None;
            }
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            if let Some((k, v)) = line.split_once(':') {
                headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
            }
        }
        let len: usize = headers
            .get("content-length")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let mut body = vec![0u8; len];
        sock.read_exact(&mut body).await.ok()?;
        Some(headers)
    }

    /// Replies: 200 with a session id, 202, then 500. Returns what it saw.
    async fn fake_context(listener: TcpListener) -> Vec<(Option<String>, Option<String>)> {
        let (sock, _) = listener.accept().await.unwrap();
        let mut sock = BufReader::new(sock);
        let mut seen = Vec::new();
        while let Some(headers) = read_request(&mut sock).await {
            seen.push((
                headers.get("authorization").cloned(),
                headers.get("mcp-session-id").cloned(),
            ));
            let reply = match seen.len() {
                1 => {
                    let body = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMcp-Session-Id: sess-1\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    )
                }
                2 => "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n".to_string(),
                _ => "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n".to_string(),
            };
            sock.get_mut().write_all(reply.as_bytes()).await.unwrap();
        }
        seen
    }

    #[tokio::test]
    async fn forwards_lines_with_auth_and_session_and_reports_errors() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
        let server = tokio::spawn(fake_context(listener));

        let input = concat!(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
            "\n",
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/list"}"#,
            "\n",
        );
        let (tx, rx) = mpsc::channel(16);
        for line in input.lines() {
            tx.send(line.to_string()).await.unwrap();
        }
        drop(tx);
        let mut output = Vec::new();
        pump(
            rx,
            &mut output,
            build_client().unwrap(),
            &endpoint,
            "test-grant",
        )
        .await
        .unwrap();

        let seen = server.await.unwrap();
        assert_eq!(seen.len(), 3);
        assert_eq!(seen[0].0.as_deref(), Some("Bearer test-grant"));
        assert_eq!(seen[0].1, None);
        assert_eq!(seen[1].1.as_deref(), Some("sess-1"));
        assert_eq!(seen[2].1.as_deref(), Some("sess-1"));

        let text = String::from_utf8(output).unwrap();
        assert!(!text.contains("test-grant"));
        let lines: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["id"], 1);
        assert_eq!(lines[1]["id"], 3);
        assert_eq!(lines[1]["error"]["code"], -32000);
        assert_eq!(
            lines[1]["error"]["message"],
            "Context is unreachable (HTTP 500)"
        );
    }
}

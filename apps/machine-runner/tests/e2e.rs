//! The runner against a fake workspace object and a fake `claude`.
//!
//! Proves the whole path offline: the runner signs the challenge with its key,
//! takes an assignment, runs the CLI in a worktree under the allowed folder,
//! streams steps, survives the socket dropping mid-job, says on reconnect that
//! the same session is still running, delivers the result, and deletes the run
//! grant afterwards. Also: an assignment outside the folder allowlist is
//! refused on the machine, and mail reaches a running session.

#![cfg(unix)]
#![allow(clippy::result_large_err)]

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

/// A stand-in `claude`: answers `auth status`, reads stream-json from stdin,
/// prints an init with the session id it was given, a tool step, waits as the
/// brief says, echoes any mail it was sent, then a result.
const FAKE_CLAUDE: &str = r#"#!/bin/bash
if [ "$1" = "auth" ]; then echo '{"loggedIn": true}'; exit 0; fi
sid=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--session-id" ] || [ "$prev" = "--resume" ]; then sid="$a"; fi
  prev="$a"
done
pwd > "$FAKE_LOG.cwd"
printf '%s\n' "$@" > "$FAKE_LOG.argv"
echo "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"$sid\"}"
IFS= read -r first
echo "$first" > "$FAKE_LOG.first"
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"SECRET=x cargo test"}}]}}'
secs=$(echo "$first" | sed -n 's/.*sleep:\([0-9]*\).*/\1/p')
[ -n "$secs" ] && sleep "$secs"
extra=""
while IFS= read -r -t 1 line; do extra="$line"; done
res="all done"
case "$extra" in *Mail*vouch*) res="got mail";; esac
echo "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"$res\",\"usage\":{\"input_tokens\":5,\"output_tokens\":7}}"
"#;

struct Rig {
    _tmp: tempfile::TempDir,
    state: PathBuf,
    repo: PathBuf,
    outside: PathBuf,
    bin: PathBuf,
    log: PathBuf,
}

fn rig() -> Rig {
    let tmp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let state = root.join("state");
    let repo = root.join("code/repo");
    let outside = root.join("private");
    let bin = root.join("bin");
    for d in [&state, &repo, &outside, &bin] {
        std::fs::create_dir_all(d).unwrap();
    }
    std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700)).unwrap();
    let claude = bin.join("claude");
    std::fs::write(&claude, FAKE_CLAUDE).unwrap();
    std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec![
            "-c",
            "user.email=t@example.com",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
        ],
    ] {
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(&args)
            .status()
            .unwrap()
            .success());
    }
    // The grant and rules the runner would have after pairing.
    write_0600(&state.join("grant"), "machine-grant");
    write_0600(
        &state.join("rules.json"),
        &json!({ "folders": [root.join("code")], "slots": 2 }).to_string(),
    );
    Rig {
        log: root.join("fake"),
        _tmp: tmp,
        state,
        repo,
        outside,
        bin,
    }
}

fn write_0600(p: &Path, s: &str) {
    std::fs::write(p, s).unwrap();
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600)).unwrap();
}

fn start_runner(r: &Rig, port: u16) -> tokio::process::Child {
    let path = format!(
        "{}:{}",
        r.bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    tokio::process::Command::new(env!("CARGO_BIN_EXE_context-machine"))
        .args([
            "--dir",
            r.state.to_str().unwrap(),
            "run",
            "--no-keep-awake",
            "--name",
            "test-vm",
            "--endpoint",
            &format!("http://127.0.0.1:{port}"),
        ])
        .env("PATH", path)
        .env("FAKE_LOG", &r.log)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}

type Ws = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

async fn accept(l: &TcpListener) -> (Ws, Value) {
    let (tcp, _) = tokio::time::timeout(Duration::from_secs(20), l.accept())
        .await
        .expect("runner dialled")
        .unwrap();
    let mut auth = None;
    let ws = tokio_tungstenite::accept_hdr_async(
        tcp,
        |req: &tokio_tungstenite::tungstenite::handshake::server::Request, resp| {
            assert_eq!(req.uri().path(), "/machines/socket");
            auth = req
                .headers()
                .get("authorization")
                .map(|v| v.to_str().unwrap().to_string());
            Ok(resp)
        },
    )
    .await
    .unwrap();
    assert_eq!(auth.as_deref(), Some("Bearer machine-grant"));
    let mut ws = ws;
    let nonce = "nonce-0123456789abcdef";
    ws.send(Message::Text(
        json!({"type":"challenge","nonce":nonce}).to_string(),
    ))
    .await
    .unwrap();
    let hello = next(&mut ws, "hello").await;
    let pk: [u8; 32] = URL_SAFE_NO_PAD
        .decode(hello["publicKey"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let sig = URL_SAFE_NO_PAD
        .decode(hello["signature"].as_str().unwrap())
        .unwrap();
    let vk = ed25519_dalek::VerifyingKey::from_bytes(&pk).unwrap();
    assert!(
        vk.verify_strict(
            nonce.as_bytes(),
            &ed25519_dalek::Signature::from_slice(&sig).unwrap()
        )
        .is_ok(),
        "hello must be signed by the machine key"
    );
    (ws, hello)
}

async fn next(ws: &mut Ws, kind: &str) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(30), ws.next())
            .await
            .unwrap_or_else(|_| panic!("waiting for {kind}"))
            .unwrap()
            .unwrap();
        if let Message::Text(t) = msg {
            let v: Value = serde_json::from_str(&t).unwrap();
            if v["type"] == kind {
                return v;
            }
        }
    }
}

fn assignment(job: &str, folder: &Path, brief: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    json!({
        "type": "assign", "jobId": job, "part": 1, "cli": "claude", "brief": brief,
        "folder": folder, "workdir": "worktree", "runGrant": "RUN-GRANT-SENTINEL",
        "endpoint": "https://context.example/mcp", "deadlineAt": now + 600_000, "own": true
    })
    .to_string()
}

#[tokio::test]
async fn pairs_runs_survives_a_drop_and_resumes_the_same_session() {
    let r = rig();
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let mut runner = start_runner(&r, port);

    let (mut ws, hello) = accept(&l).await;
    assert_eq!(hello["facts"]["claude"], "signedIn");
    assert_eq!(hello["running"], json!([]));

    // Outside the allowlist: refused on the machine, nothing runs.
    ws.send(Message::Text(assignment(
        "job_out",
        &r.outside,
        "read their files",
    )))
    .await
    .unwrap();
    let refused = next(&mut ws, "refused").await;
    assert_eq!(refused["reason"], "folderNotAllowed");

    ws.send(Message::Text(assignment(
        "job_1",
        &r.repo,
        "fix it sleep:4",
    )))
    .await
    .unwrap();
    next(&mut ws, "accepted").await;
    let step = next(&mut ws, "step").await;
    assert_eq!(
        (
            step["tool"].as_str(),
            step["action"].as_str(),
            step["target"].as_str()
        ),
        (Some("shell"), Some("run"), Some("cargo"))
    );

    // The run grant is in a 0600 file while the part runs, never in argv.
    let mcp = r.state.join("runs/job_1/mcp.json");
    assert_eq!(
        std::fs::metadata(&mcp).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let argv = std::fs::read_to_string(r.log.with_extension("argv")).unwrap();
    assert!(!argv.contains("RUN-GRANT-SENTINEL") && !argv.contains("fix it"));
    let cwd = std::fs::read_to_string(r.log.with_extension("cwd")).unwrap();
    assert!(
        Path::new(cwd.trim()).starts_with(r.repo.parent().unwrap().join(".context-machine-work")),
        "ran in {cwd}"
    );

    // The socket drops mid-job. The part keeps running.
    drop(ws);
    let (mut ws, hello) = accept(&l).await;
    let running = hello["running"].as_array().unwrap();
    assert_eq!(running.len(), 1, "{hello}");
    assert_eq!(running[0]["jobId"], "job_1");
    assert_eq!(running[0]["alive"], true);
    let session = running[0]["sessionId"].as_str().unwrap().to_string();
    assert!(!session.is_empty());
    assert_eq!(running[0]["lastStep"], "shell run cargo");

    let result = next(&mut ws, "result").await;
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["answer"], "all done");
    assert_eq!(result["sessionId"], session);
    assert!(!mcp.exists(), "the run grant is deleted when the part ends");

    // Unacked, the result is sent again after the next hello; acked, it is not.
    drop(ws);
    let (mut ws, hello) = accept(&l).await;
    assert_eq!(hello["running"][0]["alive"], false);
    next(&mut ws, "result").await;
    ws.send(Message::Text(
        json!({"type":"ack","jobId":"job_1","part":1}).to_string(),
    ))
    .await
    .unwrap();

    // Part 2 resumes the same session in the same worktree.
    let mut a: Value = serde_json::from_str(&assignment("job_1", &r.repo, "keep going")).unwrap();
    a["part"] = json!(2);
    a["resumeSessionId"] = json!(session);
    ws.send(Message::Text(a.to_string())).await.unwrap();
    next(&mut ws, "result").await;
    let argv = std::fs::read_to_string(r.log.with_extension("argv")).unwrap();
    assert!(argv.contains(&format!("--resume\n{session}")), "{argv}");

    // Released with no work in it, the worktree goes.
    ws.send(Message::Text(
        json!({"type":"release","jobId":"job_1"}).to_string(),
    ))
    .await
    .unwrap();
    let released = next(&mut ws, "released").await;
    assert_eq!(released["kept"], false);
    assert!(!r
        .repo
        .parent()
        .unwrap()
        .join(".context-machine-work/job_1")
        .exists());
    let _ = runner.kill().await;
}

#[tokio::test]
async fn mail_reaches_a_running_session() {
    let r = rig();
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut runner = start_runner(&r, l.local_addr().unwrap().port());
    let (mut ws, _) = accept(&l).await;
    ws.send(Message::Text(assignment("job_m", &r.repo, "work sleep:2")))
        .await
        .unwrap();
    next(&mut ws, "step").await;
    ws.send(Message::Text(json!({"type":"message","jobId":"job_m","mail":{"from":"vm-2","kind":"note","text":"types moved"}}).to_string())).await.unwrap();
    let result = next(&mut ws, "result").await;
    // The fake CLI answers "got mail" only if a [Mail] line reached its stdin.
    assert_eq!(result["answer"], "got mail", "{result}");
    let _ = runner.kill().await;
}

/// The same path with the real `claude` signed in on this machine. Run by hand:
/// `cargo test --test e2e live_claude -- --ignored --nocapture`.
#[tokio::test]
#[ignore]
async fn live_claude() {
    let r = rig();
    std::fs::remove_file(r.bin.join("claude")).unwrap();
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut runner = start_runner(&r, l.local_addr().unwrap().port());
    let (mut ws, hello) = accept(&l).await;
    assert_eq!(
        hello["facts"]["claude"], "signedIn",
        "sign in to Claude Code first"
    );
    ws.send(Message::Text(assignment("job_live", &r.repo, "Create a file hello.txt containing the word hi, commit it with git, then reply with the commit's short hash."))).await.unwrap();
    let started = std::time::Instant::now();
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(300), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let Message::Text(t) = msg else { continue };
        let v: Value = serde_json::from_str(&t).unwrap();
        println!("{:>5.1}s {}", started.elapsed().as_secs_f32(), v);
        if v["type"] == "result" {
            assert_eq!(v["ok"], true);
            break;
        }
    }
    ws.send(Message::Text(
        json!({"type":"release","jobId":"job_live"}).to_string(),
    ))
    .await
    .unwrap();
    let released = next(&mut ws, "released").await;
    println!("{released}");
    assert_eq!(
        released["kept"], true,
        "a worktree with a commit is kept for the person"
    );
    let _ = runner.kill().await;
}

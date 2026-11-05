//! The runner against a fake workspace object and a fake `claude`.
//!
//! Proves the whole path offline, in the frames of the published protocol
//! schema: the runner signs the challenge with its key, takes an assignment,
//! runs the CLI plainly in the named checkout under the allowed folder (or
//! the folder itself when the repo is not there yet), streams steps,
//! survives the socket dropping mid-job, says on reconnect that the same
//! session is still running, delivers the result, sends it again while the
//! workspace object still wants it, and deletes the run grant afterwards.
//! Also: an assignment outside the folder allowlist is refused on the
//! machine, mail reaches a running session, and a goodbye stops the runner.

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
    root: PathBuf,
    state: PathBuf,
    repo: PathBuf,
    outside: PathBuf,
    bin: PathBuf,
    log: PathBuf,
}

const MACHINE: &str = "m_test";

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
    // What the runner has after pairing.
    write_0600(&state.join("grant"), "machine-grant-0123456789");
    write_0600(
        &state.join("machine.json"),
        &json!({ "machineId": MACHINE, "name": "test-vm" }).to_string(),
    );
    Rig {
        log: root.join("fake"),
        root,
        _tmp: tmp,
        state,
        repo,
        outside,
        bin,
    }
}

fn rules(r: &Rig) -> Value {
    json!({
        "folders": [r.root.join("code")], "tools": ["claude"], "computerUse": false,
        "limits": { "slots": 2, "dayMs": 14_400_000u64, "weekMs": 72_000_000u64, "othersDayMs": 7_200_000u64,
                    "othersRunsPerDay": 10, "longestRunMs": 14_400_000u64, "pauseNearPlanLimit": true }
    })
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
            "--data-dir",
            r.state.to_str().unwrap(),
            "run",
            "--no-keep-awake",
            "--status-json",
            "--socket-url",
            &format!("ws://127.0.0.1:{port}/machines/socket"),
        ])
        .env("PATH", path)
        .env("FAKE_LOG", &r.log)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}

type Ws = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// The machine's public key, from the private key the runner made.
fn machine_key(r: &Rig) -> ed25519_dalek::VerifyingKey {
    let raw = std::fs::read_to_string(r.state.join("key")).unwrap();
    let bytes: [u8; 32] = URL_SAFE_NO_PAD
        .decode(raw.trim())
        .unwrap()
        .try_into()
        .unwrap();
    ed25519_dalek::SigningKey::from_bytes(&bytes).verifying_key()
}

/// Accepts a dial, checks the grant and the signed hello, and answers with a
/// welcome that keeps `keep`.
async fn accept(r: &Rig, l: &TcpListener, keep: &[&str]) -> (Ws, Value) {
    let (tcp, _) = tokio::time::timeout(Duration::from_secs(20), l.accept())
        .await
        .expect("runner dialled")
        .unwrap();
    let mut auth = None;
    let mut ws = tokio_tungstenite::accept_hdr_async(
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
    assert_eq!(auth.as_deref(), Some("Bearer machine-grant-0123456789"));
    let nonce = "nonce_0123456789abcdef0123456789abcdef";
    ws.send(Message::Text(
        json!({"type":"challenge","protocol":1,"nonce":nonce}).to_string(),
    ))
    .await
    .unwrap();
    let hello = next(&mut ws, "hello").await;
    assert_eq!(
        (hello["protocol"].as_u64(), hello["machineId"].as_str()),
        (Some(1), Some(MACHINE))
    );
    let sig = URL_SAFE_NO_PAD
        .decode(hello["signature"].as_str().unwrap())
        .unwrap();
    let text = format!("context-machine-hello:v1:{MACHINE}:{nonce}");
    assert!(
        machine_key(r)
            .verify_strict(
                text.as_bytes(),
                &ed25519_dalek::Signature::from_slice(&sig).unwrap()
            )
            .is_ok(),
        "hello must be signed by the machine key over the hello text"
    );
    ws.send(Message::Text(
        json!({"type":"welcome","machineId":MACHINE,"rules":rules(r),"keepRuns":keep}).to_string(),
    ))
    .await
    .unwrap();
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

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn assignment(run: &str, job: &str, folder: &Path, brief: &str) -> Value {
    json!({
        "type": "assign", "runId": run, "jobId": job, "part": 1, "tool": "claude", "folder": folder, "repo": "repo",
        "permission": "full", "brief": brief, "doneWhen": "",
        "grant": { "token": "RUN-GRANT-SENTINEL", "expiresAt": now_ms() + 600_000, "mcpUrl": "https://context.example/mcp" },
        "deadline": now_ms() + 600_000, "fromOwner": true, "network": true, "helpers": true, "computerUse": false
    })
}

async fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string())).await.unwrap();
}

#[tokio::test]
async fn pairs_runs_survives_a_drop_and_resumes_the_same_session() {
    let r = rig();
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let mut runner = start_runner(&r, port);

    let (mut ws, hello) = accept(&r, &l, &[]).await;
    let claude = hello["facts"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "claude")
        .unwrap()
        .clone();
    assert_eq!(claude["signedIn"], true, "{hello}");
    assert_eq!(hello["runs"], json!([]));

    // Outside the allowlist: refused on the machine, nothing runs.
    let mut out = assignment("run_out", "job_out", &r.outside, "read their files");
    out["repo"] = Value::Null;
    out.as_object_mut().unwrap().remove("repo");
    send(&mut ws, out).await;
    let refused = next(&mut ws, "refuse").await;
    assert_eq!(
        (refused["runId"].as_str(), refused["code"].as_str()),
        (Some("run_out"), Some("folder"))
    );

    send(
        &mut ws,
        assignment("run_1", "job_1", &r.repo, "fix it sleep:4"),
    )
    .await;
    next(&mut ws, "accept").await;
    let session = next(&mut ws, "session").await["session"]
        .as_str()
        .unwrap()
        .to_string();
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
    let mcp = r.state.join("runs/run_1/mcp.json");
    assert_eq!(
        std::fs::metadata(&mcp).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let argv = std::fs::read_to_string(r.log.with_extension("argv")).unwrap();
    assert!(!argv.contains("RUN-GRANT-SENTINEL") && !argv.contains("fix it"));
    let cwd = std::fs::read_to_string(r.log.with_extension("cwd")).unwrap();
    // Plain Claude Code: in their own checkout, no copy made beside it.
    assert_eq!(Path::new(cwd.trim()), r.repo, "ran in {cwd}");

    // The socket drops mid-job. The part keeps running.
    drop(ws);
    let (mut ws, hello) = accept(&r, &l, &["run_1"]).await;
    let runs = hello["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1, "{hello}");
    assert_eq!(
        (runs[0]["runId"].as_str(), runs[0]["alive"].as_bool()),
        (Some("run_1"), Some(true))
    );
    assert_eq!(runs[0]["session"].as_str(), Some(session.as_str()));
    assert!(runs[0]["lastStep"].as_u64().unwrap() >= 1);

    let result = next(&mut ws, "result").await;
    assert_eq!(
        (result["outcome"].as_str(), result["answer"].as_str()),
        (Some("finished"), Some("all done")),
        "{result}"
    );
    assert_eq!(result["session"].as_str(), Some(session.as_str()));
    assert!(
        result.get("branch").is_none(),
        "no branch is made: {result}"
    );
    assert!(!mcp.exists(), "the run grant is deleted when the part ends");
    assert!(
        !r.root.join("code/.context-machine-work").exists(),
        "nothing is copied into the folder"
    );

    // Still wanted, the result is sent again after the next hello.
    drop(ws);
    let (mut ws, hello) = accept(&r, &l, &["run_1"]).await;
    assert_eq!(hello["runs"][0]["alive"], false);
    next(&mut ws, "result").await;
    // No longer wanted, it is forgotten.
    drop(ws);
    let (ws, _) = accept(&r, &l, &[]).await;
    drop(ws);
    let (mut ws2, hello) = accept(&r, &l, &[]).await;
    assert_eq!(hello["runs"], json!([]), "{hello}");

    // Part 2 resumes the same session.
    let mut a = assignment("run_2", "job_1", &r.repo, "keep going");
    a["part"] = json!(2);
    a["resumeSession"] = json!(session);
    send(&mut ws2, a).await;
    let result = next(&mut ws2, "result").await;
    assert_eq!(result["outcome"], "finished", "{result}");
    let argv = std::fs::read_to_string(r.log.with_extension("argv")).unwrap();
    assert!(argv.contains(&format!("--resume\n{session}")), "{argv}");

    // A goodbye for a revoked grant stops the runner and deletes the grant.
    send(&mut ws2, json!({"type":"goodbye","reason":"revoked"})).await;
    let status = tokio::time::timeout(Duration::from_secs(10), runner.wait())
        .await
        .expect("runner stopped")
        .unwrap();
    assert!(!status.success());
    assert!(!r.state.join("grant").exists());
    let mut lines = String::new();
    use tokio::io::AsyncReadExt;
    runner
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut lines)
        .await
        .unwrap();
    let states: Vec<String> = lines
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .map(|v| v["state"].as_str().unwrap_or("").to_string())
        .collect();
    assert_eq!(
        states.first().map(String::as_str),
        Some("starting"),
        "{lines}"
    );
    assert!(states.iter().any(|s| s == "online"), "{lines}");
    assert_eq!(states.last().map(String::as_str), Some("failed"), "{lines}");
    let _ = ws;
}

// 2026-11-04: the job named `context`, the allowed folder held no such repo,
// and every part failed "repo not found in the folder" before Claude Code ran.
#[tokio::test]
async fn a_repo_missing_from_the_folder_still_runs_in_the_folder() {
    let r = rig();
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut runner = start_runner(&r, l.local_addr().unwrap().port());
    let (mut ws, _) = accept(&r, &l, &[]).await;
    let folder = r.root.join("code");
    let mut a = assignment("run_c", "job_c", &folder, "summarize the last PR");
    a["repo"] = json!("context");
    send(&mut ws, a).await;
    let result = next(&mut ws, "result").await;
    assert_eq!(result["outcome"], "finished", "{result}");
    let cwd = std::fs::read_to_string(r.log.with_extension("cwd")).unwrap();
    assert_eq!(Path::new(cwd.trim()), folder, "ran in {cwd}");
    // The part cloned it. The next part resumes its session where it started,
    // not inside the clone, where Claude Code would not find the session.
    std::fs::create_dir_all(folder.join("context/.git")).unwrap();
    let mut b = assignment("run_c2", "job_c", &folder, "keep going");
    b["repo"] = json!("context");
    b["part"] = json!(2);
    b["resumeSession"] = result["session"].clone();
    send(&mut ws, b).await;
    let result = next(&mut ws, "result").await;
    assert_eq!(result["outcome"], "finished", "{result}");
    let cwd = std::fs::read_to_string(r.log.with_extension("cwd")).unwrap();
    assert_eq!(Path::new(cwd.trim()), folder, "resumed in {cwd}");
    let _ = runner.kill().await;
}

#[tokio::test]
async fn mail_reaches_a_running_session() {
    let r = rig();
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut runner = start_runner(&r, l.local_addr().unwrap().port());
    let (mut ws, _) = accept(&r, &l, &[]).await;
    send(
        &mut ws,
        assignment("run_m", "job_m", &r.repo, "work sleep:2"),
    )
    .await;
    next(&mut ws, "step").await;
    send(&mut ws, json!({"type":"message","runId":"run_m","messageId":"msg_1","kind":"note","from":"vm-2","text":"types moved"})).await;
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
    let (mut ws, _) = accept(&r, &l, &[]).await;
    send(&mut ws, assignment("run_live", "job_live", &r.repo, "Create a file hello.txt containing the word hi, commit it with git, then reply with the commit's short hash.")).await;
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
            assert_eq!(v["outcome"], "finished");
            assert!(
                r.repo.join("hello.txt").exists(),
                "worked in their checkout"
            );
            break;
        }
    }
    let _ = runner.kill().await;
}

//! Signing a coding tool in from the app, with no terminal (the owner,
//! 2026-11-05: "I should be able to log in through the app and the hub").
//!
//! The owner taps Sign in; the workspace object sends `signIn` without a code.
//! The runner starts the tool's own sign-in (`claude auth login`), which
//! prints a link to Claude's sign-in page and then waits for the code that
//! page shows. The runner sends that link back (`signInState` `link`); the
//! owner opens it on any device, signs in there, and pastes the code into the
//! app, which reaches the runner as `signIn` with a code. The runner types it
//! into the waiting sign-in and reports `done` or `failed`, then a fresh status.
//!
//! Codex signs in the other way round (`codex login --device-auth`): it prints
//! its sign-in page and a one-time code, and the owner types that code on the
//! page; nothing comes back to the computer but the finished sign-in. The
//! runner sends both in `link` (`userCode`) and waits for Codex to finish.
//!
//! The code is never written down: not to disk, not to a log, not into an
//! error the runner sends (`failure_of` strips it). The link is only ever one
//! on the tool maker's own site (`link_in`). Only one sign-in per tool runs at
//! once; a new one ends the old.

use crate::protocol::{RunnerMsg, SignInState, SignInStep, Tool};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

/// How long the tool may take to print its link.
pub const LINK_WAIT: Duration = Duration::from_secs(30);
/// How long the owner has to paste the code.
pub const CODE_WAIT: Duration = Duration::from_secs(15 * 60);
/// How long the tool may take to finish once it has the code.
pub const FINISH_WAIT: Duration = Duration::from_secs(60);

/// The sites a sign-in link may point at: the tool maker's own.
fn link_hosts(tool: Tool) -> &'static [&'static str] {
    match tool {
        Tool::Claude => &["claude.com", "claude.ai", "anthropic.com"],
        Tool::Codex => &["openai.com", "chatgpt.com"],
    }
}

/// The command that signs a tool in, or None when the runner can't do it from the app.
pub fn command(tool: Tool) -> Option<(&'static str, &'static [&'static str])> {
    match tool {
        Tool::Claude => Some(("claude", &["auth", "login"])),
        Tool::Codex => Some(("codex", &["login", "--device-auth"])),
    }
}

/// Whether the tool's sign-in shows a code to type on its page (a device
/// sign-in) rather than one to paste back.
pub fn device_flow(tool: Tool) -> bool {
    tool == Tool::Codex
}

/// What a terminal would show: colour and cursor codes taken out.
pub fn plain(output: &str) -> String {
    let mut text = String::with_capacity(output.len());
    let mut chars = output.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            } else {
                chars.next();
            }
        } else {
            text.push(c);
        }
    }
    text
}

/// The one-time code a device sign-in printed: a word like `7K2Q-M9XFD`.
pub fn user_code_in(output: &str) -> Option<String> {
    let text = plain(output);
    let after = text
        .to_ascii_lowercase()
        .find("one-time code")
        .map(|i| &text[i..])
        .unwrap_or(&text);
    after.split_whitespace().find_map(|w| {
        let w = w.trim_matches(|c: char| !c.is_ascii_alphanumeric());
        let mut parts = w.split('-');
        let ok = w.len() <= 16
            && parts.clone().count() == 2
            && parts.all(|p| {
                (3..=8).contains(&p.len())
                    && p.chars()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
            });
        ok.then(|| w.to_string())
    })
}

/// The sign-in link in what the tool printed: the first https link on the
/// maker's own site. Anything else (another site, a lookalike host) is no link.
pub fn link_in(output: &str, tool: Tool) -> Option<String> {
    let text = plain(output);
    for word in text.split_whitespace() {
        let Some(rest) = word.strip_prefix("https://") else {
            continue;
        };
        let host = rest
            .split(['/', '?', '#'])
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        let ours = link_hosts(tool)
            .iter()
            .any(|h| host == *h || host.ends_with(&format!(".{h}")));
        if ours && word.len() <= 2048 {
            return Some(word.to_string());
        }
    }
    None
}

/// A code as the protocol allows it (`SignIn.code`): one line, no spaces.
pub fn valid_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= 512
        && code
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "#_.~-".contains(c))
}

/// Why a sign-in failed, in the tool's own words when it said, never with the code in it.
pub fn failure_of(output: &str, code: Option<&str>) -> String {
    let line = output
        .lines()
        .flat_map(|l| l.split(" > "))
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.contains("https://"))
        .collect::<Vec<_>>()
        .into_iter()
        .rfind(|l| {
            let l = l.to_ascii_lowercase();
            l.contains("fail")
                || l.contains("error")
                || l.contains("wasn't")
                || l.contains("invalid")
        })
        .unwrap_or("The sign-in didn't finish.");
    let mut text = line.to_string();
    if let Some(code) = code.filter(|c| !c.is_empty()) {
        text = text.replace(code, "…");
    }
    text.chars().take(300).collect()
}

fn state(id: &str, tool: Tool, step: SignInStep) -> SignInState {
    SignInState {
        sign_in_id: id.to_string(),
        tool,
        state: step,
        url: None,
        user_code: None,
        error: None,
    }
}

fn failed(id: &str, tool: Tool, error: &str) -> RunnerMsg {
    RunnerMsg::SignInState(SignInState {
        error: Some(error.chars().take(300).collect()),
        ..state(id, tool, SignInStep::Failed)
    })
}

/// Runs one sign-in to its end. `program` is the tool's path; `code` brings the
/// owner's code, and is dropped (the sign-in ended) when a newer one replaces it.
/// Sends `link`, then `done` or `failed`; the caller sends the status after.
pub async fn run(
    program: PathBuf,
    args: &[&str],
    id: String,
    tool: Tool,
    code: oneshot::Receiver<String>,
    out: mpsc::Sender<RunnerMsg>,
) -> bool {
    let spawned = tokio::process::Command::new(&program)
        .args(args)
        // The link goes to the app; nothing opens a browser on this computer.
        .env("BROWSER", "true")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(_) => {
            let _ = out
                .send(failed(
                    &id,
                    tool,
                    "Couldn't start the sign-in on this computer.",
                ))
                .await;
            return false;
        }
    };
    let mut stdin = child.stdin.take();
    let (text_tx, mut text_rx) = mpsc::channel::<String>(64);
    for pipe in [
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = text_tx.clone();
        tokio::spawn(async move {
            let mut pipe = pipe;
            let mut buf = [0u8; 4096];
            while let Ok(n) = pipe.read(&mut buf).await {
                if n == 0
                    || tx
                        .send(String::from_utf8_lossy(&buf[..n]).to_string())
                        .await
                        .is_err()
                {
                    break;
                }
            }
        });
    }
    drop(text_tx);
    let mut seen = String::new();

    // 1. The link.
    let link = tokio::time::timeout(LINK_WAIT, async {
        while let Some(chunk) = text_rx.recv().await {
            seen.push_str(&chunk);
            if seen.len() > 64 * 1024 {
                break;
            }
            if let Some(url) = link_in(&seen, tool) {
                if !device_flow(tool) {
                    return Some((url, None));
                }
                if let Some(user_code) = user_code_in(&seen) {
                    return Some((url, Some(user_code)));
                }
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    let Some((url, user_code)) = link else {
        let _ = out.send(failed(&id, tool, &failure_of(&seen, None))).await;
        return false;
    };
    let device = user_code.is_some();
    let _ = out
        .send(RunnerMsg::SignInState(SignInState {
            url: Some(url),
            user_code,
            ..state(&id, tool, SignInStep::Link)
        }))
        .await;

    // A device sign-in: the owner types the code on the maker's page; the tool
    // finishes by itself. A newer sign-in replacing this one ends it.
    if device {
        let mut code = code;
        let mut listening = true;
        let finished = tokio::time::timeout(CODE_WAIT, async {
            loop {
                tokio::select! {
                    status = child.wait() => break Some(status),
                    replaced = &mut code, if listening => {
                        // A code isn't part of a device sign-in; only a replacement ends it.
                        if replaced.is_err() {
                            break None;
                        }
                        listening = false;
                    }
                }
            }
        })
        .await;
        let status = match finished {
            Ok(Some(status)) => status,
            Ok(None) => return false,
            Err(_) => {
                let _ = out
                    .send(failed(&id, tool, "The sign-in timed out. Start again."))
                    .await;
                return false;
            }
        };
        while let Ok(Some(chunk)) =
            tokio::time::timeout(Duration::from_millis(200), text_rx.recv()).await
        {
            seen.push_str(&chunk);
        }
        let ok = matches!(status, Ok(s) if s.success());
        let msg = if ok {
            RunnerMsg::SignInState(state(&id, tool, SignInStep::Done))
        } else {
            failed(&id, tool, &failure_of(&plain(&seen), None))
        };
        let _ = out.send(msg).await;
        return ok;
    }

    // 2. The owner's code, typed into the waiting sign-in.
    let code = match tokio::time::timeout(CODE_WAIT, code).await {
        Ok(Ok(code)) if valid_code(&code) => code,
        Ok(Ok(_)) => {
            let _ = out
                .send(failed(
                    &id,
                    tool,
                    "That code doesn't look right. Start again.",
                ))
                .await;
            return false;
        }
        // Replaced by a newer sign-in: that one reports.
        Ok(Err(_)) => return false,
        Err(_) => {
            let _ = out
                .send(failed(&id, tool, "The sign-in timed out. Start again."))
                .await;
            return false;
        }
    };
    if let Some(mut pipe) = stdin.take() {
        let typed = async {
            pipe.write_all(code.as_bytes()).await?;
            pipe.write_all(b"\n").await?;
            pipe.flush().await
        };
        if typed.await.is_err() {
            let _ = out
                .send(failed(&id, tool, &failure_of(&seen, Some(&code))))
                .await;
            return false;
        }
    }

    // 3. Its answer.
    let finished = tokio::time::timeout(FINISH_WAIT, async {
        let status = child.wait().await;
        while let Ok(Some(chunk)) =
            tokio::time::timeout(Duration::from_millis(200), text_rx.recv()).await
        {
            seen.push_str(&chunk);
        }
        status
    })
    .await;
    let ok = matches!(finished, Ok(Ok(status)) if status.success());
    let msg = if ok {
        RunnerMsg::SignInState(state(&id, tool, SignInStep::Done))
    } else {
        failed(&id, tool, &failure_of(&seen, Some(&code)))
    };
    let _ = out.send(msg).await;
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_link_is_only_ever_on_the_makers_site() {
        let printed = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=x\nPaste code here if prompted > ";
        assert_eq!(
            link_in(printed, Tool::Claude).as_deref(),
            Some("https://claude.com/cai/oauth/authorize?code=true&state=x")
        );
        assert_eq!(
            link_in("visit: https://platform.claude.com/x", Tool::Claude).as_deref(),
            Some("https://platform.claude.com/x")
        );
        assert_eq!(
            link_in("visit: https://claude.com.evil.example/x", Tool::Claude),
            None
        );
        assert_eq!(
            link_in("visit: https://evilclaude.com/x", Tool::Claude),
            None
        );
        assert_eq!(link_in("visit: http://claude.com/x", Tool::Claude), None);
        assert_eq!(link_in("nothing yet", Tool::Claude), None);
    }

    #[test]
    fn codes_are_one_plain_line() {
        assert!(valid_code("abcDEF123#state-_.~"));
        assert!(!valid_code(""));
        assert!(!valid_code("two words"));
        assert!(!valid_code("line\nbreak"));
        assert!(!valid_code(&"a".repeat(513)));
    }

    #[test]
    fn a_failure_never_carries_the_code() {
        let printed =
            "Paste code here if prompted > Login failed: code secretCODE42 wasn't accepted.";
        let why = failure_of(printed, Some("secretCODE42"));
        assert!(!why.contains("secretCODE42"), "{why}");
        assert!(why.starts_with("Login failed"), "{why}");
        assert_eq!(failure_of("", None), "The sign-in didn't finish.");
    }

    #[cfg(unix)]
    fn fake_tool(dir: &std::path::Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-claude");
        std::fs::write(
            &path,
            "#!/bin/sh\necho 'If the browser did not open, visit: https://claude.com/cai/oauth/authorize?code=true'\nprintf 'Paste code here if prompted > '\nread code\nif [ \"$code\" = good#state ]; then echo 'Login successful'; exit 0; fi\necho \"Login failed: $code was not accepted\"; exit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    async fn sign_in_with(code: &str) -> (bool, Vec<RunnerMsg>) {
        let dir = std::env::temp_dir().join(format!("sign-in-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let program = fake_tool(&dir);
        let (code_tx, code_rx) = oneshot::channel();
        let (out_tx, mut out_rx) = mpsc::channel(8);
        let task = tokio::spawn(run(
            program,
            &[],
            "si_1".into(),
            Tool::Claude,
            code_rx,
            out_tx,
        ));
        let first = out_rx.recv().await.unwrap();
        code_tx.send(code.to_string()).unwrap();
        let ok = task.await.unwrap();
        let mut msgs = vec![first];
        while let Ok(m) = out_rx.try_recv() {
            msgs.push(m);
        }
        let _ = std::fs::remove_dir_all(&dir);
        (ok, msgs)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_link_goes_out_and_the_owners_code_finishes_the_sign_in() {
        let (ok, msgs) = sign_in_with("good#state").await;
        assert!(ok);
        let RunnerMsg::SignInState(link) = &msgs[0] else {
            panic!()
        };
        assert_eq!(link.state, SignInStep::Link);
        assert_eq!(
            link.url.as_deref(),
            Some("https://claude.com/cai/oauth/authorize?code=true")
        );
        let RunnerMsg::SignInState(done) = &msgs[1] else {
            panic!()
        };
        assert_eq!(done.state, SignInStep::Done);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_wrong_code_fails_and_is_not_repeated_back() {
        let (ok, msgs) = sign_in_with("wrongCode9").await;
        assert!(!ok);
        let RunnerMsg::SignInState(end) = &msgs[1] else {
            panic!()
        };
        assert_eq!(end.state, SignInStep::Failed);
        let error = end.error.clone().unwrap();
        assert!(error.starts_with("Login failed"), "{error}");
        assert!(!error.contains("wrongCode9"), "{error}");
    }
    #[test]
    fn a_device_sign_in_gives_its_page_and_code() {
        let printed = "Follow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \u{1b}[94mhttps://auth.openai.com/codex/device\u{1b}[0m\n\n2. Enter this one-time code \u{1b}[90m(expires in 15 minutes)\u{1b}[0m\n   \u{1b}[94m7K2Q-M9XFD\u{1b}[0m\n";
        assert_eq!(
            link_in(printed, Tool::Codex).as_deref(),
            Some("https://auth.openai.com/codex/device")
        );
        assert_eq!(user_code_in(printed).as_deref(), Some("7K2Q-M9XFD"));
        assert_eq!(
            link_in(printed, Tool::Claude),
            None,
            "Codex's page is not Claude's"
        );
        assert_eq!(
            link_in(
                "https://auth.openai.com.evil.example/codex/device",
                Tool::Codex
            ),
            None
        );
        assert_eq!(user_code_in("2. Enter this one-time code\n   soon"), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_device_sign_in_sends_link_and_code_then_waits_for_the_tool() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("sign-in-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let program = dir.join("fake-codex");
        std::fs::write(
            &program,
            "#!/bin/sh\necho '1. Open this link in your browser and sign in'\necho '   https://auth.openai.com/codex/device'\necho '2. Enter this one-time code (expires in 15 minutes)'\necho '   AB12-CD345'\nsleep 0.3\necho 'Successfully logged in'\n",
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (_code_tx, code_rx) = oneshot::channel();
        let (out_tx, mut out_rx) = mpsc::channel(8);
        let ok = run(program, &[], "si_2".into(), Tool::Codex, code_rx, out_tx).await;
        assert!(ok);
        let RunnerMsg::SignInState(link) = out_rx.recv().await.unwrap() else {
            panic!()
        };
        assert_eq!(link.state, SignInStep::Link);
        assert_eq!(
            link.url.as_deref(),
            Some("https://auth.openai.com/codex/device")
        );
        assert_eq!(link.user_code.as_deref(), Some("AB12-CD345"));
        let RunnerMsg::SignInState(done) = out_rx.recv().await.unwrap() else {
            panic!()
        };
        assert_eq!(done.state, SignInStep::Done);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

//! `context-machine hook <event>`: what Claude Code's hooks run, so a session
//! on this computer is a device and sees its mail without remembering to look.
//!
//! The repository's `.claude/settings.json` names one command per event. Each
//! reads the event's JSON on stdin, never fails the session (it always exits
//! 0; a hook that errors puts a message over the person's prompt), and writes
//! what Claude Code feeds the model:
//!
//! - `SessionStart`: plain text added to the session's context. Starts the
//!   device (or reconnects it) and says either the code to approve with the
//!   Context `pair_device` action, or the device's id.
//! - `UserPromptSubmit`: plain text added before the prompt. Unread mail, the
//!   device id once it is paired, and a reminder to keep `mail wait` running
//!   when it is not.
//! - `PostToolUse`: unread mail as `hookSpecificOutput.additionalContext`, so
//!   mail reaches a session that is mid-task at its next step.
//! - `Stop`: `{"decision":"block","reason":…}` while mail is unread, so the
//!   session does not end a turn without having read it.
//! - `SessionEnd`: the device leaves: grant given back, daemon stopped.

use crate::join::{self, Joined};
use crate::mailbox;
use crate::state::State;
use anyhow::Result;
use serde_json::{json, Value};
use std::io::Read;

/// The hook events, by Claude Code's names or short ones.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Event {
    SessionStart,
    Prompt,
    PostTool,
    Stop,
    SessionEnd,
}

impl Event {
    pub fn parse(name: &str) -> Option<Event> {
        match name {
            "SessionStart" | "session-start" => Some(Event::SessionStart),
            "UserPromptSubmit" | "prompt" => Some(Event::Prompt),
            "PostToolUse" | "post-tool" => Some(Event::PostTool),
            "Stop" | "stop" => Some(Event::Stop),
            "SessionEnd" | "session-end" => Some(Event::SessionEnd),
            _ => None,
        }
    }
}

fn input() -> Value {
    let mut raw = String::new();
    let _ = std::io::stdin().take(1 << 20).read_to_string(&mut raw);
    serde_json::from_str(&raw).unwrap_or(Value::Null)
}

/// What this device is called in the devices list: the app and the folder the session works in.
pub fn device_name(event: &Value) -> String {
    let folder = event
        .get("cwd")
        .and_then(Value::as_str)
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_else(|| "session".into());
    let app = if std::env::var_os("CODEX_HOME").is_some() && std::env::var_os("CLAUDECODE").is_none() {
        "Codex"
    } else {
        "Claude Code"
    };
    let name = format!("{app} · {folder}");
    name.chars().take(100).collect()
}

fn waiter_path(state: &State) -> std::path::PathBuf {
    state.dir.join("mail").join("waiter.pid")
}

/// Whether a `mail wait` is running for this device now.
pub fn waiting(state: &State) -> bool {
    std::fs::read_to_string(waiter_path(state))
        .ok()
        .and_then(|p| p.trim().parse::<i32>().ok())
        .is_some_and(|pid| {
            #[cfg(unix)]
            // SAFETY: signal 0 only checks the process exists.
            return unsafe { libc::kill(pid, 0) } == 0;
            #[cfg(not(unix))]
            false
        })
}

const WAIT_LINE: &str = "Keep `context-machine mail wait` running as a background command (run_in_background), and start it again each time it ends: it ends the moment mail arrives, which wakes you.";

fn pair_words(code: &str) -> String {
    format!(
        "This computer is joining Context as a mail-only device for this session, so other agents and Tex can mail you here. \
         Approve it now, from your own Context connection: call the Context tool `manage` with action \"pair_device\" and args {{\"code\": \"{code}\"}}. \
         It never takes jobs and leaves when this session ends. Then: {WAIT_LINE}"
    )
}

fn device_words(machine_id: &str) -> String {
    format!(
        "This session is Context device {machine_id} (mail only). To get a note's mail here at once, join it with Context write action \"mail\", \
         args {{\"join\": \"<a short name>\", \"device\": \"{machine_id}\"}}, and pass the mailbox id it gives on later calls. {WAIT_LINE}"
    )
}

fn announced(state: &State, machine_id: &str) -> bool {
    let path = state.dir.join("mail").join("announced");
    if std::fs::read_to_string(&path).ok().as_deref() == Some(machine_id) {
        return true;
    }
    let _ = crate::state::make_private_dir(&state.dir.join("mail"));
    let _ = crate::state::write_private(&path, machine_id.as_bytes());
    false
}

/// Unread mail in the session's words, taken (shown once).
fn mail_words(state: &State) -> Option<String> {
    let mail = mailbox::take_unread(state).ok()?;
    if mail.is_empty() {
        return None;
    }
    Some(mailbox::words(&mail, &state.machine().machine_id))
}

/// Runs one hook. Never an error to the caller: what went wrong is one line in the output, or nothing.
pub async fn run(state: &State, event: Event, endpoint: &str) -> Result<()> {
    let given = input();
    let name = device_name(&given);
    match event {
        Event::SessionStart => {
            let mut out = match join::ensure(state, endpoint, &name).await {
                Ok(Joined::Pairing { code }) => pair_words(&code),
                Ok(Joined::Paired { machine_id }) => {
                    announced(state, &machine_id);
                    device_words(&machine_id)
                }
                Err(e) => format!("Context device: not connected ({e:#})."),
            };
            if let Some(mail) = mail_words(state) {
                out = format!("{out}\n\n{mail}");
            }
            println!("{out}");
        }
        Event::Prompt => {
            let mut parts = Vec::new();
            match join::ensure(state, endpoint, &name).await {
                Ok(Joined::Pairing { code }) => parts.push(pair_words(&code)),
                Ok(Joined::Paired { machine_id }) => {
                    if !announced(state, &machine_id) {
                        parts.push(device_words(&machine_id));
                    } else if !waiting(state) {
                        parts.push(format!("Context device {machine_id}: no `mail wait` is running. {WAIT_LINE}"));
                    }
                }
                Err(_) => {}
            }
            if let Some(mail) = mail_words(state) {
                parts.push(mail);
            }
            if !parts.is_empty() {
                println!("{}", parts.join("\n\n"));
            }
        }
        Event::PostTool => {
            if let Some(mail) = mail_words(state) {
                println!(
                    "{}",
                    json!({ "hookSpecificOutput": { "hookEventName": "PostToolUse", "additionalContext": mail } })
                );
            }
        }
        Event::Stop => {
            if let Some(mail) = mail_words(state) {
                println!("{}", json!({ "decision": "block", "reason": mail }));
            }
        }
        Event::SessionEnd => {
            let _ = join::leave(state, endpoint).await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_go_by_claude_code_names_or_short_ones() {
        assert_eq!(Event::parse("UserPromptSubmit"), Some(Event::Prompt));
        assert_eq!(Event::parse("stop"), Some(Event::Stop));
        assert_eq!(Event::parse("PreToolUse"), None);
    }

    #[test]
    fn a_device_is_named_by_its_app_and_folder() {
        let n = device_name(&json!({ "cwd": "/home/user/context" }));
        assert!(n.ends_with("· context"), "{n}");
    }

    #[test]
    fn the_pairing_words_name_the_action_and_the_code() {
        let w = pair_words("KQ7-4MP");
        assert!(w.contains("\"pair_device\"") && w.contains("KQ7-4MP") && w.contains("mail wait"));
    }
}

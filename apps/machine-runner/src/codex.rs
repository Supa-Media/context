//! Driving the person's own `codex`.
//!
//! Spike, 2026-11-04, codex-cli 0.166.0 (docs/spikes.md):
//!
//! - `codex exec --json` prints one JSON event per line: `thread.started`
//!   (the id to resume), `turn.started`, `item.*`, then `turn.completed` with
//!   usage or `turn.failed`. `error` lines are also retry notices, so they are
//!   not failures; a turn failed when it says so, or the stream ends without
//!   `turn.completed`.
//! - stdin is read once before the turn, so a message cannot reach a running
//!   turn. A note or an ask waits for the turn to end and goes in as the next
//!   `codex exec resume <id>`; an interrupt is SIGINT, then the same resume.
//! - `exec --json` reports no plan limits; a turn that fails on a usage limit
//!   pauses the machine for Codex until the time it names, or an hour.
//! - `usage` may be the thread's running total; the runner reports the
//!   difference from the last turn it saw.
//! - MCP servers come from `-c mcp_servers.<name>...`. A header there would put
//!   the grant in argv, so Context is mounted as a stdio server that is this
//!   binary itself (`context-machine mcp-proxy --grant-file <0600 path>`).

use crate::cli::{CliEvent, StepLine};
use serde_json::Value;
use std::path::Path;

pub struct CodexPlan<'a> {
    pub workdir: &'a Path,
    pub resume_thread: Option<&'a str>,
    pub runner_exe: &'a Path,
    pub grant_file: &'a Path,
    pub endpoint: &'a str,
    pub network: bool,
    pub read_only: bool,
    pub prompt: &'a str,
}

/// The argv after `codex`. The prompt is the last argument: Codex has no other
/// way in, and a brief is words, not a credential.
pub fn args(p: &CodexPlan) -> Vec<String> {
    let mut a: Vec<String> = vec!["exec".into()];
    if let Some(id) = p.resume_thread {
        a.extend(["resume".into(), id.into()]);
    }
    a.extend(["--json".into(), "--skip-git-repo-check".into()]);
    if p.resume_thread.is_none() {
        a.extend(["--cd".into(), p.workdir.display().to_string()]);
    }
    // Codex's own sandbox always: read-only for a read run, else the run's
    // folder, with the network only when the run may use it.
    let sandbox = if p.read_only {
        "read-only"
    } else {
        "workspace-write"
    };
    a.extend(["--sandbox".into(), sandbox.into()]);
    a.extend([
        "-c".into(),
        format!("sandbox_workspace_write.network_access={}", p.network),
    ]);
    let exe = toml_string(&p.runner_exe.display().to_string());
    let grant = toml_string(&p.grant_file.display().to_string());
    let endpoint = toml_string(p.endpoint);
    a.extend([
        "-c".into(),
        format!("mcp_servers.context.command={exe}"),
        "-c".into(),
        format!("mcp_servers.context.args=[\"mcp-proxy\", \"--grant-file\", {grant}, \"--endpoint\", {endpoint}]"),
    ]);
    a.push(p.prompt.into());
    a
}

fn toml_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// Reads one stdout line.
pub fn parse(line: &str) -> Vec<CliEvent> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return vec![];
    };
    let s = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    match v.get("type").and_then(|t| t.as_str()) {
        Some("thread.started") => vec![CliEvent::Session(s(&v, "thread_id"))],
        Some("item.started") | Some("item.completed") => {
            let Some(item) = v.get("item") else {
                return vec![];
            };
            let completed = v["type"] == "item.completed";
            match item.get("type").and_then(|t| t.as_str()) {
                Some("agent_message") if completed => vec![CliEvent::Text(s(item, "text"))],
                Some("command_execution") if !completed => {
                    vec![CliEvent::Step(StepLine::new(
                        "shell",
                        "run",
                        crate::cli::program_of(&s(item, "command")),
                    ))]
                }
                Some("file_change") if completed => item
                    .get("changes")
                    .and_then(|c| c.as_array())
                    .into_iter()
                    .flatten()
                    .map(|c| CliEvent::Step(StepLine::new("files", &s(c, "kind"), &s(c, "path"))))
                    .collect(),
                Some("mcp_tool_call") if !completed => {
                    let target = item
                        .get("arguments")
                        .and_then(|a| {
                            ["path", "id", "query"]
                                .iter()
                                .find_map(|k| a.get(*k).and_then(|x| x.as_str()))
                        })
                        .unwrap_or("")
                        .to_string();
                    vec![CliEvent::Step(StepLine::new(
                        &s(item, "server"),
                        &s(item, "tool"),
                        &target,
                    ))]
                }
                Some("web_search") if !completed => {
                    vec![CliEvent::Step(StepLine::new("web", "search", ""))]
                }
                _ => vec![],
            }
        }
        Some("turn.completed") => {
            let u = v.get("usage").cloned().unwrap_or(Value::Null);
            let n = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
            vec![
                CliEvent::Usage {
                    input: n("input_tokens"),
                    output: n("output_tokens") + n("reasoning_output_tokens"),
                    cache_read: n("cached_input_tokens"),
                    cache_write: n("cache_write_input_tokens"),
                    model: None,
                },
                CliEvent::TurnDone {
                    ok: true,
                    text: String::new(),
                    error: None,
                },
            ]
        }
        Some("turn.failed") => {
            let msg = v
                .pointer("/error/message")
                .and_then(|m| m.as_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let code = if msg.contains("usage limit")
                || msg.contains("rate limit")
                || msg.contains("quota")
            {
                "planLimit"
            } else if msg.contains("auth") || msg.contains("log in") || msg.contains("login") {
                "notSignedIn"
            } else {
                "failed"
            };
            vec![CliEvent::TurnDone {
                ok: false,
                text: String::new(),
                error: Some(code.into()),
            }]
        }
        _ => vec![],
    }
}

/// Codex's usage may be the thread's running total: report what this turn
/// added. A total that went down is a new thread, so it is taken whole.
pub fn usage_delta(prev: (u64, u64), now: (u64, u64)) -> (u64, u64) {
    if now.0 >= prev.0 && now.1 >= prev.1 {
        (now.0 - prev.0, now.1 - prev.1)
    } else {
        now
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn reads_the_thread_and_a_turn() {
        assert_eq!(
            parse(r#"{"type":"thread.started","thread_id":"01a1"}"#),
            vec![CliEvent::Session("01a1".into())]
        );
        let ev = parse(
            r#"{"type":"item.started","item":{"id":"item_3","type":"command_execution","command":"TOKEN=x cargo test","aggregated_output":"","exit_code":null,"status":"in_progress"}}"#,
        );
        assert_eq!(
            ev,
            vec![CliEvent::Step(StepLine::new("shell", "run", "cargo"))]
        );
        let ev = parse(
            r#"{"type":"item.completed","item":{"id":"item_4","type":"file_change","changes":[{"path":"src/a.rs","kind":"update"}],"status":"completed"}}"#,
        );
        assert_eq!(
            ev,
            vec![CliEvent::Step(StepLine::new("files", "update", "src/a.rs"))]
        );
        let ev = parse(
            r#"{"type":"item.completed","item":{"id":"item_5","type":"agent_message","text":"Done."}}"#,
        );
        assert_eq!(ev, vec![CliEvent::Text("Done.".into())]);
        let ev = parse(
            r#"{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":10,"cache_write_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":5}}"#,
        );
        assert_eq!(
            ev[0],
            CliEvent::Usage {
                input: 1000,
                output: 15,
                cache_read: 10,
                cache_write: 0,
                model: None
            }
        );
        assert!(matches!(ev[1], CliEvent::TurnDone { ok: true, .. }));
    }

    #[test]
    fn a_retry_notice_is_not_a_failure() {
        assert!(parse(r#"{"type":"error","message":"Reconnecting... 2/5"}"#).is_empty());
    }

    #[test]
    fn a_usage_limit_failure_pauses() {
        let ev = parse(
            r#"{"type":"turn.failed","error":{"message":"You've hit your usage limit. Try again at 3pm."}}"#,
        );
        assert_eq!(
            ev,
            vec![CliEvent::TurnDone {
                ok: false,
                text: String::new(),
                error: Some("planLimit".into())
            }]
        );
    }

    #[test]
    fn argv_mounts_context_through_the_proxy_never_the_grant() {
        let exe = PathBuf::from("/opt/context-machine");
        let gf = PathBuf::from("/runs/j/grant");
        let wd = PathBuf::from("/srv/code/wt");
        let p = CodexPlan {
            workdir: &wd,
            resume_thread: None,
            runner_exe: &exe,
            grant_file: &gf,
            endpoint: "https://x/mcp",
            network: false,
            read_only: false,
            prompt: "fix it",
        };
        let a = args(&p);
        let joined = a.join(" ");
        assert!(joined.contains("--sandbox workspace-write"));
        assert!(joined.contains("sandbox_workspace_write.network_access=false"));
        assert!(joined.contains(r#"mcp_servers.context.command="/opt/context-machine""#));
        assert!(joined.contains(r#""--grant-file", "/runs/j/grant""#));
        assert_eq!(a.last().unwrap(), "fix it");
        let r = args(&CodexPlan {
            resume_thread: Some("t1"),
            ..p
        });
        assert_eq!(&r[..3], &["exec", "resume", "t1"]);
        assert!(!r.join(" ").contains("--cd"));
    }

    #[test]
    fn usage_is_reported_per_turn() {
        assert_eq!(usage_delta((100, 10), (150, 12)), (50, 2));
        assert_eq!(usage_delta((100, 10), (40, 3)), (40, 3));
    }
}

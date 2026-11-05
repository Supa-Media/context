//! Driving the person's own `claude`.
//!
//! Spike, 2026-11-04, Claude Code 2.1.318 (docs/spikes.md has the transcripts):
//!
//! - `-p --input-format stream-json --output-format stream-json --verbose`
//!   keeps one session open on stdin. A user line written mid-turn is folded
//!   into the same turn after the current tool call, so mail reaches a running
//!   agent with no polling.
//! - `{"type":"control_request","request":{"subtype":"interrupt"}}` cuts the
//!   running tool at once; the turn ends `error_during_execution` and the next
//!   user line continues the same session.
//! - `rate_limit_event` names the plan window (`five_hour`, `seven_day`), its
//!   utilization and the exact reset (`resetsAt`, Unix seconds), so the pause
//!   near the plan's limit and the reset time Tex tells the person are real.
//! - `--session-id <uuid>` picks the id before the run starts, so the runner
//!   knows what to `--resume` after a crash without waiting for the CLI.
//!
//! A run is plain Claude Code (owner, 2026-11-04): full permissions and the
//! folder's own `.claude` settings, as in their own terminal. Only
//! `--strict-mcp-config` stays, so the run's Context server is the one with
//! the run's own grant.

use crate::cli::{CliEvent, LimitSignal, StepLine};
use crate::protocol::PermissionMode;
use serde_json::{json, Value};
use std::path::Path;

pub struct ClaudePlan<'a> {
    pub session_id: &'a str,
    pub resume: bool,
    pub mcp_config: &'a Path,
    pub settings_file: Option<&'a Path>,
    pub permission: PermissionMode,
    pub allowed_commands: &'a [String],
    pub helpers: bool,
    pub network: bool,
    pub system_prompt: &'a str,
}

/// The model every part runs on.
pub const MODEL: &str = "claude-opus-5-5";

/// The argv after `claude`. The brief is not here: it is the first stdin line,
/// so it never shows in `ps`.
pub fn args(p: &ClaudePlan) -> Vec<String> {
    let mut a: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--strict-mcp-config",
        "--mcp-config",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    a.push(p.mcp_config.display().to_string());
    // The model is ours to choose, never the computer's default (the owner, 2026-11-05).
    a.extend(["--model".into(), MODEL.into()]);
    if p.resume {
        a.extend(["--resume".into(), p.session_id.into()]);
    } else {
        a.extend(["--session-id".into(), p.session_id.into()]);
    }
    // read: only reading tools; edits: file edits and the allowlisted
    // programs; full: whatever Claude Code allows, the mode Tex sends.
    let (mode, extra): (&str, Vec<String>) = match p.permission {
        PermissionMode::Read => (
            "default",
            ["Read", "Glob", "Grep"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        ),
        PermissionMode::Edits => (
            "acceptEdits",
            p.allowed_commands
                .iter()
                .map(|c| format!("Bash({c}:*)"))
                .collect(),
        ),
        PermissionMode::Full => ("bypassPermissions", vec![]),
    };
    a.extend(["--permission-mode".into(), mode.into()]);
    if p.permission != PermissionMode::Full {
        let mut allowed = vec!["mcp__context".to_string()];
        allowed.extend(extra);
        a.push("--allowedTools".into());
        a.push(allowed.join(","));
    }
    let mut denied: Vec<&str> = vec![];
    if p.permission == PermissionMode::Read {
        denied.extend(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);
    }
    if !p.helpers {
        denied.extend(["Task", "Agent"]);
    }
    if !p.network {
        denied.extend(["WebFetch", "WebSearch"]);
    }
    if !denied.is_empty() {
        a.push("--disallowedTools".into());
        a.push(denied.join(","));
    }
    if let Some(s) = p.settings_file {
        a.extend(["--settings".into(), s.display().to_string()]);
    }
    a.extend(["--append-system-prompt".into(), p.system_prompt.into()]);
    a
}

/// `--settings` for a run with no network: Claude Code's own sandbox, with
/// only the Context endpoint reachable. Commands may not leave the sandbox.
pub fn sandbox_settings(endpoint_host: &str) -> Value {
    json!({
        "sandbox": {
            "enabled": true,
            "allowUnsandboxedCommands": false,
            "network": { "allowedDomains": [endpoint_host] }
        }
    })
}

/// The `--mcp-config` document. Written to a 0600 file; only its path is argv.
pub fn mcp_config(endpoint: &str, grant: &str) -> Value {
    json!({
        "mcpServers": {
            "context": {
                "type": "http",
                "url": endpoint,
                "headers": { "Authorization": format!("Bearer {grant}") }
            }
        }
    })
}

/// One user line for stdin.
pub fn user_line(text: &str) -> String {
    json!({"type": "user", "message": {"role": "user", "content": text}}).to_string()
}

pub fn interrupt_line(request_id: &str) -> String {
    json!({"type": "control_request", "request_id": request_id, "request": {"subtype": "interrupt"}}).to_string()
}

/// Reads one stdout line into what the runner cares about. Lines it does not
/// know are skipped: the CLI adds kinds often, and none of them is a command.
pub fn parse(line: &str) -> Vec<CliEvent> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return vec![];
    };
    let s = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    match v.get("type").and_then(|t| t.as_str()) {
        Some("system") if v.get("subtype").and_then(|t| t.as_str()) == Some("init") => {
            s(&v, "session_id")
                .map(CliEvent::Session)
                .into_iter()
                .collect()
        }
        Some("assistant") => {
            let mut out = vec![];
            for block in v
                .pointer("/message/content")
                .and_then(|c| c.as_array())
                .into_iter()
                .flatten()
            {
                match block.get("type").and_then(|t| t.as_str()) {
                    Some("tool_use") => {
                        let name = s(block, "name").unwrap_or_default();
                        out.push(CliEvent::Step(step_for(
                            &name,
                            block.get("input").unwrap_or(&Value::Null),
                        )));
                    }
                    Some("text") => {
                        if let Some(t) = s(block, "text") {
                            out.push(CliEvent::Text(t));
                        }
                    }
                    Some("thinking") => {
                        if let Some(t) = s(block, "thinking").filter(|t| !t.trim().is_empty()) {
                            out.push(CliEvent::Thinking(t));
                        }
                    }
                    _ => {}
                }
            }
            out
        }
        Some("rate_limit_event") => {
            let info = v.get("rate_limit_info").cloned().unwrap_or(Value::Null);
            let status = match info.get("status").and_then(|x| x.as_str()) {
                Some("allowed") => "allowed",
                Some("allowed_warning") => "warning",
                Some("rejected") => "rejected",
                _ => return vec![],
            };
            vec![CliEvent::Limit(LimitSignal {
                status: status.into(),
                window: s(&info, "rateLimitType"),
                utilization: info.get("utilization").and_then(|x| x.as_f64()),
                resets_at: info.get("resetsAt").and_then(|x| x.as_u64()),
            })]
        }
        Some("result") => {
            let usage = v.get("usage").cloned().unwrap_or(Value::Null);
            let n = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
            let text = s(&v, "result").unwrap_or_default();
            let subtype = s(&v, "subtype").unwrap_or_default();
            let is_error = v.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false);
            let ok = subtype == "success" && !is_error;
            let error = (!ok).then(|| classify_error(&subtype, &text));
            vec![
                CliEvent::Usage {
                    input: n("input_tokens"),
                    output: n("output_tokens"),
                    cache_read: n("cache_read_input_tokens"),
                    cache_write: n("cache_creation_input_tokens"),
                    model: main_model(v.get("modelUsage")),
                },
                CliEvent::TurnDone { ok, text, error },
            ]
        }
        _ => vec![],
    }
}

fn classify_error(subtype: &str, text: &str) -> String {
    let t = text.to_ascii_lowercase();
    if subtype == "error_during_execution" && t.is_empty() {
        "interrupted".into()
    } else if t.contains("not logged in") || t.contains("/login") || t.contains("authentication") {
        "notSignedIn".into()
    } else if t.contains("usage limit") || t.contains("rate limit") || t.contains("limit reached") {
        "planLimit".into()
    } else if subtype == "error_max_turns" {
        "maxTurns".into()
    } else if subtype == "error_during_execution" {
        "interrupted".into()
    } else {
        "failed".into()
    }
}

/// The model that did most of the run.
fn main_model(model_usage: Option<&Value>) -> Option<String> {
    let map = model_usage?.as_object()?;
    map.iter()
        .map(|(name, u)| {
            let total: u64 = [
                "inputTokens",
                "outputTokens",
                "cacheReadInputTokens",
                "cacheCreationInputTokens",
            ]
            .iter()
            .filter_map(|k| u.get(*k).and_then(|x| x.as_u64()))
            .sum();
            (total, name)
        })
        .max()
        .map(|(_, n)| n.clone())
}

/// The short step line for a tool call: tool, action, target. Never file
/// contents and never a whole shell line (it can carry a secret): a command's
/// program name only.
pub fn step_for(name: &str, input: &Value) -> StepLine {
    let get = |k: &str| input.get(k).and_then(|x| x.as_str()).unwrap_or("");
    if let Some(rest) = name.strip_prefix("mcp__") {
        let mut parts = rest.splitn(2, "__");
        let server = parts.next().unwrap_or("mcp");
        let tool = parts.next().unwrap_or("");
        let target = ["path", "id", "query"]
            .iter()
            .map(|k| get(k))
            .find(|v| !v.is_empty())
            .unwrap_or("");
        return StepLine::new(server, tool, target);
    }
    match name {
        "Bash" => StepLine::new("shell", "run", crate::cli::program_of(get("command"))),
        "Read" => StepLine::new("files", "read", get("file_path")),
        "Write" => StepLine::new("files", "write", get("file_path")),
        "Edit" | "MultiEdit" => StepLine::new("files", "edit", get("file_path")),
        "Glob" | "Grep" => StepLine::new("files", "search", ""),
        "WebFetch" => StepLine::new("web", "fetch", crate::cli::host_of(get("url"))),
        "WebSearch" => StepLine::new("web", "search", ""),
        "Task" | "Agent" => StepLine::new("helper", "start", get("description")),
        "TodoWrite" => StepLine::new("plan", "update", ""),
        other => StepLine::new("tool", other, ""),
    }
}

#[cfg(test)]
mod tests;

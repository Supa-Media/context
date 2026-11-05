use super::*;
use crate::protocol::PermissionMode;
use std::path::PathBuf;

// Shapes captured from Claude Code 2.1.318 in the spike; ids replaced.
const INIT: &str = r#"{"type":"system","subtype":"init","cwd":"/w","session_id":"11111111-1111-4111-8111-111111111111","tools":["Bash"],"model":"claude-sonnet-5-5"}"#;
const TOOL: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_x","name":"Bash","input":{"command":"API_KEY=sk-secret curl -s https://x","description":"call"}}]},"session_id":"s"}"#;
const MCP: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"mcp__context__fetch","input":{"id":"projects/a.md"}},{"type":"text","text":"Reading the task."}]}}"#;
const RATE: &str = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1793955600,"rateLimitType":"seven_day","utilization":0.85,"isUsingOverage":false,"surpassedThreshold":0.75,"unifiedWindows":{"five_hour":{"utilization":0.4,"resetsAt":1793773200,"status":"allowed"}}}}"#;
const RESULT: &str = r#"{"type":"result","subtype":"success","is_error":false,"result":"hi","session_id":"s","usage":{"input_tokens":4,"cache_creation_input_tokens":8519,"cache_read_input_tokens":63704,"output_tokens":89},"modelUsage":{"claude-haiku-4-5":{"inputTokens":1,"outputTokens":1},"claude-sonnet-5-5":{"inputTokens":4,"outputTokens":89,"cacheReadInputTokens":63704}}}"#;
const INTERRUPTED: &str = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"s","usage":{}}"#;

#[test]
fn reads_the_session_id_from_init() {
    assert_eq!(
        parse(INIT),
        vec![CliEvent::Session(
            "11111111-1111-4111-8111-111111111111".into()
        )]
    );
}

#[test]
fn a_shell_step_names_only_the_program() {
    let ev = parse(TOOL);
    assert_eq!(
        ev,
        vec![CliEvent::Step(StepLine::new("shell", "run", "curl"))]
    );
    assert!(!format!("{ev:?}").contains("sk-secret"));
}

#[test]
fn context_tools_and_text() {
    let ev = parse(MCP);
    assert_eq!(
        ev[0],
        CliEvent::Step(StepLine::new("context", "fetch", "projects/a.md"))
    );
    assert_eq!(ev[1], CliEvent::Text("Reading the task.".into()));
}

#[test]
fn reads_the_plans_limit_and_reset() {
    let ev = parse(RATE);
    let CliEvent::Limit(l) = &ev[0] else {
        panic!("{ev:?}")
    };
    assert_eq!(l.status, "warning");
    assert_eq!(l.window.as_deref(), Some("seven_day"));
    assert_eq!(l.resets_at, Some(1793955600));
    assert_eq!(l.utilization, Some(0.85));
}

#[test]
fn reads_usage_and_the_main_model_from_the_result() {
    let ev = parse(RESULT);
    assert_eq!(
        ev[0],
        CliEvent::Usage {
            input: 4,
            output: 89,
            cache_read: 63704,
            cache_write: 8519,
            model: Some("claude-sonnet-5-5".into())
        }
    );
    assert_eq!(
        ev[1],
        CliEvent::TurnDone {
            ok: true,
            text: "hi".into(),
            error: None
        }
    );
}

#[test]
fn an_interrupted_turn_is_not_a_failure_of_the_job() {
    let ev = parse(INTERRUPTED);
    assert_eq!(
        ev[1],
        CliEvent::TurnDone {
            ok: false,
            text: String::new(),
            error: Some("interrupted".into())
        }
    );
}

#[test]
fn errors_are_classified() {
    assert_eq!(
        classify_error("success", "Not logged in · Please run /login"),
        "notSignedIn"
    );
    assert_eq!(
        classify_error("success", "Claude AI usage limit reached|1793955600"),
        "planLimit"
    );
    assert_eq!(classify_error("error_max_turns", ""), "maxTurns");
}

#[test]
fn unknown_and_broken_lines_are_skipped() {
    assert!(parse("not json").is_empty());
    assert!(parse(r#"{"type":"stream_event","event":{}}"#).is_empty());
}

fn plan<'a>(cfg: &'a Path, cmds: &'a [String]) -> ClaudePlan<'a> {
    ClaudePlan {
        session_id: "sid",
        resume: false,
        mcp_config: cfg,
        settings_file: None,
        permission: PermissionMode::Edits,
        allowed_commands: cmds,
        helpers: false,
        network: false,
        system_prompt: "p",
    }
}

#[test]
fn argv_never_holds_the_grant_or_the_brief() {
    let cfg = PathBuf::from("/runs/j/mcp.json");
    let cmds = vec!["git".to_string()];
    let a = args(&plan(&cfg, &cmds));
    let joined = a.join(" ");
    assert!(joined.contains("--mcp-config /runs/j/mcp.json"));
    assert!(joined.contains("--strict-mcp-config"));
    assert!(joined.contains("--session-id sid"));
    assert!(joined.contains("--allowedTools mcp__context,Bash(git:*)"));
    assert!(joined.contains("--disallowedTools Task,Agent,WebFetch,WebSearch"));
    // Plain Claude Code: the folder's own settings load, as in their terminal.
    assert!(!joined.contains("--setting-sources"));
    assert!(!joined.contains("Bearer"));
    let doc = mcp_config("https://x/mcp", "SENTINEL-GRANT").to_string();
    assert!(doc.contains("Bearer SENTINEL-GRANT"));
    assert!(!joined.contains("SENTINEL-GRANT"));
}

#[test]
fn a_full_run_is_plain_claude_code_and_resume_uses_the_id() {
    let cfg = PathBuf::from("/c");
    let cmds = vec![];
    let mut p = plan(&cfg, &cmds);
    p.helpers = true;
    p.network = true;
    p.resume = true;
    p.permission = PermissionMode::Full;
    let a = args(&p).join(" ");
    assert!(!a.contains("--setting-sources"));
    assert!(!a.contains("--disallowedTools"));
    assert!(!a.contains("--allowedTools"));
    assert!(a.contains("--resume sid"));
}

#[test]
fn stdin_lines() {
    let v: Value = serde_json::from_str(&user_line("a \"quoted\"\nline")).unwrap();
    assert_eq!(v["message"]["content"], "a \"quoted\"\nline");
    let v: Value = serde_json::from_str(&interrupt_line("r1")).unwrap();
    assert_eq!(v["request"]["subtype"], "interrupt");
}

#[test]
fn a_read_run_cannot_edit_or_run_commands() {
    let cfg = PathBuf::from("/c");
    let cmds = vec!["git".to_string()];
    let mut p = plan(&cfg, &cmds);
    p.permission = PermissionMode::Read;
    let a = args(&p).join(" ");
    assert!(a.contains("--allowedTools mcp__context,Read,Glob,Grep"));
    assert!(a.contains("Edit,Write,MultiEdit,NotebookEdit,Bash"));
    assert!(!a.contains("Bash(git"));
}

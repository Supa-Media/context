//! The messages between this runner and the workspace object that owns the
//! machine.
//!
//! The gateway can send: a challenge to sign, the machine's rules, an
//! assignment, a message or an interrupt for a running job, a cancel, a
//! release (the job is over), and an ack of a result.
//! Nothing here runs a command: a brief is words handed to the agent, never a
//! shell line. Every assignment is checked against the local rules
//! (`rules.rs`) before anything starts, so a gateway that sends something it
//! should not is refused on the machine as well.
//!
//! The canonical shape is the JSON Schema in `packages/shared`
//! (`machineProtocol.schema.json`); `tests/protocol_schema.rs` fails when the
//! two drift.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Bumped when a message changes shape incompatibly.
pub const PROTOCOL_VERSION: u32 = 1;

/// Which coding CLI a slot runs. A slot is compute, not a tool: any slot runs
/// either, picked per job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Cli {
    Claude,
    Codex,
}

impl Cli {
    pub fn name(self) -> &'static str {
        match self {
            Cli::Claude => "claude",
            Cli::Codex => "codex",
        }
    }
}

/// Where a job's files go: a git worktree of a repository under an allowed
/// folder, or an empty scratch folder under one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Workdir {
    Worktree,
    Scratch,
}

/// What the gateway sends.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMsg {
    Challenge(Challenge),
    Settings(SettingsMsg),
    Assign(Assignment),
    Message(JobMessage),
    Interrupt(Interrupt),
    Cancel(Cancel),
    /// The job is over: its folder may go, unless it holds work.
    Release(Cancel),
    /// The job object has a part's result; the runner forgets its copy.
    Ack(Ack),
    Ping,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ack {
    pub job_id: String,
    pub part: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Challenge {
    pub nonce: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsMsg {
    pub rules: crate::rules::Rules,
}

/// One part of a job, handed to a slot.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
    pub job_id: String,
    pub part: u32,
    pub cli: Cli,
    /// The job's brief, handed to the agent as its first message.
    pub brief: String,
    #[serde(default)]
    pub done_when: String,
    /// The folder to work in. Must sit inside one of the allowed folders.
    pub folder: PathBuf,
    pub workdir: Workdir,
    /// A run grant minted for this part: written to a 0600 file, never argv
    /// or the environment, deleted when the part ends.
    pub run_grant: String,
    /// The Context MCP endpoint the run grant is for.
    pub endpoint: String,
    /// When the part must be over, Unix milliseconds.
    pub deadline_at: u64,
    /// True when the machine's owner asked for this job themself.
    pub own: bool,
    /// Who asked, for the audit line and the per-person counters.
    #[serde(default)]
    pub asker: Option<String>,
    #[serde(default)]
    pub network: bool,
    #[serde(default)]
    pub helpers: bool,
    #[serde(default)]
    pub computer_use: bool,
    /// Resume this CLI session instead of starting a new one.
    #[serde(default)]
    pub resume_session_id: Option<String>,
}

/// A note-mail line for a running job (`03-instant-mail`).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mail {
    pub from: String,
    #[serde(default)]
    pub app: Option<String>,
    /// note, ask or interrupt.
    #[serde(default = "MailKind::note")]
    pub kind: MailKind,
    #[serde(default)]
    pub path: Option<String>,
    pub text: String,
    #[serde(default)]
    pub at: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MailKind {
    Note,
    Ask,
    Interrupt,
}

impl MailKind {
    fn note() -> Self {
        MailKind::Note
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobMessage {
    pub job_id: String,
    pub mail: Mail,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Interrupt {
    pub job_id: String,
    #[serde(default)]
    pub reason: String,
    /// Read first when the session resumes.
    #[serde(default)]
    pub mail: Option<Mail>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cancel {
    pub job_id: String,
}

/// What the runner sends.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RunnerMsg {
    Hello(Hello),
    Accepted {
        #[serde(rename = "jobId")]
        job_id: String,
        part: u32,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Refused {
        #[serde(rename = "jobId")]
        job_id: String,
        part: u32,
        reason: Refusal,
    },
    Step(Step),
    Usage(Usage),
    Limit(LimitSignal),
    Result(PartResult),
    Status(Status),
    /// A released job's folder was kept because it holds work.
    Released {
        #[serde(rename = "jobId")]
        job_id: String,
        kept: bool,
        branch: Option<String>,
    },
    Pong,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub version: u32,
    pub runner: String,
    /// ed25519 over the challenge nonce's bytes, base64url without padding.
    pub signature: String,
    pub public_key: String,
    pub facts: crate::facts::Facts,
    pub slots: crate::slots::SlotAdvice,
    pub free_memory_mb: u64,
    /// Parts that were running when the socket dropped, so the job object can
    /// resume the same session rather than start over.
    pub running: Vec<RunningPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunningPart {
    pub job_id: String,
    pub part: u32,
    pub session_id: String,
    pub last_step: Option<String>,
    /// Still running on this machine (true) or ended while we were offline
    /// and waiting to report (false, with the result sent right after).
    pub alive: bool,
}

/// Why a runner refused an assignment. Said plainly to the person by Tex.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Refusal {
    BadAssignment,
    CliNotAllowed,
    CliNotReady,
    FolderNotAllowed,
    SlotsFull,
    KeptForOwner,
    DailyLimit,
    WeeklyLimit,
    OthersDailyLimit,
    OthersRunsLimit,
    TooLong,
    PlanLimit,
    LowMemory,
    ComputerUseOwnerOnly,
    NetworkNotAllowed,
    HelpersNotAllowed,
    AlreadyRunning,
}

/// One short step line: tool, action, target. Never file contents.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub job_id: String,
    pub part: u32,
    pub tool: String,
    pub action: String,
    pub target: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub job_id: String,
    pub part: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub model: Option<String>,
}

/// What the CLI said about the plan's own limits.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LimitSignal {
    pub cli: Cli,
    /// allowed, warning or rejected.
    pub status: String,
    /// e.g. five_hour, seven_day, primary, secondary.
    pub window: Option<String>,
    /// 0..1 when the CLI reports it.
    pub utilization: Option<f64>,
    /// Unix seconds.
    pub resets_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PartResult {
    pub job_id: String,
    pub part: u32,
    pub ok: bool,
    pub answer: String,
    pub session_id: String,
    /// cancelled, timedOut, interrupted, planLimit, notSignedIn, failed.
    pub error: Option<String>,
    pub seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub slots: u32,
    pub busy: u32,
    pub paused_until: Option<u64>,
    pub free_memory_mb: u64,
    pub used_today_minutes: u64,
    pub used_week_minutes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assignment_parses_from_camel_case() {
        let raw = r#"{"type":"assign","jobId":"j1","part":2,"cli":"claude","brief":"fix it",
            "folder":"/srv/code","workdir":"worktree","runGrant":"g","endpoint":"https://x/mcp",
            "deadlineAt":1,"own":true}"#;
        let msg: ServerMsg = serde_json::from_str(raw).unwrap();
        match msg {
            ServerMsg::Assign(a) => {
                assert_eq!(a.job_id, "j1");
                assert_eq!(a.cli, Cli::Claude);
                assert!(!a.network && !a.helpers && !a.computer_use);
                assert_eq!(a.resume_session_id, None);
            }
            other => panic!("parsed as {other:?}"),
        }
    }

    #[test]
    fn unknown_message_type_is_an_error_not_a_command() {
        let raw = r#"{"type":"exec","command":"rm -rf ~"}"#;
        assert!(serde_json::from_str::<ServerMsg>(raw).is_err());
    }

    #[test]
    fn mail_defaults_to_a_note() {
        let raw = r#"{"type":"message","jobId":"j","mail":{"from":"tex","text":"hi"}}"#;
        let ServerMsg::Message(m) = serde_json::from_str(raw).unwrap() else {
            panic!()
        };
        assert_eq!(m.mail.kind, MailKind::Note);
    }

    #[test]
    fn refused_serializes_with_camel_case_keys() {
        let s = serde_json::to_string(&RunnerMsg::Refused {
            job_id: "j".into(),
            part: 1,
            reason: Refusal::FolderNotAllowed,
        })
        .unwrap();
        assert_eq!(
            s,
            r#"{"type":"refused","jobId":"j","part":1,"reason":"folderNotAllowed"}"#
        );
    }
}

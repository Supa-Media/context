//! The messages between this runner and the workspace object that owns the
//! machine, mirroring `packages/shared/src/machineProtocol.schema.json`.
//!
//! The schema is the only definition. These types follow it field for field,
//! closed like it (`deny_unknown_fields`), and `tests/protocol_schema.rs`
//! reads and re-writes every example in `machineProtocol.examples.json` and
//! checks every message the schema names has a type here, so the two cannot
//! drift without a failing test.
//!
//! Nothing the gateway can send runs a command: an assignment's brief is words
//! for the agent, and every assignment is checked against the local rules
//! (`rules.rs`) before anything starts.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

/// `helloSigningText` in `machineProtocol.cjs`: bound to the purpose and the
/// machine, so a pairing signature or another machine's never passes.
pub fn hello_signing_text(machine_id: &str, nonce: &str) -> String {
    format!("context-machine-hello:v{PROTOCOL_VERSION}:{machine_id}:{nonce}")
}

/// `pairSigningText` in `machineProtocol.cjs`.
pub fn pair_signing_text(pairing_id: &str) -> String {
    format!("context-machine-pair:v{PROTOCOL_VERSION}:{pairing_id}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tool {
    Claude,
    Codex,
}

impl Tool {
    pub fn name(self) -> &'static str {
        match self {
            Tool::Claude => "claude",
            Tool::Codex => "codex",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionMode {
    Read,
    Edits,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageKind {
    Note,
    Ask,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefusalCode {
    Busy,
    Folder,
    Tool,
    NotReady,
    Memory,
    LimitDay,
    LimitWeek,
    LimitOthers,
    PlanLimit,
    Rule,
    UnknownRun,
    BadMessage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Finished,
    Failed,
    Cancelled,
    Limit,
    Lost,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolFact {
    pub name: String,
    pub installed: bool,
    pub signed_in: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Os {
    Macos,
    Linux,
    Windows,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MachineFacts {
    pub os: Os,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    pub arch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chip: Option<String>,
    pub memory_mb: u64,
    pub cores: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_screen: Option<bool>,
    pub tools: Vec<ToolFact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repos: Option<Vec<String>>,
    /// The tools this runner can sign in from the app (`signIn`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sign_in: Option<Vec<Tool>>,
    /// The tools this runner can install from the app (`install`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install: Option<Vec<Tool>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SlotCounts {
    pub recommended: u32,
    pub most: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    pub slots: u32,
    pub day_ms: u64,
    pub week_ms: u64,
    pub others_day_ms: u64,
    pub others_runs_per_day: u32,
    pub longest_run_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub week_tokens: Option<u64>,
    pub pause_near_plan_limit: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_one_for_owner: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
}

const HOUR_MS: u64 = 60 * 60 * 1000;

impl Default for Limits {
    /// `DEFAULT_LIMITS` in `machineProtocol.cjs`.
    fn default() -> Self {
        Limits {
            slots: 2,
            day_ms: 4 * HOUR_MS,
            week_ms: 20 * HOUR_MS,
            others_day_ms: 2 * HOUR_MS,
            others_runs_per_day: 10,
            longest_run_ms: 4 * HOUR_MS,
            week_tokens: None,
            pause_near_plan_limit: true,
            keep_one_for_owner: None,
            time_zone: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rules {
    pub folders: Vec<String>,
    pub tools: Vec<Tool>,
    pub limits: Limits,
    pub computer_use: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trusted_repos: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunGrant {
    pub token: String,
    pub expires_at: u64,
    pub mcp_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Assign {
    pub run_id: String,
    pub job_id: String,
    pub part: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub tool: Tool,
    pub folder: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    pub permission: PermissionMode,
    pub brief: String,
    pub done_when: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_session: Option<String>,
    pub grant: RunGrant,
    pub deadline: u64,
    pub from_owner: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat: Option<String>,
    pub network: bool,
    pub helpers: bool,
    pub computer_use: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Deliver {
    pub run_id: String,
    pub message_id: String,
    pub kind: MessageKind,
    pub from: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<u64>,
}

/// Mail for the machine itself, not one run: a session on it joined a note's
/// mail as this device. Kept in the inbox until that session was shown it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mail {
    pub message_id: String,
    pub kind: MessageKind,
    pub from: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    pub path: String,
    pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Interrupt {
    pub run_id: String,
    pub message_id: String,
    pub from: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CancelReason {
    Stopped,
    Limit,
    Removed,
    Disconnected,
    Superseded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cancel {
    pub run_id: String,
    pub reason: CancelReason,
}

/// The owner signs a coding tool in from the app: without a code, start the
/// tool's own sign-in and send its link; with one, hand the tool that code.
/// The code is never kept or logged.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignIn {
    pub sign_in_id: String,
    pub tool: Tool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl std::fmt::Debug for SignIn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignIn")
            .field("sign_in_id", &self.sign_in_id)
            .field("tool", &self.tool)
            .field("code", &self.code.as_ref().map(|_| "<withheld>"))
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SignInStep {
    Link,
    Done,
    Failed,
}

/// Where a sign-in from the app has got to; a fresh status follows an ending.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignInState {
    pub sign_in_id: String,
    pub tool: Tool,
    pub state: SignInStep,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// A one-time code the owner types on that page (a device sign-in, such as Codex's).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The owner installs a coding tool from the app: the maker's own published
/// build for this computer, checked against its published checksum. The frame
/// names only the tool; what is downloaded and run is fixed in the runner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Install {
    pub install_id: String,
    pub tool: Tool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallStep {
    Working,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallPhase {
    Finding,
    Downloading,
    Checking,
    Unpacking,
}

/// Where an install from the app has got to; a fresh status follows an ending.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallState {
    pub install_id: String,
    pub tool: Tool,
    pub state: InstallStep,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<InstallPhase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Challenge {
    pub protocol: u32,
    pub nonce: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Welcome {
    pub machine_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub rules: Rules,
    pub keep_runs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RulesChanged {
    pub rules: Rules,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoodbyeReason {
    Revoked,
    Replaced,
    BadSignature,
    Protocol,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Goodbye {
    pub reason: GoodbyeReason,
}

/// Every frame the workspace object sends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMsg {
    Challenge(Challenge),
    Welcome(Welcome),
    Rules(RulesChanged),
    Assign(Box<Assign>),
    Message(Deliver),
    Mail(Mail),
    Interrupt(Interrupt),
    Cancel(Cancel),
    SignIn(SignIn),
    Install(Install),
    Goodbye(Goodbye),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeldRun {
    pub run_id: String,
    pub alive: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_step: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hello {
    pub protocol: u32,
    pub machine_id: String,
    pub signature: String,
    pub runner: String,
    pub facts: MachineFacts,
    pub slots: SlotCounts,
    pub runs: Vec<HeldRun>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Accept {
    pub run_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Refuse {
    pub run_id: String,
    pub code: RefusalCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    pub run_id: String,
    pub session: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Step {
    pub run_id: String,
    pub seq: u64,
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    pub at: u64,
}

/// What the coding tool said or thought, for the chat's history (`said`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SaidKind {
    Text,
    Thinking,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Said {
    pub run_id: String,
    pub seq: u64,
    pub kind: SaidKind,
    pub text: String,
    pub at: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Usage {
    pub run_id: String,
    pub wall_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_limited: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_resets_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_utilization: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_window: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunResult {
    pub run_id: String,
    pub outcome: Outcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_step: Option<u64>,
    pub wall_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotReady {
    NoTool,
    SignedOut,
    Memory,
    Paused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Status {
    pub ready: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_ready: Option<NotReady>,
    pub busy: u32,
    pub free_memory_mb: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused_until: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolFact>>,
}

/// Every frame a runner sends.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RunnerMsg {
    Hello(Box<Hello>),
    Accept(Accept),
    Refuse(Refuse),
    Session(Session),
    Step(Step),
    Said(Said),
    Usage(Usage),
    Result(RunResult),
    Status(Status),
    SignInState(SignInState),
    InstallState(InstallState),
}

// Pairing, over HTTPS.

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairStart {
    pub public_key: String,
    pub name: String,
    pub facts: MachineFacts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairStarted {
    pub pairing_id: String,
    pub code: String,
    pub approve_url: String,
    pub expires_at: u64,
    pub poll_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairPoll {
    pub pairing_id: String,
    pub signature: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PairState {
    Waiting,
    Approved,
    Declined,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairStatus {
    pub status: PairState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket_url: Option<String>,
}

/// The schema's `Id`: what the gateway mints for machines, jobs, runs and
/// messages. Run and job ids become folder names, so this is checked before
/// any is used.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[cfg(test)]
mod schema_examples;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unknown_message_is_an_error_not_a_command() {
        assert!(
            serde_json::from_str::<ServerMsg>(r#"{"type":"exec","command":"rm -rf ~"}"#).is_err()
        );
        assert!(serde_json::from_str::<ServerMsg>(
            r#"{"type":"cancel","runId":"r","reason":"stopped","then":"x"}"#
        )
        .is_err());
    }

    #[test]
    fn signing_texts_match_the_gateways() {
        assert_eq!(
            hello_signing_text("mch_1", "n"),
            "context-machine-hello:v1:mch_1:n"
        );
        assert_eq!(
            pair_signing_text("pair_1"),
            "context-machine-pair:v1:pair_1"
        );
    }

    #[test]
    fn ids() {
        assert!(valid_id("run_1-a"));
        for bad in ["", "../x", "a/b", "a.b", "a:b", &"x".repeat(65)] {
            assert!(!valid_id(bad), "{bad}");
        }
    }
}

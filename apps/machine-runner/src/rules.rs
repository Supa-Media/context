//! The check every assignment passes on the machine before anything starts.
//!
//! The gateway checks too, so a slot is not taken in the first place. This is
//! the second check: neither a gateway bug nor a compromised gateway gets a job
//! past the folders, the tools or the limits the owner set, because the runner
//! refuses it here. The rules arrive in `welcome` and `rules` and are kept in
//! `rules.json`; `local.json`, which only the owner edits on the machine, can
//! narrow them further and nothing the gateway sends widens it.

use crate::limits::Ledger;
use crate::protocol::{Assign, PermissionMode, RefusalCode, Rules, Tool};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

pub const LONGEST_RUN_CEILING_MS: u64 = 24 * 60 * 60 * 1000;
pub const MAX_SLOTS: u32 = 8;

/// Narrowing the owner keeps on the machine itself. Every field is optional;
/// what is set only takes away.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalLimits {
    pub folders: Option<Vec<String>>,
    pub tools: Option<Vec<Tool>>,
    pub max_slots: Option<u32>,
    pub day_ms: Option<u64>,
    /// Take no one else's asks on this machine.
    pub owner_only: bool,
    /// Shell programs an `edits` run may start (git, pnpm, cargo, ...).
    /// Absent means the built-in list.
    pub allowed_commands: Option<Vec<String>>,
}

/// Programs an `edits` run may start without asking, when `local.json` names
/// none: version control and the usual build and test tools.
pub const DEFAULT_COMMANDS: &[&str] = &[
    "git",
    "gh",
    "ls",
    "cat",
    "head",
    "tail",
    "grep",
    "rg",
    "find",
    "wc",
    "diff",
    "mkdir",
    "node",
    "npm",
    "npx",
    "pnpm",
    "yarn",
    "bun",
    "deno",
    "tsc",
    "python",
    "python3",
    "pip",
    "pytest",
    "uv",
    "cargo",
    "rustc",
    "go",
    "make",
    "swift",
    "xcodebuild",
];

/// The rules after the owner's local narrowing and the hard ceilings.
pub fn effective(rules: &Rules, local: &LocalLimits, most: u32) -> Rules {
    let mut r = rules.clone();
    if let Some(allowed) = &local.folders {
        r.folders
            .retain(|f| allowed.iter().any(|a| Path::new(f).starts_with(a)));
    }
    if let Some(allowed) = &local.tools {
        r.tools.retain(|t| allowed.contains(t));
    }
    let l = &mut r.limits;
    l.slots = l.slots.clamp(1, most.clamp(1, MAX_SLOTS));
    if let Some(max) = local.max_slots {
        l.slots = l.slots.min(max.max(1));
    }
    if let Some(d) = local.day_ms {
        l.day_ms = l.day_ms.min(d);
    }
    if local.owner_only {
        l.others_runs_per_day = 0;
        l.others_day_ms = 0;
    }
    l.others_day_ms = l.others_day_ms.min(l.day_ms);
    l.longest_run_ms = l.longest_run_ms.clamp(60_000, LONGEST_RUN_CEILING_MS);
    r
}

pub fn allowed_commands(local: &LocalLimits) -> Vec<String> {
    match &local.allowed_commands {
        Some(list) => list
            .iter()
            .filter(|c| is_program_name(c))
            .cloned()
            .collect(),
        None => DEFAULT_COMMANDS.iter().map(|s| s.to_string()).collect(),
    }
}

/// A program name for `Bash(<name>:*)`: no spaces, no shell, no path tricks.
pub fn is_program_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-+".contains(c))
}

/// Where the machine stands when an assignment arrives.
pub struct Snapshot<'a> {
    pub now_ms: u64,
    pub running: u32,
    pub running_runs: &'a [String],
    pub available_mb: u64,
    pub claude_ready: bool,
    pub codex_ready: bool,
    pub ledger: &'a Ledger,
    pub utc_offset_minutes: i32,
}

/// A refusal, with when it stops holding where the runner knows.
#[derive(Debug, PartialEq, Eq)]
pub struct Refused {
    pub code: RefusalCode,
    pub until: Option<u64>,
}

fn no(code: RefusalCode) -> Refused {
    Refused { code, until: None }
}

/// Every reason a run must not start here, checked in order; the first wins.
/// Returns the allowed folder the run's folder resolves to.
pub fn check(rules: &Rules, a: &Assign, s: &Snapshot) -> Result<PathBuf, Refused> {
    use RefusalCode::*;
    if !crate::protocol::valid_id(&a.run_id)
        || !crate::protocol::valid_id(&a.job_id)
        || a.grant.token.is_empty()
        || !endpoint_ok(&a.grant.mcp_url)
        || s.running_runs.iter().any(|r| r == &a.run_id)
    {
        return Err(no(BadMessage));
    }
    if !rules.tools.contains(&a.tool) {
        return Err(no(Tool));
    }
    let ready = match a.tool {
        crate::protocol::Tool::Claude => s.claude_ready,
        crate::protocol::Tool::Codex => s.codex_ready,
    };
    if !ready {
        return Err(no(NotReady));
    }
    let folders: Vec<PathBuf> = rules.folders.iter().map(PathBuf::from).collect();
    let root = allowed_root(&folders, Path::new(&a.folder)).ok_or(no(Folder))?;
    if a.computer_use && (!a.from_owner || !rules.computer_use) {
        return Err(no(Rule));
    }
    if !a.from_owner && a.permission == PermissionMode::Full {
        return Err(no(Rule));
    }
    let l = &rules.limits;
    if s.running >= l.slots {
        return Err(no(Busy));
    }
    if !a.from_owner && l.keep_one_for_owner == Some(true) && s.running + 1 >= l.slots {
        return Err(no(Busy));
    }
    if s.available_mb < crate::slots::MIN_FREE_MB {
        return Err(no(Memory));
    }
    if l.pause_near_plan_limit {
        if let Some(until) = s.ledger.paused_until_ms(a.tool).filter(|u| *u > s.now_ms) {
            return Err(Refused {
                code: PlanLimit,
                until: Some(until),
            });
        }
    }
    let day = s.ledger.day_of(s.now_ms, s.utc_offset_minutes);
    let tomorrow = Some(s.ledger.day_start_ms(day + 1, s.utc_offset_minutes));
    let today = s.ledger.day(day);
    if today.total_ms() >= l.day_ms {
        return Err(Refused {
            code: LimitDay,
            until: tomorrow,
        });
    }
    if s.ledger.week_ms(day) >= l.week_ms {
        return Err(no(LimitWeek));
    }
    if let Some(cap) = l.week_tokens {
        if s.ledger.week_tokens(day) >= cap {
            return Err(no(LimitWeek));
        }
    }
    if !a.from_owner
        && (today.others_ms >= l.others_day_ms || today.others_runs >= l.others_runs_per_day)
    {
        return Err(Refused {
            code: LimitOthers,
            until: tomorrow,
        });
    }
    if a.deadline <= s.now_ms || a.deadline - s.now_ms > l.longest_run_ms {
        return Err(no(Rule));
    }
    Ok(root)
}

/// The run grant goes only to an https endpoint, or to this machine itself for
/// a self-hosted gateway under test.
pub fn endpoint_ok(url: &str) -> bool {
    if let Some(rest) = url.strip_prefix("https://") {
        return !rest.is_empty();
    }
    ["http://127.0.0.1:", "http://localhost:"]
        .iter()
        .any(|p| url.starts_with(p))
}

/// The allowed folder that holds `folder`, compared after resolving symlinks
/// and `..`, so neither a link nor a dotted path walks out of the wall. A
/// folder that does not exist is refused: there is nothing to resolve.
pub fn allowed_root(allowed: &[PathBuf], folder: &Path) -> Option<PathBuf> {
    if !folder.is_absolute() {
        return None;
    }
    let real = std::fs::canonicalize(folder).ok()?;
    allowed.iter().find_map(|root| {
        let root_real = std::fs::canonicalize(root).ok()?;
        if is_too_broad(&root_real) {
            return None;
        }
        real.starts_with(&root_real).then_some(root_real)
    })
}

/// A folder that would put the whole machine or the person's whole home in
/// reach is never an allowed folder, whatever the settings say.
pub fn is_too_broad(p: &Path) -> bool {
    if p.components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count()
        == 0
    {
        return true;
    }
    if let Some(home) = home_dir().and_then(|h| std::fs::canonicalize(h).ok()) {
        if home.starts_with(p) {
            return true;
        }
    }
    false
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests;

//! The machine's own copy of its rules, and the check every assignment passes
//! before anything starts.
//!
//! The gateway checks too, so a slot is not taken in the first place. This is
//! the second check: neither a gateway bug nor a compromised gateway gets a job
//! past the folders, the tools or the limits the owner set, because the runner
//! refuses it here. The rules arrive from the workspace object and are kept in
//! `rules.json`; `local.json`, which only the owner edits on the machine, can
//! narrow them further and nothing the gateway sends widens it.

use crate::limits::Ledger;
use crate::protocol::{Assignment, Cli, Refusal};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Rules {
    /// Folders a run may work in. Empty means nowhere: a machine with no
    /// folder set takes no job.
    pub folders: Vec<PathBuf>,
    /// Which CLIs may run here.
    pub clis: Vec<Cli>,
    /// Sessions at once, as the owner chose (clamped to the machine's most).
    pub slots: u32,
    /// Hold one slot back for the owner's own asks.
    pub keep_one_for_me: bool,
    pub daily_minutes: u64,
    pub weekly_minutes: u64,
    /// How much of the day other people's asks may use, under the daily total.
    pub others_daily_minutes: u64,
    /// Runs other people may start per day.
    pub others_runs_per_day: u32,
    /// Longest a job may run here: 4 hours by default, up to 24.
    pub max_job_minutes: u64,
    /// Stop taking work when a CLI says the plan is nearly used, until the
    /// reset it names.
    pub pause_near_plan: bool,
    /// Network for other people's runs.
    pub others_network: bool,
    /// Claude Code's own helpers for other people's runs.
    pub others_helpers: bool,
    /// Claude Code permission mode: acceptEdits (default) or bypassPermissions.
    pub permission_mode: String,
    /// Shell commands a run may use, by program name (git, pnpm, cargo, ...).
    /// Ignored under bypassPermissions.
    pub allowed_commands: Vec<String>,
    /// Repositories whose own `.claude` settings and `.mcp.json` may load for
    /// other people's runs. The owner's own runs always load them.
    pub trusted_repos: Vec<PathBuf>,
    /// The owner's offset from UTC right now, in minutes, so "today" is the
    /// owner's day. Sent fresh with every settings message.
    pub utc_offset_minutes: i32,
}

impl Default for Rules {
    fn default() -> Self {
        Rules {
            folders: vec![],
            clis: vec![Cli::Claude, Cli::Codex],
            slots: 1,
            keep_one_for_me: false,
            daily_minutes: 4 * 60,
            weekly_minutes: 20 * 60,
            others_daily_minutes: 2 * 60,
            others_runs_per_day: 10,
            max_job_minutes: 4 * 60,
            pause_near_plan: true,
            others_network: false,
            others_helpers: false,
            permission_mode: "acceptEdits".into(),
            allowed_commands: vec!["git".into()],
            trusted_repos: vec![],
            utc_offset_minutes: 0,
        }
    }
}

pub const MAX_JOB_MINUTES_CEILING: u64 = 24 * 60;
const PERMISSION_MODES: &[&str] = &["acceptEdits", "bypassPermissions", "default", "plan"];

/// Narrowing the owner keeps on the machine itself. Every field is optional;
/// what is set can only take away.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalLimits {
    pub folders: Option<Vec<PathBuf>>,
    pub clis: Option<Vec<Cli>>,
    pub max_slots: Option<u32>,
    pub daily_minutes: Option<u64>,
    pub no_others: bool,
}

impl Rules {
    /// The rules after the owner's local narrowing and the hard ceilings.
    pub fn effective(&self, local: &LocalLimits, most: u32) -> Rules {
        let mut r = self.clone();
        if let Some(allowed) = &local.folders {
            r.folders.retain(|f| allowed.iter().any(|a| inside(f, a)));
        }
        if let Some(allowed) = &local.clis {
            r.clis.retain(|c| allowed.contains(c));
        }
        r.slots = r.slots.clamp(1, most.max(1));
        if let Some(max) = local.max_slots {
            r.slots = r.slots.min(max.max(1));
        }
        if let Some(d) = local.daily_minutes {
            r.daily_minutes = r.daily_minutes.min(d);
        }
        if local.no_others {
            r.others_runs_per_day = 0;
            r.others_daily_minutes = 0;
        }
        r.others_daily_minutes = r.others_daily_minutes.min(r.daily_minutes);
        r.max_job_minutes = r.max_job_minutes.clamp(1, MAX_JOB_MINUTES_CEILING);
        if !PERMISSION_MODES.contains(&r.permission_mode.as_str()) {
            r.permission_mode = "acceptEdits".into();
        }
        r.allowed_commands.retain(|c| is_program_name(c));
        r
    }
}

/// A program name for `Bash(<name>:*)`: no spaces, no shell, no path tricks.
fn is_program_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-+".contains(c))
}

/// Where the machine stands when an assignment arrives.
pub struct Snapshot<'a> {
    pub now_ms: u64,
    pub running: u32,
    pub running_job_ids: &'a [String],
    pub available_mb: u64,
    pub claude_ready: bool,
    pub codex_ready: bool,
    pub ledger: &'a Ledger,
}

/// Every reason a job must not start here, checked in order; the first wins.
/// Returns the allowed folder the job's folder sits in.
pub fn check(rules: &Rules, a: &Assignment, s: &Snapshot) -> Result<PathBuf, Refusal> {
    if !valid_job_id(&a.job_id) || a.run_grant.is_empty() || !endpoint_ok(&a.endpoint) {
        return Err(Refusal::BadAssignment);
    }
    if s.running_job_ids.iter().any(|j| j == &a.job_id) {
        return Err(Refusal::AlreadyRunning);
    }
    if !rules.clis.contains(&a.cli) {
        return Err(Refusal::CliNotAllowed);
    }
    let ready = match a.cli {
        Cli::Claude => s.claude_ready,
        Cli::Codex => s.codex_ready,
    };
    if !ready {
        return Err(Refusal::CliNotReady);
    }
    let root = allowed_root(&rules.folders, &a.folder).ok_or(Refusal::FolderNotAllowed)?;
    if !a.own {
        if a.computer_use {
            return Err(Refusal::ComputerUseOwnerOnly);
        }
        if a.network && !rules.others_network {
            return Err(Refusal::NetworkNotAllowed);
        }
        if a.helpers && !rules.others_helpers {
            return Err(Refusal::HelpersNotAllowed);
        }
    }
    if s.running >= rules.slots {
        return Err(Refusal::SlotsFull);
    }
    if !a.own && rules.keep_one_for_me && s.running + 1 >= rules.slots {
        return Err(Refusal::KeptForOwner);
    }
    if s.available_mb < crate::slots::MIN_FREE_MB {
        return Err(Refusal::LowMemory);
    }
    if rules.pause_near_plan && s.ledger.paused_until_ms(a.cli).is_some_and(|until| until > s.now_ms) {
        return Err(Refusal::PlanLimit);
    }
    let day = s.ledger.day_of(s.now_ms, rules.utc_offset_minutes);
    let today = s.ledger.day(day);
    if today.total_secs() >= rules.daily_minutes * 60 {
        return Err(Refusal::DailyLimit);
    }
    if s.ledger.week_secs(day) >= rules.weekly_minutes * 60 {
        return Err(Refusal::WeeklyLimit);
    }
    if !a.own {
        if today.others_secs >= rules.others_daily_minutes * 60 {
            return Err(Refusal::OthersDailyLimit);
        }
        if today.others_runs >= rules.others_runs_per_day {
            return Err(Refusal::OthersRunsLimit);
        }
    }
    if a.deadline_at <= s.now_ms || a.deadline_at - s.now_ms > rules.max_job_minutes * 60_000 {
        return Err(Refusal::TooLong);
    }
    Ok(root)
}

/// The run grant goes only to an https endpoint, or to this machine itself for
/// a self-hosted gateway under test.
pub fn endpoint_ok(url: &str) -> bool {
    if url.starts_with("https://") {
        return url.len() > "https://".len();
    }
    ["http://127.0.0.1:", "http://localhost:"].iter().any(|p| url.starts_with(p))
}

/// Job ids end up in folder names, so they are kept to a safe alphabet.
pub fn valid_job_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || "-_:.".contains(c)) && !id.starts_with('.')
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
        inside(&real, &root_real).then_some(root_real)
    })
}

/// A folder that would put the whole machine or the person's whole home in
/// reach is never an allowed folder, whatever the settings say.
pub fn is_too_broad(p: &Path) -> bool {
    if p.components().filter(|c| matches!(c, Component::Normal(_))).count() == 0 {
        return true;
    }
    if let Some(home) = home_dir() {
        if let Ok(home) = std::fs::canonicalize(home) {
            if home.starts_with(p) {
                return true;
            }
        }
    }
    false
}

/// `child` is `parent` or under it, component by component (so `/srv/code2`
/// is not inside `/srv/code`).
pub fn inside(child: &Path, parent: &Path) -> bool {
    child.starts_with(parent)
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from)
}

#[cfg(test)]
mod tests;

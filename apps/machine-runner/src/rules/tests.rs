//! The wall around a run. Each test names the threat-table line it guards
//! (design doc: "Security and permissions"); docs/sabotage.md records the
//! sabotage runs that proved each one fails when its check is removed.

use super::*;
use crate::protocol::Workdir;
use std::fs;

const NOW: u64 = 1_800_000_000_000;

struct Fixture {
    _dir: tempfile::TempDir,
    allowed: PathBuf,
    outside: PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let allowed = dir.path().join("code");
    let outside = dir.path().join("private");
    fs::create_dir_all(allowed.join("repo")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    Fixture { allowed, outside, _dir: dir }
}

fn rules(f: &Fixture) -> Rules {
    Rules { folders: vec![f.allowed.clone()], slots: 3, ..Rules::default() }
}

fn assignment(folder: PathBuf, own: bool) -> Assignment {
    Assignment {
        job_id: "job_1".into(),
        part: 1,
        cli: Cli::Claude,
        brief: "fix the flaky test".into(),
        done_when: String::new(),
        folder,
        workdir: Workdir::Worktree,
        run_grant: "grant".into(),
        endpoint: "https://context.example/mcp".into(),
        deadline_at: NOW + 60 * 60_000,
        own,
        asker: None,
        network: false,
        helpers: false,
        computer_use: false,
        resume_session_id: None,
    }
}

fn snap<'a>(ledger: &'a Ledger, running: u32) -> Snapshot<'a> {
    Snapshot {
        now_ms: NOW,
        running,
        running_job_ids: &[],
        available_mb: 8000,
        claude_ready: true,
        codex_ready: false,
        ledger,
    }
}

#[test]
fn a_run_inside_the_allowed_folder_starts() {
    let f = fixture();
    let l = Ledger::default();
    let root = check(&rules(&f), &assignment(f.allowed.join("repo"), true), &snap(&l, 0)).unwrap();
    assert_eq!(root, fs::canonicalize(&f.allowed).unwrap());
}

// Threat: "a group member uses your machine to read your files".
#[test]
fn a_run_never_starts_outside_the_allowed_folders() {
    let f = fixture();
    let l = Ledger::default();
    let r = rules(&f);
    for folder in [
        f.outside.clone(),
        f.allowed.join("repo/../../private"),
        PathBuf::from("relative/path"),
        f.allowed.join("missing"),
    ] {
        assert_eq!(check(&r, &assignment(folder.clone(), false), &snap(&l, 0)), Err(Refusal::FolderNotAllowed), "{folder:?}");
    }
}

#[test]
fn a_sibling_with_the_same_prefix_is_outside() {
    let f = fixture();
    let sibling = f.allowed.with_file_name("code2");
    fs::create_dir_all(&sibling).unwrap();
    let l = Ledger::default();
    assert_eq!(check(&rules(&f), &assignment(sibling, true), &snap(&l, 0)), Err(Refusal::FolderNotAllowed));
}

#[cfg(unix)]
#[test]
fn a_symlink_out_of_the_allowed_folder_is_outside() {
    let f = fixture();
    let link = f.allowed.join("escape");
    std::os::unix::fs::symlink(&f.outside, &link).unwrap();
    let l = Ledger::default();
    assert_eq!(check(&rules(&f), &assignment(link, true), &snap(&l, 0)), Err(Refusal::FolderNotAllowed));
}

#[test]
fn the_root_or_the_home_folder_is_never_an_allowed_folder() {
    assert!(is_too_broad(Path::new("/")));
    if let Some(home) = home_dir().and_then(|h| fs::canonicalize(h).ok()) {
        assert!(is_too_broad(&home));
        if let Some(parent) = home.parent() {
            assert!(is_too_broad(parent));
        }
    }
}

// Threat: "our gateway is compromised and sends a command" — an assignment
// outside the local rules is refused on the machine.
#[test]
fn limits_are_enforced_on_the_machine_when_the_gateway_is_wrong() {
    let f = fixture();
    let r = rules(&f);
    let mut l = Ledger::default();
    let day = l.day_of(NOW, 0);
    l.add_time(day, r.daily_minutes * 60, true);
    assert_eq!(check(&r, &assignment(f.allowed.clone(), true), &snap(&l, 0)), Err(Refusal::DailyLimit));

    let l = Ledger::default();
    assert_eq!(check(&r, &assignment(f.allowed.clone(), true), &snap(&l, 3)), Err(Refusal::SlotsFull));

    let mut long = assignment(f.allowed.clone(), true);
    long.deadline_at = NOW + (r.max_job_minutes + 1) * 60_000;
    assert_eq!(check(&r, &long, &snap(&l, 0)), Err(Refusal::TooLong));

    let mut codex = assignment(f.allowed.clone(), true);
    codex.cli = Cli::Codex;
    assert_eq!(check(&r, &codex, &snap(&l, 0)), Err(Refusal::CliNotReady));
}

#[test]
fn the_week_limit_counts_earlier_days() {
    let f = fixture();
    let r = Rules { weekly_minutes: 60, ..rules(&f) };
    let mut l = Ledger::default();
    let day = l.day_of(NOW, 0);
    l.add_time(day - 3, 3600, true);
    assert_eq!(check(&r, &assignment(f.allowed.clone(), true), &snap(&l, 0)), Err(Refusal::WeeklyLimit));
}

#[test]
fn others_have_their_own_share_and_the_owner_is_not_blocked_by_it() {
    let f = fixture();
    let r = rules(&f);
    let mut l = Ledger::default();
    let day = l.day_of(NOW, 0);
    l.add_time(day, r.others_daily_minutes * 60, false);
    assert_eq!(check(&r, &assignment(f.allowed.clone(), false), &snap(&l, 0)), Err(Refusal::OthersDailyLimit));
    assert!(check(&r, &assignment(f.allowed.clone(), true), &snap(&l, 0)).is_ok());

    let mut l = Ledger::default();
    for _ in 0..r.others_runs_per_day {
        l.count_others_run(day);
    }
    assert_eq!(check(&r, &assignment(f.allowed.clone(), false), &snap(&l, 0)), Err(Refusal::OthersRunsLimit));
}

#[test]
fn computer_use_network_and_helpers_are_the_owners_unless_opened() {
    let f = fixture();
    let r = rules(&f);
    let l = Ledger::default();
    let mut a = assignment(f.allowed.clone(), false);
    a.computer_use = true;
    assert_eq!(check(&r, &a, &snap(&l, 0)), Err(Refusal::ComputerUseOwnerOnly));
    let mut a = assignment(f.allowed.clone(), false);
    a.network = true;
    assert_eq!(check(&r, &a, &snap(&l, 0)), Err(Refusal::NetworkNotAllowed));
    let mut a = assignment(f.allowed.clone(), false);
    a.helpers = true;
    assert_eq!(check(&r, &a, &snap(&l, 0)), Err(Refusal::HelpersNotAllowed));
    // The owner's own ask may use all three.
    let mut a = assignment(f.allowed.clone(), true);
    a.computer_use = true;
    a.network = true;
    a.helpers = true;
    assert!(check(&r, &a, &snap(&l, 0)).is_ok());
    // Computer use stays the owner's whatever the settings say.
    let open = Rules { others_network: true, others_helpers: true, ..rules(&f) };
    let mut a = assignment(f.allowed.clone(), false);
    a.computer_use = true;
    assert_eq!(check(&open, &a, &snap(&l, 0)), Err(Refusal::ComputerUseOwnerOnly));
}

#[test]
fn keep_one_for_me_holds_the_last_slot() {
    let f = fixture();
    let r = Rules { keep_one_for_me: true, ..rules(&f) };
    let l = Ledger::default();
    assert_eq!(check(&r, &assignment(f.allowed.clone(), false), &snap(&l, 2)), Err(Refusal::KeptForOwner));
    assert!(check(&r, &assignment(f.allowed.clone(), true), &snap(&l, 2)).is_ok());
}

#[test]
fn a_plan_pause_holds_until_its_reset() {
    let f = fixture();
    let r = rules(&f);
    let mut l = Ledger::default();
    l.pause(Cli::Claude, NOW + 1000);
    assert_eq!(check(&r, &assignment(f.allowed.clone(), true), &snap(&l, 0)), Err(Refusal::PlanLimit));
    l.paused_until.clear();
    l.pause(Cli::Claude, NOW - 1);
    assert!(check(&r, &assignment(f.allowed.clone(), true), &snap(&l, 0)).is_ok());
}

#[test]
fn low_memory_takes_no_new_job() {
    let f = fixture();
    let l = Ledger::default();
    let mut s = snap(&l, 0);
    s.available_mb = 100;
    assert_eq!(check(&rules(&f), &assignment(f.allowed.clone(), true), &s), Err(Refusal::LowMemory));
}

#[test]
fn bad_assignments_are_refused() {
    let f = fixture();
    let l = Ledger::default();
    let r = rules(&f);
    for (job, grant, endpoint) in [
        ("../../etc", "g", "https://x/mcp"),
        ("job", "", "https://x/mcp"),
        ("job", "g", "http://evil.example/mcp"),
        ("job", "g", "http://localhost.evil.example/mcp"),
    ] {
        let mut a = assignment(f.allowed.clone(), true);
        a.job_id = job.into();
        a.run_grant = grant.into();
        a.endpoint = endpoint.into();
        assert_eq!(check(&r, &a, &snap(&l, 0)), Err(Refusal::BadAssignment), "{job} {endpoint}");
    }
    let mut s = snap(&l, 0);
    let ids = vec!["job_1".to_string()];
    s.running_job_ids = &ids;
    assert_eq!(check(&r, &assignment(f.allowed.clone(), true), &s), Err(Refusal::AlreadyRunning));
}

#[test]
fn local_limits_only_narrow() {
    let f = fixture();
    let wide = Rules {
        folders: vec![f.allowed.clone(), f.outside.clone()],
        slots: 8,
        daily_minutes: 600,
        max_job_minutes: 99_999,
        permission_mode: "yolo".into(),
        allowed_commands: vec!["git".into(), "rm -rf /".into(), "$(curl x)".into()],
        ..Rules::default()
    };
    let local = LocalLimits {
        folders: Some(vec![f.allowed.clone()]),
        max_slots: Some(2),
        daily_minutes: Some(60),
        clis: Some(vec![Cli::Claude]),
        no_others: true,
    };
    let e = wide.effective(&local, 4);
    assert_eq!(e.folders, vec![f.allowed.clone()]);
    assert_eq!(e.slots, 2);
    assert_eq!(e.daily_minutes, 60);
    assert_eq!(e.clis, vec![Cli::Claude]);
    assert_eq!(e.others_runs_per_day, 0);
    assert_eq!(e.max_job_minutes, MAX_JOB_MINUTES_CEILING);
    assert_eq!(e.permission_mode, "acceptEdits");
    assert_eq!(e.allowed_commands, vec!["git".to_string()]);
    // Settings asking for more slots than the machine has get its most.
    assert_eq!(Rules { slots: 50, ..Rules::default() }.effective(&LocalLimits::default(), 3).slots, 3);
}

#[test]
fn a_machine_with_no_folder_takes_no_job() {
    let f = fixture();
    let l = Ledger::default();
    let r = Rules { folders: vec![], ..rules(&f) };
    assert_eq!(check(&r, &assignment(f.allowed.clone(), true), &snap(&l, 0)), Err(Refusal::FolderNotAllowed));
}

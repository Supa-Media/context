//! The wall around a run. Each test names the threat-table line it guards
//! (design doc, "Security and permissions"); docs/runner.md records the
//! sabotage runs that proved each one fails when its check is removed.

use super::*;
use crate::protocol::{Limits, RunGrant};
use std::fs;

const NOW: u64 = 1_800_000_000_000;
const MIN: u64 = 60_000;

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
    Fixture {
        allowed,
        outside,
        _dir: dir,
    }
}

fn s(p: &Path) -> String {
    p.display().to_string()
}

fn rules(f: &Fixture) -> Rules {
    Rules {
        folders: vec![s(&f.allowed)],
        tools: vec![Tool::Claude, Tool::Codex],
        limits: Limits {
            slots: 3,
            ..Limits::default()
        },
        computer_use: true,
        trusted_repos: None,
    }
}

fn assign(folder: &Path, from_owner: bool) -> Assign {
    Assign {
        run_id: "run_1".into(),
        job_id: "job_1".into(),
        part: 1,
        title: None,
        tool: Tool::Claude,
        folder: s(folder),
        repo: None,
        permission: PermissionMode::Edits,
        brief: "fix the flaky test".into(),
        done_when: String::new(),
        advice: None,
        resume_session: None,
        grant: RunGrant {
            token: "grant".into(),
            expires_at: NOW + 60 * MIN,
            mcp_url: "https://context.example/mcp".into(),
        },
        deadline: NOW + 60 * MIN,
        from_owner,
        asker: None,
        chat: None,
        network: false,
        helpers: false,
        computer_use: false,
    }
}

fn snap(ledger: &Ledger, running: u32) -> Snapshot<'_> {
    Snapshot {
        now_ms: NOW,
        running,
        running_runs: &[],
        available_mb: 8000,
        claude_ready: true,
        codex_ready: false,
        ledger,
        utc_offset_minutes: 0,
    }
}

fn code(r: Result<PathBuf, Refused>) -> Option<RefusalCode> {
    r.err().map(|e| e.code)
}

#[test]
fn a_run_inside_the_allowed_folder_starts() {
    let f = fixture();
    let l = Ledger::default();
    let root = check(
        &rules(&f),
        &assign(&f.allowed.join("repo"), true),
        &snap(&l, 0),
    )
    .unwrap();
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
        assert_eq!(
            code(check(&r, &assign(&folder, false), &snap(&l, 0))),
            Some(RefusalCode::Folder),
            "{folder:?}"
        );
    }
}

#[test]
fn a_sibling_with_the_same_prefix_is_outside() {
    let f = fixture();
    let sibling = f.allowed.with_file_name("code2");
    fs::create_dir_all(&sibling).unwrap();
    let l = Ledger::default();
    assert_eq!(
        code(check(&rules(&f), &assign(&sibling, true), &snap(&l, 0))),
        Some(RefusalCode::Folder)
    );
}

#[cfg(unix)]
#[test]
fn a_symlink_out_of_the_allowed_folder_is_outside() {
    let f = fixture();
    let link = f.allowed.join("escape");
    std::os::unix::fs::symlink(&f.outside, &link).unwrap();
    let l = Ledger::default();
    assert_eq!(
        code(check(&rules(&f), &assign(&link, true), &snap(&l, 0))),
        Some(RefusalCode::Folder)
    );
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

// Threat: "our gateway is compromised and sends a command": an assignment
// outside the local rules is refused on the machine.
#[test]
fn limits_are_enforced_on_the_machine_when_the_gateway_is_wrong() {
    let f = fixture();
    let r = rules(&f);
    let mut l = Ledger::default();
    let day = l.day_of(NOW, 0);
    l.add_time(day, r.limits.day_ms, true);
    let refused = check(&r, &assign(&f.allowed, true), &snap(&l, 0)).unwrap_err();
    assert_eq!(refused.code, RefusalCode::LimitDay);
    assert_eq!(refused.until, Some(l.day_start_ms(day + 1, 0)));

    let l = Ledger::default();
    assert_eq!(
        code(check(&r, &assign(&f.allowed, true), &snap(&l, 3))),
        Some(RefusalCode::Busy)
    );

    let mut long = assign(&f.allowed, true);
    long.deadline = NOW + r.limits.longest_run_ms + MIN;
    assert_eq!(
        code(check(&r, &long, &snap(&l, 0))),
        Some(RefusalCode::Rule)
    );

    let mut codex = assign(&f.allowed, true);
    codex.tool = Tool::Codex;
    assert_eq!(
        code(check(&r, &codex, &snap(&l, 0))),
        Some(RefusalCode::NotReady)
    );

    let only_codex = Rules {
        tools: vec![Tool::Codex],
        ..rules(&f)
    };
    assert_eq!(
        code(check(&only_codex, &assign(&f.allowed, true), &snap(&l, 0))),
        Some(RefusalCode::Tool)
    );
}

#[test]
fn the_week_limits_count_earlier_days() {
    let f = fixture();
    let r = Rules {
        limits: Limits {
            week_ms: 60 * MIN,
            ..rules(&f).limits
        },
        ..rules(&f)
    };
    let mut l = Ledger::default();
    let day = l.day_of(NOW, 0);
    l.add_time(day - 3, 60 * MIN, true);
    assert_eq!(
        code(check(&r, &assign(&f.allowed, true), &snap(&l, 0))),
        Some(RefusalCode::LimitWeek)
    );

    let r = Rules {
        limits: Limits {
            week_tokens: Some(1000),
            ..rules(&f).limits
        },
        ..rules(&f)
    };
    let mut l = Ledger::default();
    l.add_tokens(day - 1, 1000);
    assert_eq!(
        code(check(&r, &assign(&f.allowed, true), &snap(&l, 0))),
        Some(RefusalCode::LimitWeek)
    );
}

#[test]
fn others_have_their_own_share_and_the_owner_is_not_blocked_by_it() {
    let f = fixture();
    let r = rules(&f);
    let mut l = Ledger::default();
    let day = l.day_of(NOW, 0);
    l.add_time(day, r.limits.others_day_ms, false);
    assert_eq!(
        code(check(&r, &assign(&f.allowed, false), &snap(&l, 0))),
        Some(RefusalCode::LimitOthers)
    );
    assert!(check(&r, &assign(&f.allowed, true), &snap(&l, 0)).is_ok());

    let mut l = Ledger::default();
    for _ in 0..r.limits.others_runs_per_day {
        l.count_others_run(day);
    }
    assert_eq!(
        code(check(&r, &assign(&f.allowed, false), &snap(&l, 0))),
        Some(RefusalCode::LimitOthers)
    );
}

#[test]
fn computer_use_and_full_permission_are_the_owners_alone() {
    let f = fixture();
    let r = rules(&f);
    let l = Ledger::default();
    let mut a = assign(&f.allowed, false);
    a.computer_use = true;
    assert_eq!(code(check(&r, &a, &snap(&l, 0))), Some(RefusalCode::Rule));
    let mut a = assign(&f.allowed, false);
    a.permission = PermissionMode::Full;
    assert_eq!(code(check(&r, &a, &snap(&l, 0))), Some(RefusalCode::Rule));
    let mut a = assign(&f.allowed, true);
    a.computer_use = true;
    a.permission = PermissionMode::Full;
    assert!(check(&r, &a, &snap(&l, 0)).is_ok());
    // And for the owner only when the machine allows it at all.
    let off = Rules {
        computer_use: false,
        ..rules(&f)
    };
    assert_eq!(code(check(&off, &a, &snap(&l, 0))), Some(RefusalCode::Rule));
}

#[test]
fn keep_one_for_the_owner_holds_the_last_slot() {
    let f = fixture();
    let r = Rules {
        limits: Limits {
            keep_one_for_owner: Some(true),
            ..rules(&f).limits
        },
        ..rules(&f)
    };
    let l = Ledger::default();
    assert_eq!(
        code(check(&r, &assign(&f.allowed, false), &snap(&l, 2))),
        Some(RefusalCode::Busy)
    );
    assert!(check(&r, &assign(&f.allowed, true), &snap(&l, 2)).is_ok());
}

#[test]
fn a_plan_pause_holds_until_its_reset() {
    let f = fixture();
    let r = rules(&f);
    let mut l = Ledger::default();
    l.pause(Tool::Claude, NOW + 1000);
    let refused = check(&r, &assign(&f.allowed, true), &snap(&l, 0)).unwrap_err();
    assert_eq!(
        refused,
        Refused {
            code: RefusalCode::PlanLimit,
            until: Some(NOW + 1000)
        }
    );
    l.paused_until.clear();
    l.pause(Tool::Claude, NOW - 1);
    assert!(check(&r, &assign(&f.allowed, true), &snap(&l, 0)).is_ok());
}

#[test]
fn low_memory_takes_no_new_run() {
    let f = fixture();
    let l = Ledger::default();
    let mut sn = snap(&l, 0);
    sn.available_mb = 100;
    assert_eq!(
        code(check(&rules(&f), &assign(&f.allowed, true), &sn)),
        Some(RefusalCode::Memory)
    );
}

#[test]
fn bad_assignments_are_refused() {
    let f = fixture();
    let l = Ledger::default();
    let r = rules(&f);
    for (run, token, url) in [
        ("../../etc", "g", "https://x/mcp"),
        ("run", "", "https://x/mcp"),
        ("run", "g", "http://evil.example/mcp"),
        ("run", "g", "http://localhost.evil.example/mcp"),
    ] {
        let mut a = assign(&f.allowed, true);
        a.run_id = run.into();
        a.grant.token = token.into();
        a.grant.mcp_url = url.into();
        assert_eq!(
            code(check(&r, &a, &snap(&l, 0))),
            Some(RefusalCode::BadMessage),
            "{run} {url}"
        );
    }
    let ids = vec!["run_1".to_string()];
    let mut sn = snap(&l, 0);
    sn.running_runs = &ids;
    assert_eq!(
        code(check(&r, &assign(&f.allowed, true), &sn)),
        Some(RefusalCode::BadMessage)
    );
}

#[test]
fn local_limits_only_narrow() {
    let f = fixture();
    let wide = Rules {
        folders: vec![s(&f.allowed), s(&f.outside)],
        tools: vec![Tool::Claude, Tool::Codex],
        limits: Limits {
            slots: 8,
            day_ms: 600 * MIN,
            longest_run_ms: u64::MAX,
            ..Limits::default()
        },
        computer_use: false,
        trusted_repos: None,
    };
    let local = LocalLimits {
        folders: Some(vec![s(&f.allowed)]),
        max_slots: Some(2),
        day_ms: Some(60 * MIN),
        tools: Some(vec![Tool::Claude]),
        owner_only: true,
        allowed_commands: Some(vec!["git".into(), "rm -rf /".into(), "$(curl x)".into()]),
    };
    let e = effective(&wide, &local, 4);
    assert_eq!(e.folders, vec![s(&f.allowed)]);
    assert_eq!(e.limits.slots, 2);
    assert_eq!(e.limits.day_ms, 60 * MIN);
    assert_eq!(e.tools, vec![Tool::Claude]);
    assert_eq!(e.limits.others_runs_per_day, 0);
    assert_eq!(e.limits.longest_run_ms, LONGEST_RUN_CEILING_MS);
    assert_eq!(allowed_commands(&local), vec!["git".to_string()]);
    // Settings asking for more slots than the machine has get its most.
    let many = Rules {
        limits: Limits {
            slots: 50,
            ..Limits::default()
        },
        ..wide.clone()
    };
    assert_eq!(effective(&many, &LocalLimits::default(), 3).limits.slots, 3);
}

#[test]
fn a_machine_with_no_folder_takes_no_run() {
    let f = fixture();
    let l = Ledger::default();
    let r = Rules {
        folders: vec![],
        ..rules(&f)
    };
    assert_eq!(
        code(check(&r, &assign(&f.allowed, true), &snap(&l, 0))),
        Some(RefusalCode::Folder)
    );
}

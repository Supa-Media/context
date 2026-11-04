//! What this machine has spent, counted by the runner itself.
//!
//! We never see the subscription, so limits are kept in things the runner can
//! count for certain: wall-clock agent time per day and per week in the owner's
//! own day, the tokens the CLIs report, how many runs other people started, and
//! the pause a CLI asks for when it says the plan is nearly used. Kept in
//! `ledger.json` beside the rules, so a restart does not hand anyone a fresh
//! day.

use crate::protocol::Tool;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Day {
    pub own_ms: u64,
    pub others_ms: u64,
    pub others_runs: u32,
    pub tokens: u64,
}

impl Day {
    pub fn total_ms(&self) -> u64 {
        self.own_ms + self.others_ms
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Ledger {
    /// Owner-local day number (days since 1970-01-01 in the owner's zone).
    pub days: BTreeMap<i64, Day>,
    /// Until when each tool is paused for its plan's limit, Unix ms.
    pub paused_until: BTreeMap<String, u64>,
}

const DAY_MS: i64 = 86_400_000;
/// Days kept: the week plus a margin for a clock or zone change.
const KEEP_DAYS: i64 = 9;

impl Ledger {
    pub fn day_of(&self, now_ms: u64, utc_offset_minutes: i32) -> i64 {
        (now_ms as i64 + utc_offset_minutes as i64 * 60_000).div_euclid(DAY_MS)
    }

    /// When an owner-local day starts, Unix ms.
    pub fn day_start_ms(&self, day: i64, utc_offset_minutes: i32) -> u64 {
        (day * DAY_MS - utc_offset_minutes as i64 * 60_000).max(0) as u64
    }

    pub fn day(&self, day: i64) -> Day {
        self.days.get(&day).copied().unwrap_or_default()
    }

    /// The seven days ending with `day`.
    pub fn week_ms(&self, day: i64) -> u64 {
        self.days
            .range(day - 6..=day)
            .map(|(_, d)| d.total_ms())
            .sum()
    }

    pub fn week_tokens(&self, day: i64) -> u64 {
        self.days.range(day - 6..=day).map(|(_, d)| d.tokens).sum()
    }

    /// A run started by someone other than the owner counts against their
    /// share at the moment it starts, so a burst of asks cannot all slip in.
    pub fn count_others_run(&mut self, day: i64) {
        self.days.entry(day).or_default().others_runs += 1;
    }

    /// Adds a run's time to the day it ran in. Called as the run goes, not
    /// only at the end, so a crash mid-run still counts what was spent.
    pub fn add_time(&mut self, day: i64, ms: u64, own: bool) {
        let d = self.days.entry(day).or_default();
        if own {
            d.own_ms += ms;
        } else {
            d.others_ms += ms;
        }
        self.days.retain(|k, _| *k > day - KEEP_DAYS);
    }

    pub fn add_tokens(&mut self, day: i64, tokens: u64) {
        self.days.entry(day).or_default().tokens += tokens;
    }

    pub fn paused_until_ms(&self, tool: Tool) -> Option<u64> {
        self.paused_until.get(tool.name()).copied()
    }

    /// Pause a tool until the reset it named. Never shortens a longer pause.
    pub fn pause(&mut self, tool: Tool, until_ms: u64) {
        let e = self
            .paused_until
            .entry(tool.name().to_string())
            .or_insert(0);
        *e = (*e).max(until_ms);
    }

    pub fn clear_expired(&mut self, now_ms: u64) {
        self.paused_until.retain(|_, until| *until > now_ms);
    }
}

/// The owner's offset from UTC right now, for an IANA zone such as
/// `America/New_York`, asked of the system's own zone database (`date`), so the
/// runner carries none. A zone it cannot read counts as UTC.
pub fn utc_offset_minutes(zone: Option<&str>) -> i32 {
    let Some(zone) = zone.filter(|z| {
        !z.is_empty()
            && z.len() <= 64
            && z.chars()
                .all(|c| c.is_ascii_alphanumeric() || "/_+-".contains(c))
    }) else {
        return 0;
    };
    let out = std::process::Command::new("date")
        .arg("+%z")
        .env("TZ", zone)
        .output();
    out.ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| parse_offset(s.trim()))
        .unwrap_or(0)
}

/// `-0500` is -300 minutes.
pub fn parse_offset(s: &str) -> Option<i32> {
    if s.len() != 5 {
        return None;
    }
    let sign = match &s[..1] {
        "+" => 1,
        "-" => -1,
        _ => return None,
    };
    let h: i32 = s[1..3].parse().ok()?;
    let m: i32 = s[3..5].parse().ok()?;
    Some(sign * (h * 60 + m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_owners_day_follows_their_offset() {
        let l = Ledger::default();
        // 2026-11-04T03:00Z is still Nov 3 in New York (UTC-5).
        let t = 1_793_761_200_000u64;
        assert_eq!(l.day_of(t, -300) + 1, l.day_of(t, 0));
        let day = l.day_of(t, -300);
        assert!(l.day_start_ms(day, -300) <= t && t < l.day_start_ms(day + 1, -300));
    }

    #[test]
    fn week_is_the_seven_days_ending_today() {
        let mut l = Ledger::default();
        for d in 0..10 {
            l.days.insert(
                d,
                Day {
                    own_ms: 60,
                    tokens: 1,
                    ..Default::default()
                },
            );
        }
        assert_eq!(l.week_ms(9), 7 * 60);
        assert_eq!(l.week_tokens(9), 7);
    }

    #[test]
    fn old_days_are_dropped() {
        let mut l = Ledger::default();
        l.add_time(1, 10, true);
        l.add_time(20, 10, false);
        assert_eq!(l.days.len(), 1);
        assert_eq!(l.day(20).others_ms, 10);
    }

    #[test]
    fn a_pause_is_never_shortened() {
        let mut l = Ledger::default();
        l.pause(Tool::Claude, 500);
        l.pause(Tool::Claude, 100);
        assert_eq!(l.paused_until_ms(Tool::Claude), Some(500));
        l.clear_expired(600);
        assert_eq!(l.paused_until_ms(Tool::Claude), None);
    }

    #[test]
    fn offsets() {
        assert_eq!(parse_offset("-0500"), Some(-300));
        assert_eq!(parse_offset("+0530"), Some(330));
        assert_eq!(parse_offset("junk"), None);
        assert_eq!(utc_offset_minutes(Some("UTC")), 0);
        assert_eq!(utc_offset_minutes(Some("$(rm -rf ~)")), 0);
        assert_eq!(utc_offset_minutes(Some("Asia/Kolkata")), 330);
    }
}

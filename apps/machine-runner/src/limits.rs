//! What this machine has spent, counted by the runner itself.
//!
//! We never see the subscription, so limits are kept in things the runner can
//! count for certain: wall-clock agent time per day and per week in the owner's
//! own day, how many runs other people started, and the pause a CLI asks for
//! when it says the plan is nearly used. Kept in `ledger.json` beside the
//! rules, so a restart does not hand anyone a fresh day.

use crate::protocol::Cli;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Day {
    pub own_secs: u64,
    pub others_secs: u64,
    pub others_runs: u32,
}

impl Day {
    pub fn total_secs(&self) -> u64 {
        self.own_secs + self.others_secs
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Ledger {
    /// Owner-local day number (days since 1970-01-01 in the owner's zone).
    pub days: BTreeMap<i64, Day>,
    /// Until when each CLI is paused for its plan's limit, Unix ms.
    pub paused_until: BTreeMap<String, u64>,
}

const DAY_MS: i64 = 86_400_000;
/// Days kept: the week plus a margin for a clock or zone change.
const KEEP_DAYS: i64 = 9;

impl Ledger {
    pub fn day_of(&self, now_ms: u64, utc_offset_minutes: i32) -> i64 {
        (now_ms as i64 + utc_offset_minutes as i64 * 60_000).div_euclid(DAY_MS)
    }

    pub fn day(&self, day: i64) -> Day {
        self.days.get(&day).copied().unwrap_or_default()
    }

    /// The seven days ending with `day`.
    pub fn week_secs(&self, day: i64) -> u64 {
        self.days.range(day - 6..=day).map(|(_, d)| d.total_secs()).sum()
    }

    /// A run started by someone other than the owner counts against their
    /// share at the moment it starts, so a burst of asks cannot all slip in.
    pub fn count_others_run(&mut self, day: i64) {
        self.days.entry(day).or_default().others_runs += 1;
    }

    /// Adds a run's time to the day it ran in. Called as the run goes, not
    /// only at the end, so a crash mid-run still counts what was spent.
    pub fn add_time(&mut self, day: i64, secs: u64, own: bool) {
        let d = self.days.entry(day).or_default();
        if own {
            d.own_secs += secs;
        } else {
            d.others_secs += secs;
        }
        self.days.retain(|k, _| *k > day - KEEP_DAYS);
    }

    pub fn paused_until_ms(&self, cli: Cli) -> Option<u64> {
        self.paused_until.get(cli.name()).copied()
    }

    /// Pause a CLI until the reset it named. Never shortens a longer pause.
    pub fn pause(&mut self, cli: Cli, until_ms: u64) {
        let e = self.paused_until.entry(cli.name().to_string()).or_insert(0);
        *e = (*e).max(until_ms);
    }

    pub fn clear_expired(&mut self, now_ms: u64) {
        self.paused_until.retain(|_, until| *until > now_ms);
    }
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
    }

    #[test]
    fn week_is_the_seven_days_ending_today() {
        let mut l = Ledger::default();
        for d in 0..10 {
            l.days.insert(d, Day { own_secs: 60, ..Default::default() });
        }
        assert_eq!(l.week_secs(9), 7 * 60);
    }

    #[test]
    fn old_days_are_dropped() {
        let mut l = Ledger::default();
        l.add_time(1, 10, true);
        l.add_time(20, 10, false);
        assert_eq!(l.days.len(), 1);
        assert_eq!(l.day(20).others_secs, 10);
    }

    #[test]
    fn a_pause_is_never_shortened() {
        let mut l = Ledger::default();
        l.pause(Cli::Claude, 500);
        l.pause(Cli::Claude, 100);
        assert_eq!(l.paused_until_ms(Cli::Claude), Some(500));
        l.clear_expired(600);
        assert_eq!(l.paused_until_ms(Cli::Claude), None);
    }
}

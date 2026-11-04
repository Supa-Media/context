//! How many sessions this machine should run at once.
//!
//! Two numbers, worked out from the machine every time it connects, so an
//! upgraded VM offers more:
//!
//! - **recommended**, for a machine the person also uses: the smaller of
//!   (memory − 4 GB kept for the person) ÷ 1.5 GB and cores ÷ 2;
//! - **most**, for a machine that only runs Tex: the smaller of
//!   (memory − 2 GB) ÷ 1.5 GB and the number of cores, never over 8.
//!
//! Both are at least 1. 1.5 GB per session counts what a session runs (tests,
//! builds); the spike measured Claude Code itself at about 210 MB.

use crate::protocol::SlotCounts;

pub const SESSION_MB: u64 = 1536;
pub const KEEP_FOR_PERSON_MB: u64 = 4096;
pub const KEEP_FOR_SYSTEM_MB: u64 = 2048;
pub const MOST_CEILING: u32 = 8;
/// Below this much available memory the runner takes no new job, whatever the
/// setting: the person opened something heavy.
pub const MIN_FREE_MB: u64 = 1024;

pub fn advise(memory_mb: u64, cores: u32) -> SlotCounts {
    let by_mem = |kept: u64| (memory_mb.saturating_sub(kept) / SESSION_MB) as u32;
    let recommended = by_mem(KEEP_FOR_PERSON_MB).min(cores / 2).max(1);
    let most = by_mem(KEEP_FOR_SYSTEM_MB).min(cores).clamp(1, MOST_CEILING);
    SlotCounts {
        recommended: recommended.min(most),
        most,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_design_docs_examples() {
        // A 2-core 4 GB VM, 1 and 1; a 4-core 8 GB VM, 2 and 4; a 16 GB
        // laptop with 8 cores, 4 and 8.
        assert_eq!(
            advise(4096, 2),
            SlotCounts {
                recommended: 1,
                most: 1
            }
        );
        assert_eq!(
            advise(8192, 4),
            SlotCounts {
                recommended: 2,
                most: 4
            }
        );
        assert_eq!(
            advise(16384, 8),
            SlotCounts {
                recommended: 4,
                most: 8
            }
        );
    }

    #[test]
    fn never_zero_and_never_over_eight() {
        assert_eq!(
            advise(512, 1),
            SlotCounts {
                recommended: 1,
                most: 1
            }
        );
        assert_eq!(advise(1 << 20, 128).most, 8);
    }
}

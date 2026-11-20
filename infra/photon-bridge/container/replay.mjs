/**
 * The limits that decide what the bridge delivers after a restart, and when it
 * stops waiting for a sequence Photon never sent. One place, so the ledger,
 * the listener, the container's health and the Worker's alerts agree.
 */

/**
 * The oldest event (by Apple's stamp) a catch-up may still deliver. An older
 * replay is completed without being queued: Tex would answer old texts.
 * MUST equal MAX_REPLAY_MS in packages/tex/worker/replayWindow.ts (a test checks it).
 */
export const MAX_REPLAY_MS = 12 * 60 * 60 * 1000;

/**
 * How long a missing sequence may hold a line's frontier before it is skipped.
 * Photon's log has gaps it never sends (2026-11-19: seq 1197 held the frontier
 * for two days), and nothing else would ever move it.
 */
export const GAP_TIMEOUT_MS = 10 * 60_000;

/** A frontier unmoved this long while newer events arrive is stuck, and logged as an alert. */
export const FRONTIER_STUCK_ALERT_MS = 15 * 60_000;

/** A first catch-up that replays more than this many events, or reaches back further than the lag below, is an alert. */
export const BIG_REPLAY_EVENTS = 50;
export const BIG_REPLAY_LAG_MS = 60 * 60_000;

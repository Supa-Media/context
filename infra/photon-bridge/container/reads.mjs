/**
 * The container's memory of the last Photon read that finished.
 * The first catch-up after a start is logged with how far behind it was,
 * so a later burst can be split between Photon and the bridge. A first
 * catch-up that is large or reaches far back is also an alert: it is history
 * the bridge is about to decide on (`replay.mjs`, `ledger.mjs`).
 */

import { BIG_REPLAY_EVENTS, BIG_REPLAY_LAG_MS } from "./replay.mjs";

export function createReads(log, now = Date.now) {
  let startedAt = null;
  let lastReadAt = null;
  const logged = new Set();

  return {
    start() {
      if (startedAt == null) startedAt = now();
    },

    /** A catch-up finished. The first one per line is the start replay. */
    catchup(line, stats) {
      lastReadAt = now();
      if (logged.has(line)) return;
      logged.add(line);
      log({
        event: "line.read",
        first: true,
        line,
        replayed: stats.replayed,
        lag_ms: stats.lagMs,
      });
      if (stats.replayed > BIG_REPLAY_EVENTS || stats.lagMs > BIG_REPLAY_LAG_MS) {
        log({ event: "bridge.alert", outcome: "big_replay", line, replayed: stats.replayed, lag_ms: stats.lagMs });
      }
    },

    /** A later poll finished. Counts as a read; there was nothing to replay. */
    poll(line) {
      lastReadAt = now();
      log({ event: "line.read", line, replayed: 0, lag_ms: 0 });
    },

    fail(line, code) {
      log({ event: "line.read_failed", line, error: code });
    },

    snapshot() {
      return { startedAt, lastReadAt };
    },
  };
}

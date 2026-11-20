/**
 * The container's in-memory queue of mapped events, and each line's contiguous
 * frontier.
 *
 * The durable checkpoint is the Durable Object's, not this one. The container
 * holds events only until the object acks them; after a restart the object
 * sends the frontiers it stored, and catch-up replays everything above them.
 * Nothing here is the only copy of anything: Photon's event log is.
 *
 * Frontier rule (docs/events, "Concurrent Recovery"): a line's frontier moves
 * to sequence N only when every sequence up to N has completed. Completed means
 * unmapped (nothing for the agent), acked by the object, skipped as missing
 * after a full catch-up or GAP_TIMEOUT_MS (Photon's log never sent it), or a
 * replay older than MAX_REPLAY_MS (dropped, not delivered).
 */
import { randomBytes } from "node:crypto";
import { mapEvent } from "./map.mjs";
import { GAP_TIMEOUT_MS, MAX_REPLAY_MS } from "./replay.mjs";

/** A skip wider than this is not a gap but a bad number; it is refused, not looped over. */
const MAX_SKIP = 1_000_000;
const NONE = Object.freeze({ skipped: 0, first: null });

export function createLedger({ checkpoints = {}, runId = randomBytes(6).toString("hex"), now = Date.now } = {}) {
  const lines = new Map();
  const queue = [];
  const waiters = [];
  // Raw events passed with nothing for the agent, by type, so the health line shows what the bridge does not read.
  const skipped = new Map();
  let counter = 0;
  let replayDropped = 0;
  let gapSkipped = 0;

  for (const [line, seq] of Object.entries(checkpoints)) {
    lines.set(line, { frontier: seq, completed: new Set(), queued: new Set(), movedAt: now(), lastNewAt: null, gapSince: undefined });
  }

  function stateOf(line) {
    let state = lines.get(line);
    if (!state) {
      state = { frontier: undefined, completed: new Set(), queued: new Set(), movedAt: undefined, lastNewAt: null, gapSince: undefined };
      lines.set(line, state);
    }
    return state;
  }

  /** Moves the frontier over every completed sequence that follows it. A move restarts the gap clock. */
  function advance(state) {
    let moved = false;
    while (state.completed.has(state.frontier + 1)) {
      state.frontier += 1;
      state.completed.delete(state.frontier);
      moved = true;
    }
    if (moved) {
      state.movedAt = now();
      state.gapSince = undefined;
    }
    return state.frontier;
  }

  /**
   * Starts or clears the gap clock: a gap is a sequence after the frontier that
   * nothing has completed, while something above it is completed or queued.
   * The clock runs from when the gap was first seen, not from the next sweep.
   */
  function noteGap(state) {
    const gap = state.frontier !== undefined
      && !state.queued.has(state.frontier + 1)
      && (state.completed.size > 0 || state.queued.size > 0);
    if (!gap) state.gapSince = undefined;
    else if (state.gapSince === undefined) state.gapSince = now();
  }

  function complete(line, seq) {
    const state = stateOf(line);
    if (state.frontier === undefined || seq <= state.frontier) return state.frontier;
    state.completed.add(seq);
    advance(state);
    noteGap(state);
    return state.frontier;
  }

  /**
   * Marks every sequence in (frontier, upTo] that is neither queued nor
   * completed as completed: Photon's log does not hold it. Then advances the
   * frontier as far as it goes (a queued sequence still stops it).
   * Returns {skipped, first, frontier}.
   */
  function skipUpTo(line, upTo) {
    const state = lines.get(line);
    if (!state || state.frontier === undefined || upTo <= state.frontier) {
      return { skipped: 0, first: null, frontier: state?.frontier ?? null };
    }
    if (upTo - state.frontier > MAX_SKIP) return { skipped: 0, first: null, frontier: state.frontier };
    let count = 0;
    let first = null;
    for (let seq = state.frontier + 1; seq <= upTo; seq += 1) {
      if (state.queued.has(seq) || state.completed.has(seq)) continue;
      state.completed.add(seq);
      count += 1;
      if (first === null) first = seq;
    }
    advance(state);
    noteGap(state);
    gapSkipped += count;
    return { skipped: count, first, frontier: state.frontier };
  }

  function wake() {
    while (waiters.length > 0 && queue.length > 0) waiters.shift()();
  }

  return {
    /** The frontier for a line, or undefined when the line has none yet. */
    frontier(line) {
      return lines.get(line)?.frontier;
    },

    /** Sets a line's frontier before its first event, if it has none. */
    initialize(line, seq) {
      const state = stateOf(line);
      if (state.frontier === undefined) {
        state.frontier = seq;
        state.movedAt = now();
        noteGap(state);
      }
      return state.frontier;
    },

    /**
     * Takes one raw event from a line's live stream or catch-up. Returns
     * "queued", "completed" (nothing to deliver) or "seen" (already handled).
     * `replay` marks a catch-up event: one older than MAX_REPLAY_MS is completed
     * without being queued, so a restart never delivers old history.
     */
    offer(line, event, extras = {}, { replay = false } = {}) {
      const seq = event?.sequence;
      if (!Number.isSafeInteger(seq)) return "seen";
      const state = stateOf(line);
      if (state.frontier === undefined) throw new Error("line frontier not initialized");
      if (seq > state.frontier) state.lastNewAt = now();
      if (seq <= state.frontier || state.completed.has(seq) || state.queued.has(seq)) return "seen";
      const mapped = mapEvent(event, line, extras);
      if (!mapped) {
        const type = typeof event.type === "string" ? event.type.slice(0, 40) : "unknown";
        skipped.set(type, (skipped.get(type) ?? 0) + 1);
        complete(line, seq);
        return "completed";
      }
      if (replay) {
        mapped.replay = true;
        if (!mapped.atGuessed && Date.parse(mapped.at) < now() - MAX_REPLAY_MS) {
          replayDropped += 1;
          complete(line, seq);
          return "completed";
        }
      }
      counter += 1;
      queue.push({ id: `${runId}:${counter}`, line, seq, event: mapped });
      state.queued.add(seq);
      noteGap(state);
      wake();
      return "queued";
    },

    /**
     * Queues an event the bridge made itself (a send's delivery check, `delivery.mjs`): it has no sequence in Photon's
     * log, so it never moves a frontier, and a restart loses it (the check is best effort).
     */
    push(line, event) {
      counter += 1;
      queue.push({ id: `${runId}:${counter}`, line, seq: null, event });
      wake();
    },

    /** The oldest queued event the object has not acked, or null. */
    next() {
      return queue[0] ?? null;
    },

    /** Resolves with the next queued event, or null after `ms`. */
    wait(ms) {
      if (queue.length > 0) return Promise.resolve(queue[0]);
      return new Promise((resolve) => {
        const waiter = () => {
          clearTimeout(timer);
          resolve(queue[0]);
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          resolve(null);
        }, ms);
        waiters.push(waiter);
      });
    },

    /**
     * The object delivered event `id` and stored nothing it can lose: removes
     * it from the queue and advances the frontier. Returns {line, frontier},
     * or null for an id this container no longer holds (a restart).
     */
    ack(id) {
      const index = queue.findIndex((item) => item.id === id);
      if (index < 0) return null;
      const [item] = queue.splice(index, 1);
      const state = stateOf(item.line);
      if (item.seq === null) return { line: item.line, frontier: state.frontier };
      state.queued.delete(item.seq);
      return { line: item.line, frontier: complete(item.line, item.seq) };
    },

    skipMissing(line, upTo) {
      return skipUpTo(line, upTo);
    },

    /**
     * Called after each successful Photon read. When a gap has held for
     * GAP_TIMEOUT_MS, skips it up to the highest sequence seen above it.
     * Queued sequences still block, so the frontier stops before the first one.
     */
    sweep(line) {
      const state = lines.get(line);
      if (!state || state.frontier === undefined || state.gapSince === undefined) {
        return { skipped: 0, first: null, frontier: state?.frontier ?? null };
      }
      if (now() - state.gapSince < GAP_TIMEOUT_MS) return { skipped: 0, first: null, frontier: state.frontier };
      let highest = state.frontier;
      for (const seq of state.completed) if (seq > highest) highest = seq;
      for (const seq of state.queued) if (seq > highest) highest = seq;
      return skipUpTo(line, highest);
    },

    /** Frontiers for the Durable Object to store: `{ [line]: frontier }` for lines that have one. */
    checkpoints() {
      return Object.fromEntries(
        [...lines.entries()]
          .filter(([, state]) => state.frontier !== undefined)
          .map(([line, state]) => [line, state.frontier]),
      );
    },

    /** Frontiers, queue depth and the skip and drop counts, for health; never event content. */
    snapshot() {
      const at = now();
      return {
        queued: queue.length,
        skipped: Object.fromEntries(skipped),
        replayDropped,
        gapSkipped,
        lines: [...lines.entries()].map(([line, state]) => ({
          line,
          frontier: state.frontier ?? null,
          // Newer events arrived after the frontier last moved, and it has not moved since.
          stuckMs: state.movedAt !== undefined && state.lastNewAt !== null && state.lastNewAt > state.movedAt
            ? at - state.movedAt
            : null,
        })),
      };
    },
  };
}

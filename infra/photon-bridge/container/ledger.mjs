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
 * unmapped (nothing for the agent) or acked by the object.
 */
import { randomBytes } from "node:crypto";
import { mapEvent } from "./map.mjs";

export function createLedger({ checkpoints = {}, runId = randomBytes(6).toString("hex") } = {}) {
  const lines = new Map();
  const queue = [];
  const waiters = [];
  // Raw events passed with nothing for the agent, by type, so the health line shows what the bridge does not read.
  const skipped = new Map();
  let counter = 0;

  for (const [line, seq] of Object.entries(checkpoints)) {
    lines.set(line, { frontier: seq, completed: new Set(), queued: new Set() });
  }

  function stateOf(line) {
    let state = lines.get(line);
    if (!state) {
      state = { frontier: undefined, completed: new Set(), queued: new Set() };
      lines.set(line, state);
    }
    return state;
  }

  function complete(line, seq) {
    const state = stateOf(line);
    if (state.frontier === undefined || seq <= state.frontier) return state.frontier;
    state.completed.add(seq);
    while (state.completed.has(state.frontier + 1)) {
      state.frontier += 1;
      state.completed.delete(state.frontier);
    }
    return state.frontier;
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
      if (state.frontier === undefined) state.frontier = seq;
      return state.frontier;
    },

    /**
     * Takes one raw event from a line's live stream or catch-up. Returns
     * "queued", "completed" (nothing to deliver) or "seen" (already handled).
     */
    offer(line, event, extras = {}) {
      const seq = event?.sequence;
      if (!Number.isSafeInteger(seq)) return "seen";
      const state = stateOf(line);
      if (state.frontier === undefined) throw new Error("line frontier not initialized");
      if (seq <= state.frontier || state.completed.has(seq) || state.queued.has(seq)) return "seen";
      const mapped = mapEvent(event, line, extras);
      if (!mapped) {
        const type = typeof event.type === "string" ? event.type.slice(0, 40) : "unknown";
        skipped.set(type, (skipped.get(type) ?? 0) + 1);
        complete(line, seq);
        return "completed";
      }
      counter += 1;
      queue.push({ id: `${runId}:${counter}`, line, seq, event: mapped });
      state.queued.add(seq);
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

    /** Frontiers and queue depth, for health; never event content. */
    snapshot() {
      return {
        queued: queue.length,
        skipped: Object.fromEntries(skipped),
        lines: [...lines.entries()].map(([line, state]) => ({ line, frontier: state.frontier ?? null })),
      };
    },
  };
}

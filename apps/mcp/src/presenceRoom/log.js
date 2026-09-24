import { UPDATE_LOG_CAP } from "../presence.js";

/* -------------------------------- the log ------------------------------- */

/**
 * Every update this room has relayed, oldest first.
 *
 * In Durable Object storage rather than memory, because hibernation evicts
 * memory and somebody rejoining must not find the last ten minutes of
 * everybody's typing gone. Keys are zero-padded so a lexicographic `list`
 * returns them in arrival order, which is the order they must be applied in.
 *
 * **This is the one place in the feature where note content is durable
 * outside the customer's bucket**, and it is deliberately the shortest-lived
 * copy in the system: the client elected to save writes the merged text to
 * the bucket on a debounce, and the log is dropped once the room empties.
 * `docs/decisions/gateway-protocol.md` states what that costs.
 */
export async function readLog() {
  const stored = await this.state.storage.list({ prefix: "u:" });
  return [...stored.values()];
}

/**
 * Add one entry to the log.
 *
 * `checkpoint` says this entry is a complete state from a client the room
 * knows has seen everything before it, so everything before it can go. That
 * is the only path by which anything is ever deleted from the log, and the
 * delete happens *after* the write, so a failure between them leaves a
 * longer log rather than a shorter one.
 */
export async function appendUpdate(update, { checkpoint = false } = {}) {
  const seq = ((await this.state.storage.get("seq")) ?? 0) + 1;
  const key = `u:${String(seq).padStart(9, "0")}`;
  await this.state.storage.put({ [key]: update, seq });
  if (checkpoint) await this.dropLogBefore(key);
  else if (seq % 50 === 0) await this.askForSnapshotIfLong();
}

/** Everything before a confirmed checkpoint, which is now redundant. */
export async function dropLogBefore(key) {
  const existing = await this.state.storage.list({ prefix: "u:", end: key });
  if (existing.size === 0) return;
  await this.state.storage.delete([...existing.keys()]);
}

/**
 * Ask somebody to compact, once the log is long enough to slow a join.
 *
 * The *oldest* socket, because it has been applying updates longest and is
 * likeliest to hold the whole document. Asked rather than told: a client
 * that ignores this costs a slower join and nothing else.
 */
export async function askForSnapshotIfLong() {
  const entries = await this.state.storage.list({ prefix: "u:" });
  if (entries.size < UPDATE_LOG_CAP) return;
  const sockets = this.openSockets();
  if (sockets.length === 0) return;
  try {
    sockets[0].send(JSON.stringify({ t: "compact" }));
  } catch {
    // The next fifty updates ask again.
  }
}

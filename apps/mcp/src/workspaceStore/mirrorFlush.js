/**
 * Sends a workspace object's queued changes to the control plane, oldest first (`mirrorOutbox.js`), one flush at a
 * time per object. `send(workspaceId, changes)` answers `{applied: seq[], skipped: ({seq, reason}|seq)[], stopped?}`:
 * what it took is dropped from the queue; what it did not take stays, and the flush reports `done: false` so the
 * caller retries later (the alarm, 30 s on). A throw keeps everything queued.
 */

const BATCH = 100;

const defaultLog = (event, fields) => console.log(JSON.stringify({ event, ...fields }));

/** Runs of consecutive queued changes that name the same workspace. */
function groupByWorkspace(items) {
  const groups = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.workspaceId === item.workspaceId) last.items.push(item);
    else groups.push({ workspaceId: item.workspaceId, items: [item] });
  }
  return groups;
}

/** Sends one group; returns `null` when every change in it was taken or refused, else why it was not. */
async function sendGroup(store, send, group, log) {
  let answer;
  try {
    answer = await send(group.workspaceId, group.items.map((item) => ({ seq: item.seq, ...item.change })));
  } catch {
    // A fixed reason only: a change's content never reaches a log.
    return "error";
  }
  const applied = Array.isArray(answer?.applied) ? answer.applied : [];
  const skipped = (Array.isArray(answer?.skipped) ? answer.skipped : []).map((entry) => (typeof entry === "number" ? { seq: entry, reason: null } : entry));
  store.mirror.drop([...applied, ...skipped.map((entry) => entry.seq)]);
  store.mirror.noteSkipped(skipped.length);
  for (const entry of skipped) log("workspace_mirror_skipped", { seq: entry.seq, reason: entry.reason ?? null });
  const taken = new Set([...applied, ...skipped.map((entry) => entry.seq)]);
  // Anything the control plane neither took nor refused (a stop, or an answer that names none of it) stays queued.
  if (group.items.every((item) => taken.has(item.seq))) return null;
  return answer?.stopped ? "stopped" : "unanswered";
}

async function drain(store, send, log) {
  for (;;) {
    const items = store.mirror.pending(BATCH);
    if (items.length === 0) return { done: true };
    for (const group of groupByWorkspace(items)) {
      const why = await sendGroup(store, send, group, log);
      if (why !== null) {
        store.mirror.noteFailure();
        log("workspace_mirror_failed", { workspaceId: group.workspaceId, reason: why, owed: store.mirror.count() });
        return { done: false };
      }
    }
  }
}

/**
 * One flush at a time per object: a second caller waits for the running flush, then drains whatever is left
 * itself. The running flush is kept on `store` in memory; a restart simply starts a new one from the queue.
 */
export async function flushMirror(store, send, log = defaultLog) {
  while (store.mirrorRunning) {
    try {
      await store.mirrorRunning;
    } catch {
      // drain never rejects; this only guards a flush that has already ended.
    }
  }
  const run = (async () => {
    try {
      return await drain(store, send, log);
    } finally {
      if (store.mirrorRunning === run) store.mirrorRunning = null;
    }
  })();
  store.mirrorRunning = run;
  return await run;
}

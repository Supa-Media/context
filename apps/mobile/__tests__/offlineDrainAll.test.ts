/**
 * A RECONNECTION EMPTIED ONE QUEUE AND LEFT THE REST.
 *
 * The queue in this folder is per context and always was — one outbox record
 * per workspace, keyed by workspace id — but only one of them was ever
 * *drained*, because `useOfflineNotes` hydrates and drains the context the
 * console is showing and nothing hydrated the others.
 *
 * So: edit a note in your own context, switch to a shared one and edit there,
 * go through a tunnel, come back. The context on screen sends its writes. The
 * other one sits unsent until somebody happens to navigate into it. Nothing was
 * lost — the queue is durable and `sweep` is forbidden to touch it — but "your
 * edit will go when you reconnect" was true of one context and not of the rest,
 * and `waitingOnDevice` would go on counting those writes at sign-out, where the
 * button next to the count throws them away.
 *
 * `drainOtherContexts` is the pass that closes it. This file proves the four
 * things that make it safe to run beside the foreground drain:
 *
 *  1. It takes the queues nobody is looking at, and **never** the open one.
 *  2. Every write goes to the workspace its queue is **filed under**, which is
 *     the cross-tenant property: a sender bound to the open context would have
 *     written four contexts' edits into whichever one was on screen.
 *  3. It is the same conflict-checked write, with the same `expectedEtag` and
 *     the same parking, because it is `drainOutbox` and there is no second
 *     write path.
 *  4. A sign-out part-way through stops it, and does not re-persist a queue the
 *     person was warned about and chose to discard.
 *
 * **Sabotage record** (temporary local edits, reverted):
 *
 *  - Dropping `if (workspaceId === exceptWorkspaceId) continue;` — 1 failure,
 *    "the open context's queue is left to the console that owns it".
 *  - Sending every entry to the *open* context rather than to the one its queue
 *    is filed under — 2 failures, the cross-tenant test and the exclusion test,
 *    which is the right shape: the second catches it by the calls it sees even
 *    though the queues it took were correct.
 *  - Removing the second `deps.mine()` check, before the write-back — 1
 *    failure, "a sign-out part-way through leaves the queue alone".
 */

import { beforeEach, describe, expect, test } from "@jest/globals";
import { getOutbox, putOutbox } from "../features/offline/cache";
import { drainOtherContexts, workspacesWithQueues } from "../features/offline/drainAll";
import { keyFor } from "../features/offline/keys";
import { memoryStore, type KeyValueStore } from "../features/offline/memory";
import { emptyOutbox, enqueue, type Outbox } from "../features/offline/outbox";
import type { WriteOutcome } from "../features/offline/sync";

const OPEN = "ws_open";
const OTHER = "ws_other";
const THIRD = "ws_third";

/** One context's queue with a single unsent write in it. */
function queued(workspaceId: string, path: string, baseEtag: string | null = "e1"): Outbox {
  return enqueue(emptyOutbox(workspaceId), { path, text: "typed offline", baseEtag, now: 1_000 });
}

/** A `write` that records every call and answers however the test says. */
function recorder(answer: (workspaceId: string) => WriteOutcome = () => written()) {
  const calls: { workspaceId: string; path: string; expectedEtag: string | null }[] = [];
  return {
    calls,
    write: async (workspaceId: string, pending: { path: string; baseEtag: string | null }) => {
      calls.push({ workspaceId, path: pending.path, expectedEtag: pending.baseEtag });
      return answer(workspaceId);
    },
  };
}

const written = (etag = "e2"): WriteOutcome => ({
  kind: "written",
  etag,
  conflictCheck: "conditional",
});

const deps = (write: ReturnType<typeof recorder>["write"], mine = () => true) => ({
  write,
  now: () => 2_000,
  mine,
});

let store: KeyValueStore;
beforeEach(() => {
  store = memoryStore();
});

describe("which queues a pass takes", () => {
  test("it finds every workspace with a queue, from the keys alone", async () => {
    await putOutbox(store, queued(OPEN, "a.md"));
    await putOutbox(store, queued(OTHER, "b.md"));
    await store.set(keyFor("draft", THIRD, "c.md"), JSON.stringify({ path: "c.md", text: "x" }));

    expect((await workspacesWithQueues(store)).sort()).toEqual([OPEN, OTHER]);
  });

  /**
   * The console holds a **live** queue for the context it is showing, and the
   * record on disk trails it by up to `PERSIST_DEBOUNCE_MS`. Two drains against
   * one queue — one from the live copy, one from a stale record — would re-send
   * entries the other had settled and write back a queue missing whatever was
   * typed in between. So the open one is the foreground drain's, always.
   */
  test("the open context's queue is left to the console that owns it", async () => {
    await putOutbox(store, queued(OPEN, "mine.md"));
    await putOutbox(store, queued(OTHER, "theirs.md"));
    const r = recorder();

    await drainOtherContexts(store, OPEN, deps(r.write));

    expect(r.calls.map((c) => c.workspaceId)).toEqual([OTHER]);
    expect((await getOutbox(store, OPEN)).writes).toHaveLength(1);
  });

  test("with no context open, every queue is this pass's", async () => {
    await putOutbox(store, queued(OPEN, "a.md"));
    await putOutbox(store, queued(OTHER, "b.md"));
    const r = recorder();

    await drainOtherContexts(store, null, deps(r.write));

    expect(r.calls.map((c) => c.workspaceId).sort()).toEqual([OPEN, OTHER]);
  });

  test("a context whose queue is already empty is not visited", async () => {
    await putOutbox(store, queued(OTHER, "b.md"));
    await putOutbox(store, emptyOutbox(THIRD));
    const r = recorder();

    const reports = await drainOtherContexts(store, null, deps(r.write));

    expect(reports.map((report) => report.workspaceId)).toEqual([OTHER]);
  });
});

describe("what each write is", () => {
  /**
   * The cross-tenant property, and the reason `QueuedWriteSender` takes the
   * workspace as an argument rather than closing over one. `useFileBrowser`'s
   * sender is bound to the open context; a background pass that reused it would
   * write every context's queued edits into whichever context happened to be on
   * screen — somebody else's note, under somebody else's privacy rules, by a
   * code path nobody pressed.
   */
  test("every write names the context its queue is filed under", async () => {
    await putOutbox(store, queued(OTHER, "theirs.md"));
    await putOutbox(store, queued(THIRD, "third.md"));
    const r = recorder();

    await drainOtherContexts(store, OPEN, deps(r.write));

    // Sorted: which context is visited first is not a promise this module
    // makes — the order comes from the store's keys — and a test that pinned it
    // would go red for a reason that is not a defect.
    expect([...r.calls].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))).toEqual([
      { workspaceId: OTHER, path: "theirs.md", expectedEtag: "e1" },
      { workspaceId: THIRD, path: "third.md", expectedEtag: "e1" },
    ]);
  });

  /**
   * The property the whole feature rests on. A drain is not a second write
   * path: it is the Save button's write, made later, carrying the etag the
   * draft was typed against. A pass that dropped it "to get things through"
   * would be last-write-wins with extra steps.
   */
  test("the etag the draft was typed against survives the delay", async () => {
    await putOutbox(store, queued(OTHER, "a.md", "etag-from-the-train"));
    await putOutbox(store, queued(THIRD, "new.md", null));
    const r = recorder();

    await drainOtherContexts(store, OPEN, deps(r.write));

    expect([...r.calls].sort((a, b) => a.path.localeCompare(b.path)).map((c) => c.expectedEtag)).toEqual([
      "etag-from-the-train",
      null,
    ]);
  });

  test("a sent write leaves the queue, and the queue on disk says so", async () => {
    await putOutbox(store, queued(OTHER, "a.md"));

    await drainOtherContexts(store, OPEN, deps(recorder().write));

    expect((await getOutbox(store, OTHER)).writes).toHaveLength(0);
  });

  /**
   * Parked, never retried: an automatic retry of a conflict is last-write-wins
   * on a timer. The entry stays, carrying the conflict, for the person whose
   * text it is — and this pass has no resolution surface, so all it must do is
   * keep it and stop.
   */
  test("a conflict is parked in the queue rather than retried", async () => {
    await putOutbox(store, queued(OTHER, "a.md"));
    const r = recorder(() => ({ kind: "conflict", currentEtag: "e9", message: "moved on" }));

    const [report] = await drainOtherContexts(store, OPEN, deps(r.write));

    const after = await getOutbox(store, OTHER);
    expect(after.writes).toHaveLength(1);
    expect(after.writes[0]!.state).toBe("conflicted");
    expect(report!.conflicted).toBe(1);
    expect(r.calls).toHaveLength(1);
  });
});

describe("a session that ends part-way through", () => {
  /**
   * A pass over four contexts is far more time than a single drain, and
   * `forgetLocalCopies` bumps the epoch before it removes anything. Writing a
   * queue back after that would re-persist the very entries somebody was warned
   * about and pressed "discard" on, onto the machine the next person signs in
   * on.
   */
  test("a sign-out part-way through leaves the queue alone", async () => {
    await putOutbox(store, queued(OTHER, "a.md"));
    let signedOut = false;
    const r = recorder(() => {
      // The session ends while the write is in flight, which is the only way
      // this is ever reached in production.
      signedOut = true;
      return written();
    });

    await drainOtherContexts(store, OPEN, deps(r.write, () => !signedOut));

    // The entry was sent, and the queue on disk is untouched — which is the
    // honest outcome: it is not this pass's job to tidy a device whose session
    // is over, and `forgetEverything` is about to take the whole namespace.
    expect((await getOutbox(store, OTHER)).writes).toHaveLength(1);
  });

  test("a session that ended before the pass started sends nothing", async () => {
    await putOutbox(store, queued(OTHER, "a.md"));
    const r = recorder();

    await drainOtherContexts(store, OPEN, deps(r.write, () => false));

    expect(r.calls).toEqual([]);
  });
});

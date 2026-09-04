import { describe, expect, test } from "@jest/globals";

import {
  counts,
  discard,
  drainable,
  emptyOutbox,
  enqueue,
  find,
  forceMine,
  markConflict,
  markRejected,
  parseOutbox,
  retry,
  settle,
  type Outbox,
  type PendingWrite,
} from "../features/offline/outbox";
import {
  MAX_ATTEMPTS,
  classifyWriteFailure,
  drainOutbox,
  type DrainReport,
  type WriteOutcome,
} from "../features/offline/sync";
import { reconcile } from "../features/offline/useOfflineNotes";
import { memoryStore } from "../features/offline/memory";
import { getOutbox, putOutbox } from "../features/offline/cache";
import { connectionLine, queueLine, signOutWarning } from "../features/offline/copy";

/**
 * The queue, and what happens when it meets a bucket somebody else has written
 * to.
 *
 * These are the cases CLAUDE.md's engineering standards single out — "etag
 * conflicts, storage failures" — and the ones that otherwise only appear in
 * production, because reproducing them by hand means two clients, one bucket
 * and a stopwatch. Everything here is a pure function with the write injected,
 * so they are ordinary tests.
 *
 * The property every one of them is really about: **a person's typing is never
 * thrown away by anything except that person.** A conflict parks it, a refusal
 * parks it, a restart reloads it, and the only two functions that destroy a
 * draft — `discard` and `settle` — are reached from a control somebody pressed
 * and from a write that actually landed.
 */

function queued(path: string, text: string, baseEtag: string | null, now = 1_000): Outbox {
  return enqueue(emptyOutbox("ws1"), { path, text, baseEtag, now });
}

/** A write function that answers from a script, and records what it was asked. */
function scripted(outcomes: Record<string, WriteOutcome | WriteOutcome[]>) {
  const asked: PendingWrite[] = [];
  return {
    asked,
    write: async (write: PendingWrite): Promise<WriteOutcome> => {
      asked.push(write);
      const scriptedOutcome = outcomes[write.path];
      if (scriptedOutcome === undefined) {
        return { kind: "written", etag: "server", conflictCheck: "conditional" };
      }
      return Array.isArray(scriptedOutcome)
        ? (scriptedOutcome.shift() ?? { kind: "written", etag: "server", conflictCheck: "conditional" })
        : scriptedOutcome;
    },
  };
}

const now = () => 5_000;

/* -------------------------------------------------------------------------- */

describe("queueing an edit", () => {
  test("forty saves to one note are one write", () => {
    /*
      Not a tidiness point. Each entry is a round trip on the *customer's*
      request quota and a `.history/` object in *their* bucket, and thirty-nine
      of forty are superseded before anybody reads them.
    */
    let outbox = emptyOutbox("ws1");
    for (let index = 0; index < 40; index += 1) {
      outbox = enqueue(outbox, { path: "a.md", text: `draft ${index}`, baseEtag: "e1", now: index });
    }

    expect(outbox.writes).toHaveLength(1);
    expect(outbox.writes[0]!.text).toBe("draft 39");
  });

  test("superseding keeps when the wait started, not when a key was last pressed", () => {
    // The console shows this as "waiting since…", which has to answer "how long
    // has this been stuck", not "when did you stop typing".
    let outbox = queued("a.md", "one", "e1", 1_000);
    outbox = enqueue(outbox, { path: "a.md", text: "two", baseEtag: "e1", now: 9_000 });

    expect(outbox.writes[0]!.queuedAt).toBe(1_000);
    expect(outbox.writes[0]!.updatedAt).toBe(9_000);
  });

  test("superseding never advances the base etag", () => {
    /*
      The quiet catastrophe this prevents. If a background reload handed a
      fresher etag to the enqueue, the queued write would stop being "replace
      the version I read" and become "replace whatever is there now" — a silent
      overwrite of somebody else's save, made by a code path nobody pressed.
    */
    let outbox = queued("a.md", "one", "e1");
    outbox = enqueue(outbox, { path: "a.md", text: "two", baseEtag: "e-newer", now: 2_000 });

    expect(outbox.writes[0]!.baseEtag).toBe("e1");
  });

  test("typing more into a conflicted note keeps the newer text and the conflict", () => {
    /*
      Both halves matter and they pull in opposite directions. Losing what
      somebody just typed because an older version of it was refused is the
      worst outcome available; clearing the conflict because they typed is the
      silent clobber. `editorReducer` already holds exactly this rule for the
      online case ("A conflict is not cleared by typing"), and the queue must
      not disagree with it.
    */
    let outbox = queued("a.md", "one", "e1");
    outbox = markConflict(outbox, "a.md", { currentEtag: "e2", message: "moved on", now: 2_000 });
    outbox = enqueue(outbox, { path: "a.md", text: "one and more", baseEtag: "e1", now: 3_000 });

    expect(outbox.writes[0]!.text).toBe("one and more");
    expect(outbox.writes[0]!.state).toBe("conflicted");
    expect(drainable(outbox)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe("draining the queue", () => {
  test("a queued write is sent with the etag it was typed against", async () => {
    /*
      This is the whole conflict story in one assertion. A drain is not a
      special write path — it is the ordinary conditional write the Save button
      makes, made later, so it inherits the server's `onlyIf: { etagMatches }`
      on a bucket that can do one and its read-compare on a bucket that cannot.
      A drain that dropped `expectedEtag` to "make it go through" would be
      last-write-wins with extra steps.
    */
    const bucket = scripted({});
    const { outbox, report } = await drainOutbox(queued("a.md", "text", "e1"), {
      write: bucket.write,
      now,
    });

    expect(bucket.asked[0]!.baseEtag).toBe("e1");
    expect(report.sent).toEqual([
      { path: "a.md", etag: "server", conflictCheck: "conditional", sentUpdatedAt: 1_000 },
    ]);
    expect(outbox.writes).toEqual([]);
  });

  test("a conflict parks the note and never writes", async () => {
    const bucket = scripted({
      "a.md": { kind: "conflict", currentEtag: "e2", message: "changed somewhere else" },
    });
    const { outbox, report } = await drainOutbox(queued("a.md", "mine", "e1"), {
      write: bucket.write,
      now,
    });

    expect(report.conflicted).toEqual(["a.md"]);
    expect(report.sent).toEqual([]);
    const parked = find(outbox, "a.md")!;
    expect(parked.state).toBe("conflicted");
    // The typing is still here. That is the point.
    expect(parked.text).toBe("mine");
    expect(parked.conflict).toEqual({
      currentEtag: "e2",
      message: "changed somewhere else",
      noticedAt: 5_000,
    });
  });

  test("a parked conflict is never picked up again on its own", async () => {
    /*
      Automatic retry of a conflict is last-write-wins on a timer. The only way
      out is a person, and there are exactly two of them: `discard` (theirs
      wins) and `forceMine` (mine wins, against the version they were shown).
    */
    let outbox = queued("a.md", "mine", "e1");
    outbox = markConflict(outbox, "a.md", { currentEtag: "e2", message: "moved", now: 1 });

    const bucket = scripted({});
    const drained = await drainOutbox(outbox, { write: bucket.write, now });

    expect(bucket.asked).toEqual([]);
    expect(drained.report).toEqual({ sent: [], conflicted: [], rejected: [], stoppedEarly: false });
  });

  test("one note's conflict does not hold up the rest of the queue", async () => {
    const bucket = scripted({
      "a.md": { kind: "conflict", currentEtag: "e2", message: "moved" },
    });
    let outbox = queued("a.md", "one", "e1", 1_000);
    outbox = enqueue(outbox, { path: "b.md", text: "two", baseEtag: "e9", now: 2_000 });

    const drained = await drainOutbox(outbox, { write: bucket.write, now });

    expect(drained.report.conflicted).toEqual(["a.md"]);
    expect(drained.report.sent.map((s) => s.path)).toEqual(["b.md"]);
  });

  test("a transient failure stops the drain rather than marching through it", async () => {
    /*
      The overwhelmingly likely cause of one write failing is that the
      connection went away again mid-drain. Continuing turns one failure into a
      queue of entries each carrying a failure count for a problem none of them
      had — and spends a bucket round trip proving it each time.
    */
    const bucket = scripted({ "a.md": { kind: "failed", message: "bucket did not answer" } });
    let outbox = queued("a.md", "one", "e1", 1_000);
    outbox = enqueue(outbox, { path: "b.md", text: "two", baseEtag: "e9", now: 2_000 });

    const drained = await drainOutbox(outbox, { write: bucket.write, now });

    expect(bucket.asked.map((w) => w.path)).toEqual(["a.md"]);
    expect(drained.report.stoppedEarly).toBe(true);
    expect(find(drained.outbox, "a.md")!.state).toBe("pending");
    expect(find(drained.outbox, "a.md")!.attempts).toBe(1);
    expect(find(drained.outbox, "b.md")!.attempts).toBe(0);
  });

  test("a transient failure is charged once, not twice", async () => {
    // `markFailed` and `markRejected` both count the attempt; running them in
    // sequence would spend two of six on one failure.
    const bucket = scripted({ "a.md": { kind: "failed", message: "no" } });
    const drained = await drainOutbox(queued("a.md", "one", "e1"), { write: bucket.write, now });
    expect(find(drained.outbox, "a.md")!.attempts).toBe(1);
  });

  test("a write that keeps failing is parked rather than retried forever", async () => {
    /*
      Six separate occasions on which the app believed it was online and the
      bucket disagreed. Past that, "it will go through next time" has stopped
      being true, and a silent retry loop is spending somebody's paid-for
      request quota to keep saying it.
    */
    let outbox = queued("a.md", "one", "e1");
    const bucket = scripted({ "a.md": { kind: "failed", message: "no" } });

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      outbox = (await drainOutbox(outbox, { write: bucket.write, now })).outbox;
    }

    const parked = find(outbox, "a.md")!;
    expect(parked.state).toBe("rejected");
    expect(parked.rejection?.code).toBe("RETRIES_EXHAUSTED");
    // Still not lost.
    expect(parked.text).toBe("one");
  });

  test("a refusal retrying cannot fix is parked immediately", async () => {
    const bucket = scripted({
      "a.md": { kind: "rejected", code: "CONTENT_TOO_LARGE", message: "too big" },
    });
    const drained = await drainOutbox(queued("a.md", "x".repeat(10), "e1"), {
      write: bucket.write,
      now,
    });

    expect(drained.report.rejected).toEqual(["a.md"]);
    expect(find(drained.outbox, "a.md")!.state).toBe("rejected");
  });

  test("what landed is handed back so the editor moves onto the new etag", async () => {
    /*
      Without this, a drain leaves the open editor holding the etag it typed
      against — which the write has just superseded — and the person's very next
      save conflicts with their own queued one.
    */
    const seen: { path: string; etag: string }[] = [];
    const bucket = scripted({});
    await drainOutbox(queued("a.md", "one", "e1"), {
      write: bucket.write,
      now,
      onWritten: (result) => seen.push({ path: result.path, etag: result.etag }),
    });
    expect(seen).toEqual([{ path: "a.md", etag: "server" }]);
  });

  test("the oldest edit is sent first", async () => {
    const bucket = scripted({});
    let outbox = enqueue(emptyOutbox("ws1"), { path: "b.md", text: "", baseEtag: null, now: 9 });
    outbox = enqueue(outbox, { path: "a.md", text: "", baseEtag: null, now: 1 });

    await drainOutbox(outbox, { write: bucket.write, now });

    expect(bucket.asked.map((w) => w.path)).toEqual(["a.md", "b.md"]);
  });
});

/* -------------------------------------------------------------------------- */

describe("resolving a conflict", () => {
  function conflicted(): Outbox {
    return markConflict(queued("a.md", "mine", "e1"), "a.md", {
      currentEtag: "e2",
      message: "changed somewhere else",
      now: 2_000,
    });
  }

  test("keeping mine re-bases onto the version that was shown, and stays conditional", async () => {
    /*
      Not an unconditional put. "Overwrite theirs" means "replace *that*
      version", so the retry still carries an `expectedEtag` — the one the
      conflict reported and the one the person was shown. If a third client
      writes between the conflict and the retry, that is a new conflict and gets
      asked about again, rather than being flattened.

      It IS destructive, and the UI says so. `writeFile` keeps no copy of the
      version being replaced — object versioning at the customer's provider is
      what keeps versions now, and we cannot see whether they enabled it — so
      the choice reads "unless you turned on versioning, the version it
      replaces is gone" rather than promising a snapshot nothing writes.
    */
    const outbox = forceMine(conflicted(), "a.md");
    expect(outbox.writes[0]!.state).toBe("pending");
    expect(outbox.writes[0]!.baseEtag).toBe("e2");

    const bucket = scripted({});
    await drainOutbox(outbox, { write: bucket.write, now });
    expect(bucket.asked[0]!.baseEtag).toBe("e2");
  });

  test("taking theirs is the only path that destroys a draft", () => {
    expect(discard(conflicted(), "a.md").writes).toEqual([]);
  });

  test("a rejected entry cannot be forced — there is no version to force past", () => {
    const rejected = markRejected(queued("a.md", "mine", "e1"), "a.md", {
      code: "CONTENT_TOO_LARGE",
      message: "too big",
      now: 1,
    });
    expect(forceMine(rejected, "a.md")).toEqual(rejected);
    expect(retry(rejected, "a.md").writes[0]!.state).toBe("pending");
  });

  test("settling removes it; a note that never queued is untouched by any of them", () => {
    expect(settle(conflicted(), "a.md").writes).toEqual([]);
    const empty = emptyOutbox("ws1");
    expect(forceMine(empty, "a.md")).toBe(empty);
    expect(discard(empty, "a.md").writes).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe("a queue that outlives the app", () => {
  test("writes waiting when the app died are still waiting when it comes back", async () => {
    /*
      The case that only ever appears in production: three edits queued on a
      train, the tab closed, the laptop opened the next morning. The record is
      read back through the same parser that wrote it, and the drain then
      behaves exactly as it would have the night before — including sending each
      write against the etag it was originally typed against, hours later.
    */
    const store = memoryStore();
    let outbox = queued("a.md", "typed on the train", "e1", 1_000);
    outbox = enqueue(outbox, { path: "b.md", text: "and this", baseEtag: null, now: 1_100 });
    await putOutbox(store, outbox);

    const reloaded = await getOutbox(store, "ws1");
    expect(reloaded.writes).toHaveLength(2);
    expect(reloaded.writes[0]!.text).toBe("typed on the train");

    const bucket = scripted({});
    const drained = await drainOutbox(reloaded, { write: bucket.write, now });
    expect(bucket.asked.map((w) => w.baseEtag)).toEqual(["e1", null]);
    expect(drained.outbox.writes).toEqual([]);
  });

  test("a conflict survives a restart as a conflict", async () => {
    const store = memoryStore();
    await putOutbox(
      store,
      markConflict(queued("a.md", "mine", "e1"), "a.md", {
        currentEtag: "e2",
        message: "changed somewhere else",
        now: 1,
      }),
    );

    const reloaded = await getOutbox(store, "ws1");
    expect(reloaded.writes[0]!.state).toBe("conflicted");
    expect(drainable(reloaded)).toEqual([]);
  });

  test("a record from another version, or another context, is not half-read", () => {
    /*
      A record we cannot read is a record we cannot send, and crashing the
      console on launch over it helps nobody. `version` is what makes that a
      decision rather than an accident — and the workspace check is the tenancy
      rule again: a queue found under the wrong context is not that context's to
      drain into.
    */
    expect(parseOutbox('{"version":0,"workspaceId":"ws1","writes":[{}]}', "ws1").writes).toEqual([]);
    expect(parseOutbox('{"version":1,"workspaceId":"other","writes":[]}', "ws1").writes).toEqual([]);
    expect(parseOutbox("not json", "ws1").writes).toEqual([]);
    expect(parseOutbox(null, "ws1")).toEqual(emptyOutbox("ws1"));
  });

  test("a half-written entry is dropped and the rest of the queue survives", () => {
    const raw = JSON.stringify({
      version: 1,
      workspaceId: "ws1",
      writes: [
        { path: "good.md", text: "t", baseEtag: null, queuedAt: 1, updatedAt: 1, attempts: 0, state: "pending" },
        { path: "bad.md" },
      ],
    });
    expect(parseOutbox(raw, "ws1").writes.map((w) => w.path)).toEqual(["good.md"]);
  });
});

/* -------------------------------------------------------------------------- */

describe("typing through a drain", () => {
  /*
    A drain is asynchronous and nobody stops writing for it. These are the cases
    where the queue that finished is not the queue that started, and each of
    them loses somebody's work if it is collapsed into another.
  */

  const report = (sent: DrainReport["sent"]): DrainReport => ({
    sent,
    conflicted: [],
    rejected: [],
    stoppedEarly: false,
  });

  test("an entry that went, untouched since, is dropped", () => {
    const live = queued("a.md", "one", "e1", 1_000);
    const after = reconcile(
      live,
      emptyOutbox("ws1"),
      report([{ path: "a.md", etag: "e2", conflictCheck: "conditional", sentUpdatedAt: 1_000 }]),
    );
    expect(after.writes).toEqual([]);
  });

  test("an edit made mid-drain survives, re-based onto what the drain just wrote", () => {
    /*
      Both halves. Dropping it loses typing. Keeping it on the old base etag
      conflicts the person against their own write of thirty seconds ago, which
      is the most confusing conflict it is possible to show somebody.
    */
    let live = queued("a.md", "one", "e1", 1_000);
    live = enqueue(live, { path: "a.md", text: "one and more", baseEtag: "e1", now: 4_000 });

    const after = reconcile(
      live,
      emptyOutbox("ws1"),
      report([{ path: "a.md", etag: "e2", conflictCheck: "conditional", sentUpdatedAt: 1_000 }]),
    );

    expect(after.writes[0]!.text).toBe("one and more");
    expect(after.writes[0]!.baseEtag).toBe("e2");
    expect(after.writes[0]!.state).toBe("pending");
  });

  test("a verdict the drain reached survives newer typing", () => {
    // The conflict is a fact about the bucket. Typing more does not change it —
    // the same rule `enqueue` holds, applied to the reconciliation.
    let live = queued("a.md", "one", "e1", 1_000);
    live = enqueue(live, { path: "a.md", text: "more", baseEtag: "e1", now: 4_000 });
    const drained = markConflict(queued("a.md", "one", "e1", 1_000), "a.md", {
      currentEtag: "e2",
      message: "moved",
      now: 3_000,
    });

    const after = reconcile(live, drained, report([]));

    expect(after.writes[0]!.state).toBe("conflicted");
    expect(after.writes[0]!.text).toBe("more");
    expect(after.writes[0]!.conflict?.currentEtag).toBe("e2");
  });

  test("a note first queued during the drain is left completely alone", () => {
    let live = queued("a.md", "one", "e1", 1_000);
    live = enqueue(live, { path: "new.md", text: "typed mid-drain", baseEtag: null, now: 4_000 });

    const after = reconcile(
      live,
      emptyOutbox("ws1"),
      report([{ path: "a.md", etag: "e2", conflictCheck: "conditional", sentUpdatedAt: 1_000 }]),
    );

    expect(after.writes.map((w) => w.path)).toEqual(["new.md"]);
    expect(after.writes[0]!.text).toBe("typed mid-drain");
  });
});

/* -------------------------------------------------------------------------- */

describe("classifying what a write threw", () => {
  test("a CONFLICT is a conflict, and carries the etag that is actually current", () => {
    expect(
      classifyWriteFailure({
        code: "CONFLICT",
        message: "That file changed somewhere else while you were editing it.",
        currentEtag: "e2",
      }),
    ).toEqual({
      kind: "conflict",
      currentEtag: "e2",
      message: "That file changed somewhere else while you were editing it.",
    });
  });

  test("a deleted note is still a conflict, with no etag to offer", () => {
    expect(
      classifyWriteFailure({
        code: "CONFLICT",
        message: "That file was deleted somewhere else while you were editing it.",
      }),
    ).toEqual({
      kind: "conflict",
      currentEtag: undefined,
      message: "That file was deleted somewhere else while you were editing it.",
    });
  });

  test("only an enumerated code is retried; anything unknown is parked", () => {
    /*
      The allowlist direction is the cheap one to be wrong in. "These codes are
      permanent, everything else retries" means a code this file has not heard
      of — a new one, a permission refusal, a revoked workspace — is retried on
      every reconnection forever against somebody's bucket, for a request that
      was never going to succeed. Parked and reported is undoable with one
      press; retried and silent is invisible.
    */
    expect(classifyWriteFailure({ code: "STORAGE_FAILED", message: "x" }).kind).toBe("failed");
    expect(classifyWriteFailure({ code: "UNKNOWN", message: "x" }).kind).toBe("failed");
    expect(classifyWriteFailure({ code: "CONTENT_TOO_LARGE", message: "x" }).kind).toBe("rejected");
    expect(classifyWriteFailure({ code: "A_CODE_ADDED_NEXT_YEAR", message: "x" }).kind).toBe(
      "rejected",
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("what the person is told", () => {
  const zero = { pending: 0, conflicted: 0, rejected: 0 };

  test("nothing is claimed while the platform has not said", () => {
    // A permanent "Offline" chip on a browser that will not answer is a chip
    // people learn to ignore — and then it is not there on the day it is true.
    expect(connectionLine({ reachability: "unknown", counts: zero, durable: true })).toBeNull();
    expect(connectionLine({ reachability: "online", counts: zero, durable: true })).toBeNull();
  });

  test("the offline sentence changes with what the store can actually promise", () => {
    const durable = connectionLine({ reachability: "offline", counts: zero, durable: true })!;
    const not = connectionLine({ reachability: "offline", counts: zero, durable: false })!;

    expect(durable.detail).toContain("sent when you are back");
    expect(not.detail).toContain("closing the app loses them");
    expect(durable.detail).not.toContain("closing the app loses them");
  });

  test("a bucket without conditional writes says so on the queue too", () => {
    /*
      The same "degrade honestly" rule the status bar's `read-compare` segment
      exists for, applied where the delay makes it matter most: an edit typed on
      a train and sent an hour later has had an hour in which somebody's
      Obsidian could sync.
    */
    const line = queueLine({
      reachability: "offline",
      counts: { ...zero, pending: 2 },
      durable: true,
      conditionalWrite: false,
    })!;
    expect(line.detail).toContain("cannot do conditional writes");

    const strong = queueLine({
      reachability: "offline",
      counts: { ...zero, pending: 2 },
      durable: true,
      conditionalWrite: true,
    })!;
    expect(strong.detail).not.toContain("cannot do conditional writes");
  });

  test("a note that needs a person outranks notes that do not", () => {
    const line = queueLine({
      reachability: "online",
      counts: { pending: 4, conflicted: 1, rejected: 0 },
      durable: true,
    })!;
    expect(line.tone).toBe("crit");
    expect(line.text).toBe("1 note needs you");
    expect(line.detail).toContain("Nothing has been overwritten");
  });

  test("an empty queue says nothing", () => {
    expect(queueLine({ reachability: "online", counts: zero, durable: true })).toBeNull();
    expect(signOutWarning(zero)).toBeNull();
  });

  test("signing out with writes waiting says what it costs", () => {
    // Sign-out wipes everything this feature holds, so this is the last moment
    // anybody can be told.
    expect(signOutWarning({ pending: 2, conflicted: 1, rejected: 0 })).toContain(
      "3 notes have edits",
    );
  });

  test("counts are counts, never note text", () => {
    // The same rule that keeps note content out of structured logs.
    const line = queueLine({
      reachability: "offline",
      counts: { ...zero, pending: 1 },
      durable: true,
    })!;
    expect(line.text).toBe("1 note waiting to sync");
    expect(counts(queued("secret.md", "the actual secret", null))).toEqual({
      pending: 1,
      conflicted: 0,
      rejected: 0,
    });
  });
});

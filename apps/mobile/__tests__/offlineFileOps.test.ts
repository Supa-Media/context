import { describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";

import {
  claimedPaths,
  counts,
  discard,
  emptyOutbox,
  enqueue,
  find,
  opsOf,
  overrideOp,
  parseOutbox,
  queueFolder,
  queueMove,
  queueRemoval,
  retryOp,
  routesThroughQueue,
  serverPathOf,
  localPathOf,
  type Outbox,
  type PendingOp,
  type PendingWrite,
} from "../features/offline/outbox";
import { MAX_ATTEMPTS, drainOutbox, type OpOutcome, type WriteOutcome } from "../features/offline/sync";
import { forgetEverything, getOutbox, putOutbox, waitingOnDevice } from "../features/offline/cache";
import { memoryStore } from "../features/offline/memory";
import { signOutWarning } from "../features/offline/copy";
import { queuedOpSender, type OpActions } from "../features/console/files/queuedWrite";
import { reconcile } from "../features/offline/useOfflineNotes";
import { overlayKey, overlayListings } from "../features/offline/overlay";
import { describeOp, pendingMarks } from "../features/console/files/pendingMarks";
import type { FolderListing } from "../features/console/files/types";

/**
 * Offline is more than saving: a note created, renamed, moved, archived or
 * deleted on a train, and what reaches the bucket when the train comes out of
 * the tunnel.
 *
 * Two things are pinned here. **What is sent, in what order** — coalescing
 * (a create renamed before it went is a create at the new name; a create
 * deleted before it went is nothing) and ordering (a note's edit before its
 * rename, a rename before the rename of it). And **what is never done** — an
 * op sent without the version it was asked about, a parked op retried by
 * itself, an op sent past its note's parked edit.
 */

const WS = "ws1";
let ids = 0;
const id = () => `op${++ids}`;

function edit(outbox: Outbox, path: string, text: string, baseEtag: string | null, now = 1_000): Outbox {
  return enqueue(outbox, { path, text, baseEtag, now });
}

function move(outbox: Outbox, from: string, to: string, etag: string | null = "e1", coalesce = true): Outbox {
  const next = queueMove(outbox, { id: id(), path: from, to, etag, now: 2_000, coalesce });
  if (next === null) throw new Error(`move ${from} → ${to} was refused`);
  return next;
}

function remove(
  outbox: Outbox,
  kind: "trash" | "archive",
  path: string,
  etag: string | null = "e1",
  coalesce = true,
) {
  const next = queueRemoval(outbox, { id: id(), kind, path, etag, now: 3_000, coalesce });
  if (next === null) throw new Error(`${kind} ${path} was refused`);
  return next;
}

/** A bucket, as far as a drain can see one: every call, in order. */
function bucket(script: {
  write?: (write: PendingWrite) => WriteOutcome;
  op?: (op: PendingOp) => OpOutcome;
} = {}) {
  const calls: string[] = [];
  let version = 0;
  return {
    calls,
    deps: {
      now: () => 9_000,
      write: async (write: PendingWrite): Promise<WriteOutcome> => {
        calls.push(`write ${write.path} @${write.baseEtag ?? "create"}`);
        return script.write?.(write) ?? { kind: "written", etag: `w${++version}`, conflictCheck: "conditional" };
      },
      op: async (op: PendingOp): Promise<OpOutcome> => {
        calls.push(`${op.kind} ${op.path}${op.to === undefined ? "" : ` → ${op.to}`} @${op.baseEtag ?? "none"}`);
        return script.op?.(op) ?? { kind: "done", etag: `o${++version}` };
      },
    },
  };
}

/* -------------------------------------------------------------------------- */

describe("a note created offline", () => {
  test("renamed before it was sent is one create, at the new name", async () => {
    let outbox = edit(emptyOutbox(WS), "0-inbox/grocieries.md", "# Groceries\n", null);
    outbox = move(outbox, "0-inbox/grocieries.md", "0-inbox/groceries.md", null);
    expect(opsOf(outbox)).toEqual([]);

    const b = bucket();
    const { outbox: after } = await drainOutbox(outbox, b.deps);
    expect(b.calls).toEqual(["write 0-inbox/groceries.md @create"]);
    expect(counts(after).pending).toBe(0);
  });

  test("deleted before it was sent sends nothing, and hands the text back for an undo", async () => {
    let outbox = edit(emptyOutbox(WS), "0-inbox/scratch.md", "# Scratch\n\nkeep?\n", null);
    const removed = remove(outbox, "trash", "0-inbox/scratch.md", null);
    outbox = removed.outbox;
    expect(removed.dropped?.text).toBe("# Scratch\n\nkeep?\n");

    const b = bucket();
    await drainOutbox(outbox, b.deps);
    expect(b.calls).toEqual([]);
  });

  test("archived before it was sent is created first, then archived at the version the create made", async () => {
    let outbox = edit(emptyOutbox(WS), "1-projects/done.md", "# Done\n", null);
    outbox = remove(outbox, "archive", "1-projects/done.md", null).outbox;

    const b = bucket();
    const { outbox: after } = await drainOutbox(outbox, b.deps);
    expect(b.calls).toEqual(["write 1-projects/done.md @create", "archive 1-projects/done.md @w1"]);
    expect(counts(after)).toEqual({ pending: 0, conflicted: 0, rejected: 0 });
  });

  test("a create that met a note already at its name is parked like any conflict, and what was asked of it waits", async () => {
    let outbox = edit(emptyOutbox(WS), "1-projects/plan.md", "# Mine\n", null);
    outbox = remove(outbox, "archive", "1-projects/plan.md", null).outbox;
    const b = bucket({
      write: () => ({ kind: "conflict", currentEtag: "theirs", message: "A file already exists at that path." }),
    });
    const { outbox: after, report } = await drainOutbox(outbox, b.deps);
    expect(report.conflicted).toEqual(["1-projects/plan.md"]);
    expect(find(after, "1-projects/plan.md")?.state).toBe("conflicted");
    // Held, not charged: nothing about the archive reached the bucket.
    expect(b.calls).toEqual(["write 1-projects/plan.md @create"]);
    expect(opsOf(after)[0]).toMatchObject({ state: "pending", attempts: 0, baseEtag: null });
  });

  test("a parked create renamed by its person is a new create at the new name — the rename is the answer", async () => {
    let outbox = edit(emptyOutbox(WS), "1-projects/plan.md", "# Mine\n", null);
    const b = bucket({
      write: () => ({ kind: "conflict", currentEtag: "theirs", message: "A file already exists at that path." }),
    });
    outbox = (await drainOutbox(outbox, b.deps)).outbox;
    outbox = move(outbox, "1-projects/plan.md", "1-projects/plan-mine.md", null);
    expect(find(outbox, "1-projects/plan-mine.md")).toMatchObject({ state: "pending", baseEtag: null });
    expect(find(outbox, "1-projects/plan.md")).toBeUndefined();
  });

  test("letting a create go takes whatever was queued behind it with it", () => {
    let outbox = edit(emptyOutbox(WS), "1-projects/done.md", "# Done\n", null);
    outbox = remove(outbox, "archive", "1-projects/done.md", null).outbox;
    outbox = discard(outbox, "1-projects/done.md");
    expect(counts(outbox)).toEqual({ pending: 0, conflicted: 0, rejected: 0 });
  });
});

describe("a note that is in the bucket", () => {
  test("renamed twice before it was sent is one move; renamed back, nothing", async () => {
    let outbox = move(emptyOutbox(WS), "plan.md", "plan-2.md", "e1");
    outbox = move(outbox, "plan-2.md", "plan-2026.md");
    expect(opsOf(outbox)).toMatchObject([{ kind: "move", path: "plan.md", to: "plan-2026.md", baseEtag: "e1" }]);
    expect(opsOf(move(outbox, "plan-2026.md", "plan.md"))).toEqual([]);
  });

  test("edited and then renamed: the edit goes first, and the rename follows the version it made", async () => {
    let outbox = edit(emptyOutbox(WS), "plan.md", "# Plan\n\nnewer\n", "e1");
    outbox = move(outbox, "plan.md", "plan-2026.md", "e1");
    const b = bucket();
    await drainOutbox(outbox, b.deps);
    expect(b.calls).toEqual(["write plan.md @e1", "move plan.md → plan-2026.md @w1"]);
  });

  test("renamed and then edited under its new name: the edit is of the bucket's note, and still goes first", async () => {
    let outbox = move(emptyOutbox(WS), "plan.md", "plan-2026.md", "e1");
    // What `useOfflineNotes.queueSave` does with the editor's path.
    expect(serverPathOf(outbox, "plan-2026.md")).toBe("plan.md");
    outbox = edit(outbox, serverPathOf(outbox, "plan-2026.md"), "# Plan\n\nnewer\n", "e1", 4_000);
    expect(localPathOf(outbox, "plan.md")).toBe("plan-2026.md");

    const b = bucket();
    await drainOutbox(outbox, b.deps);
    expect(b.calls).toEqual(["write plan.md @e1", "move plan.md → plan-2026.md @w1"]);
  });

  test("renamed and then deleted is deleted, as it was", async () => {
    let outbox = move(emptyOutbox(WS), "plan.md", "plan-2026.md", "e1");
    outbox = remove(outbox, "trash", "plan-2026.md").outbox;
    const b = bucket();
    await drainOutbox(outbox, b.deps);
    expect(b.calls).toEqual(["trash plan.md @e1"]);
  });

  test("edited and deleted: what goes to the trash is what the person last wrote", async () => {
    let outbox = edit(emptyOutbox(WS), "old-notes.md", "# Old\n\nlast words\n", "e1");
    outbox = remove(outbox, "trash", "old-notes.md", "e1").outbox;
    const b = bucket();
    await drainOutbox(outbox, b.deps);
    expect(b.calls).toEqual(["write old-notes.md @e1", "trash old-notes.md @w1"]);
  });

  test("a note this device holds no version of cannot be renamed offline", () => {
    expect(queueMove(emptyOutbox(WS), { id: id(), path: "x.md", to: "y.md", etag: null, now: 1, coalesce: true })).toBeNull();
    expect(queueRemoval(emptyOutbox(WS), { id: id(), kind: "trash", path: "x.md", etag: null, now: 1, coalesce: true })).toBeNull();
  });
});

describe("while a drain is in flight nothing already queued is rewritten", () => {
  test("a create renamed mid-drain is queued behind the create, and follows the version it makes", async () => {
    let outbox = edit(emptyOutbox(WS), "a.md", "# A\n", null);
    outbox = move(outbox, "a.md", "b.md", null, false);
    expect(find(outbox, "a.md")).toBeDefined();
    const b = bucket();
    const { outbox: after } = await drainOutbox(outbox, b.deps);
    expect(b.calls).toEqual(["write a.md @create", "move a.md → b.md @w1"]);
    expect(counts(after).pending).toBe(0);
  });

  test("a rename of a rename in flight waits for the first, then goes at the version it produced", async () => {
    let outbox = move(emptyOutbox(WS), "a.md", "b.md", "e1");
    outbox = move(outbox, "b.md", "c.md", null, false);
    expect(serverPathOf(outbox, "c.md")).toBe("a.md");
    const b = bucket();
    await drainOutbox(outbox, b.deps);
    expect(b.calls).toEqual(["move a.md → b.md @e1", "move b.md → c.md @o1"]);
  });

  test("the second waits, uncharged, while the first is parked", async () => {
    let outbox = move(emptyOutbox(WS), "a.md", "b.md", "e1");
    outbox = move(outbox, "b.md", "c.md", null, false);
    const b = bucket({ op: () => ({ kind: "conflict", currentEtag: "e9", message: "changed" }) });
    const { outbox: after } = await drainOutbox(outbox, b.deps);
    expect(b.calls).toEqual(["move a.md → b.md @e1"]);
    expect(opsOf(after).find((op) => op.path === "b.md")).toMatchObject({ state: "pending", attempts: 0 });
  });
});

describe("what a queued op will never do", () => {
  test("it is never sent without the version it was asked about", async () => {
    const asked: Parameters<OpActions["moveEntry"]>[0][] = [];
    const removals: { expectedEtag?: string }[] = [];
    const actions: OpActions = {
      moveEntry: async (args) => {
        asked.push(args);
        return { to: args.to, etag: "e2" };
      },
      archiveEntry: async (args) => {
        removals.push(args);
        return { to: "4-archive/x" };
      },
      trashEntry: async (args) => {
        removals.push(args);
        return { to: ".context/trash/x" };
      },
      createDirectory: async () => ({}),
    };
    const send = queuedOpSender(actions);
    const base = { queuedAt: 1, updatedAt: 1, state: "pending" as const, attempts: 0 };

    await send(WS, { ...base, id: "1", kind: "move", path: "a.md", to: "b.md", baseEtag: "e1" });
    await send(WS, { ...base, id: "2", kind: "trash", path: "a.md", baseEtag: "e1" });
    await send(WS, { ...base, id: "3", kind: "archive", path: "a.md", baseEtag: "e1" });
    expect(asked.map((one) => one.expectedEtag)).toEqual(["e1"]);
    expect(removals.map((one) => one.expectedEtag)).toEqual(["e1", "e1"]);

    // And one with none is refused here rather than sent as an unchecked press.
    const refused = await send(WS, { ...base, id: "4", kind: "trash", path: "a.md", baseEtag: null });
    expect(refused).toMatchObject({ kind: "rejected", code: "NO_VERSION" });
    expect(removals).toHaveLength(2);
  });

  test("it is sent to the context its queue is filed under, whatever else is open", async () => {
    const seen: string[] = [];
    const send = queuedOpSender({
      moveEntry: async (args) => {
        seen.push(args.workspaceId);
        return { to: args.to };
      },
      archiveEntry: async () => ({ to: "" }),
      trashEntry: async () => ({ to: "" }),
      createDirectory: async (args) => {
        seen.push(args.workspaceId);
        return {};
      },
    });
    const base = { queuedAt: 1, updatedAt: 1, state: "pending" as const, attempts: 0 };
    await send("ws_theirs", { ...base, id: "1", kind: "move", path: "a.md", to: "b.md", baseEtag: "e1" });
    await send("ws_mine", { ...base, id: "2", kind: "folder", path: "trips", baseEtag: null });
    expect(seen).toEqual(["ws_theirs", "ws_mine"]);
  });

  test("a folder that is already there is the folder asked for", async () => {
    const send = queuedOpSender({
      moveEntry: async () => ({ to: "" }),
      archiveEntry: async () => ({ to: "" }),
      trashEntry: async () => ({ to: "" }),
      createDirectory: async () => {
        throw new ConvexError({ code: "DESTINATION_EXISTS", message: "That folder already exists." });
      },
    });
    const base = { queuedAt: 1, updatedAt: 1, state: "pending" as const, attempts: 0 };
    expect(await send(WS, { ...base, id: "1", kind: "folder", path: "trips", baseEtag: null })).toEqual({
      kind: "done",
    });
  });

  test("a conflict parks it, and it is never picked up again on its own", async () => {
    const outbox = move(emptyOutbox(WS), "plan.md", "plan-2026.md", "e1");
    const b = bucket({ op: () => ({ kind: "conflict", currentEtag: "e7", message: "changed" }) });
    const first = await drainOutbox(outbox, b.deps);
    expect(first.report.ops.conflicted).toHaveLength(1);
    await drainOutbox(first.outbox, b.deps);
    await drainOutbox(first.outbox, b.deps);
    expect(b.calls).toHaveLength(1);
  });

  test("its note's parked edit holds it back, uncharged", async () => {
    let outbox = edit(emptyOutbox(WS), "plan.md", "# Mine\n", "e1");
    outbox = move(outbox, "plan.md", "plan-2026.md", "e1");
    const b = bucket({ write: () => ({ kind: "conflict", currentEtag: "e7", message: "changed" }) });
    const { outbox: after } = await drainOutbox(outbox, b.deps);
    expect(b.calls).toEqual(["write plan.md @e1"]);
    expect(opsOf(after)[0]).toMatchObject({ state: "pending", attempts: 0, baseEtag: "e1" });
  });

  test("a transient failure stops the drain, is charged once, and parks after the bound", async () => {
    let outbox = move(emptyOutbox(WS), "a.md", "b.md", "e1");
    outbox = move(outbox, "c.md", "d.md", "e3");
    const b = bucket({ op: () => ({ kind: "failed", message: "socket closed" }) });
    let drained = await drainOutbox(outbox, b.deps);
    expect(drained.report.stoppedEarly).toBe(true);
    expect(b.calls).toHaveLength(1);
    expect(opsOf(drained.outbox)[0]).toMatchObject({ state: "pending", attempts: 1 });
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      drained = await drainOutbox(drained.outbox, b.deps);
    }
    expect(opsOf(drained.outbox)[0]).toMatchObject({
      state: "rejected",
      rejection: { code: "RETRIES_EXHAUSTED" },
    });
  });

  test("a refusal nobody enumerated is parked, and comes back only when a person asks", async () => {
    const outbox = move(emptyOutbox(WS), "a.md", "b.md", "e1");
    const b = bucket({ op: () => ({ kind: "rejected", code: "DESTINATION_EXISTS", message: "Something already exists at b.md." }) });
    const { outbox: after } = await drainOutbox(outbox, b.deps);
    const parked = opsOf(after)[0];
    expect(parked.state).toBe("rejected");
    expect(opsOf(retryOp(after, parked.id))[0].state).toBe("pending");
  });

  test("\"do it anyway\" is still conditional — on the version the conflict reported", () => {
    const outbox = move(emptyOutbox(WS), "a.md", "b.md", "e1");
    const op = opsOf(outbox)[0];
    const parked: Outbox = {
      ...outbox,
      ops: [{ ...op, state: "conflicted", conflict: { currentEtag: "e7", message: "changed", noticedAt: 1 } }],
    };
    expect(opsOf(overrideOp(parked, op.id))[0]).toMatchObject({ state: "pending", baseEtag: "e7" });
    // A note that is gone has no version to answer with.
    const gone: Outbox = {
      ...outbox,
      ops: [{ ...op, state: "conflicted", conflict: { message: "gone", noticedAt: 1 } }],
    };
    expect(opsOf(overrideOp(gone, op.id))[0].state).toBe("conflicted");
  });
});

describe("a name the queue is holding", () => {
  test("cannot be taken by a different note until the queue has drained", () => {
    let outbox = remove(emptyOutbox(WS), "trash", "plan.md", "e1").outbox;
    outbox = move(outbox, "a.md", "b.md", "e2");
    expect(claimedPaths(outbox)).toEqual(new Set(["plan.md", "a.md", "b.md"]));
    expect(queueMove(outbox, { id: id(), path: "c.md", to: "plan.md", etag: "e3", now: 1, coalesce: true })).toBeNull();
    expect(queueFolder(outbox, { id: id(), path: "b.md", now: 1 })).toBeNull();
  });

  test("anything done to a note created or renamed here goes through the queue, even online", () => {
    let outbox = edit(emptyOutbox(WS), "new.md", "# New\n", null);
    outbox = move(outbox, "a.md", "b.md", "e1");
    outbox = edit(outbox, "edited.md", "# Edited\n", "e5");
    expect(routesThroughQueue(outbox, "new.md")).toBe(true);
    expect(routesThroughQueue(outbox, "b.md")).toBe(true);
    // A plain queued edit is a note the bucket has where the console says.
    expect(routesThroughQueue(outbox, "edited.md")).toBe(false);
    expect(routesThroughQueue(outbox, "elsewhere.md")).toBe(false);
  });
});

describe("a new folder", () => {
  test("goes before the notes made in it, and each is its own create", async () => {
    let outbox = queueFolder(emptyOutbox(WS), { id: id(), path: "trips", now: 500 })!;
    outbox = edit(outbox, "trips/lisbon.md", "# Lisbon\n", null, 600);
    const b = bucket();
    await drainOutbox(outbox, b.deps);
    expect(b.calls).toEqual(["folder trips @none", "write trips/lisbon.md @create"]);
  });
});

describe("the queue on the device", () => {
  test("a queue holding only a rename is written down, and read back as it was", async () => {
    const store = memoryStore();
    const outbox = move(emptyOutbox(WS), "a.md", "b.md", "e1");
    await putOutbox(store, outbox);
    expect(opsOf(await getOutbox(store, WS))).toEqual(opsOf(outbox));
  });

  test("a record from before ops existed keeps every edit it held", () => {
    const record = JSON.stringify({
      version: 1,
      workspaceId: WS,
      writes: [{ path: "a.md", text: "x", baseEtag: "e1", queuedAt: 1, updatedAt: 1, state: "pending", attempts: 0 }],
    });
    const parsed = parseOutbox(record, WS);
    expect(parsed.writes).toHaveLength(1);
    expect(opsOf(parsed)).toEqual([]);
  });

  test("sign-out counts every queued op on the device, and then takes them with the rest", async () => {
    const store = memoryStore();
    let outbox = move(emptyOutbox(WS), "a.md", "b.md", "e1");
    outbox = queueFolder(outbox, { id: id(), path: "trips", now: 5 })!;
    await putOutbox(store, outbox);
    expect(await waitingOnDevice(store, null)).toEqual({ pending: 2, conflicted: 0, rejected: 0 });
    await forgetEverything(store);
    expect(opsOf(await getOutbox(store, WS))).toEqual([]);
    expect(await store.keys()).toEqual([]);
  });

  test("sign-out counts a waiting rename as something it throws away", () => {
    const outbox = move(emptyOutbox(WS), "a.md", "b.md", "e1");
    expect(counts(outbox)).toEqual({ pending: 1, conflicted: 0, rejected: 0 });
    expect(signOutWarning(counts(outbox))).toMatch(/Signing out discards/);
  });
});

describe("pressing things while a drain is on the wire", () => {
  const make = { id: () => "made", now: 7_000 };

  test("a rename asked for after the note's edit went follows the version that edit made", async () => {
    const snapshot = edit(emptyOutbox(WS), "plan.md", "# Plan\n", "e1");
    const b = bucket();
    const drained = await drainOutbox(snapshot, b.deps);
    // Mid-drain: the rename was queued behind the edit, against the same base.
    const live = move(snapshot, "plan.md", "plan-2026.md", "e1", false);
    const after = reconcile(live, drained.outbox, drained.report, make);
    expect(after.writes).toEqual([]);
    expect(opsOf(after)).toMatchObject([{ path: "plan.md", to: "plan-2026.md", baseEtag: "w1" }]);
  });

  test("a rename queued behind one in flight follows the version the first returned", async () => {
    const snapshot = move(emptyOutbox(WS), "a.md", "b.md", "e1");
    const b = bucket();
    const drained = await drainOutbox(snapshot, b.deps);
    const live = move(snapshot, "b.md", "c.md", null, false);
    const after = reconcile(live, drained.outbox, drained.report, make);
    expect(opsOf(after)).toMatchObject([{ path: "b.md", to: "c.md", baseEtag: "o1" }]);
  });

  test("an op the drain parked keeps the verdict; one it sent is gone", async () => {
    let snapshot = move(emptyOutbox(WS), "a.md", "b.md", "e1");
    snapshot = move(snapshot, "c.md", "d.md", "e3");
    const b = bucket({
      op: (op) => (op.path === "a.md" ? { kind: "done", etag: "x" } : { kind: "conflict", currentEtag: "e9", message: "changed" }),
    });
    const drained = await drainOutbox(snapshot, b.deps);
    const after = reconcile(snapshot, drained.outbox, drained.report, make);
    expect(opsOf(after)).toMatchObject([{ path: "c.md", state: "conflicted", attempts: 1 }]);
  });
});

describe("the tree as this device has it", () => {
  const folder = (path: string, entries: FolderListing["entries"], folderDefault: "private" | "team" = "team"): FolderListing => ({
    path,
    folderDefault,
    entries,
    truncated: false,
    manifestUsable: true,
  });
  const file = (path: string, visibility: "private" | "team" = "team") => ({
    kind: "file" as const,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility,
    inherited: "team" as const,
    exception: visibility !== "team",
    readOnly: false,
  });
  const listings = () => ({
    "1-projects": folder("1-projects", [file("1-projects/pay.md", "private"), file("1-projects/plan.md")]),
    "0-inbox": folder("0-inbox", [], "private"),
  });

  test("nothing queued is the bucket's listings, untouched", () => {
    const bucket = listings();
    expect(overlayListings(bucket, emptyOutbox(WS))).toBe(bucket);
  });

  test("a renamed note keeps its own entry — its exception too — under the new name", () => {
    const outbox = move(emptyOutbox(WS), "1-projects/pay.md", "1-projects/wages.md", "e1");
    const shown = overlayListings(listings(), outbox);
    expect(shown["1-projects"]!.entries.map((one) => one.path)).toEqual(["1-projects/plan.md", "1-projects/wages.md"]);
    expect(shown["1-projects"]!.entries[1]).toMatchObject({ visibility: "private", exception: true });
  });

  test("a note moved to another folder leaves one and appears in the other", () => {
    const outbox = move(emptyOutbox(WS), "1-projects/plan.md", "0-inbox/plan.md", "e1");
    const shown = overlayListings(listings(), outbox);
    expect(shown["1-projects"]!.entries.map((one) => one.path)).toEqual(["1-projects/pay.md"]);
    expect(shown["0-inbox"]!.entries.map((one) => one.path)).toEqual(["0-inbox/plan.md"]);
  });

  test("a parked rename is still drawn where the person put it", () => {
    const outbox = move(emptyOutbox(WS), "1-projects/plan.md", "1-projects/plan-2026.md", "e1");
    const parked: Outbox = {
      ...outbox,
      ops: opsOf(outbox).map((op) => ({ ...op, state: "conflicted" as const })),
    };
    const shown = overlayListings(listings(), parked);
    expect(shown["1-projects"]!.entries.map((one) => one.path)).toContain("1-projects/plan-2026.md");
  });

  test("a new note is drawn with its folder's default, and a new folder with an empty listing", () => {
    let outbox = edit(emptyOutbox(WS), "0-inbox/idea.md", "# Idea\n", null);
    outbox = queueFolder(outbox, { id: id(), path: "0-inbox/trips", now: 9 })!;
    const shown = overlayListings(listings(), outbox);
    expect(shown["0-inbox"]!.entries.map((one) => [one.kind, one.path, one.visibility])).toEqual([
      ["folder", "0-inbox/trips", "private"],
      ["file", "0-inbox/idea.md", "private"],
    ]);
    expect(shown["0-inbox/trips"]!.entries).toEqual([]);
  });

  test("typing into a new note does not change what the tree depends on", () => {
    const one = edit(emptyOutbox(WS), "0-inbox/idea.md", "# Idea\n", null);
    const more = edit(one, "0-inbox/idea.md", "# Idea\n\nand more\n", null, 2_000);
    expect(overlayKey(more)).toBe(overlayKey(one));
  });
});

describe("what the sync sheet says", () => {
  test("each op in plain language", () => {
    expect(describeOp({ kind: "move", path: "1-projects/plan.md", to: "1-projects/plan-2026.md" })).toBe(
      "Rename plan → plan-2026",
    );
    expect(describeOp({ kind: "move", path: "1-projects/plan.md", to: "2-areas/plan.md" })).toBe("Move plan → areas");
    expect(describeOp({ kind: "trash", path: "0-inbox/old-notes.md" })).toBe("Delete old-notes");
    expect(describeOp({ kind: "archive", path: "0-inbox/old-notes.md" })).toBe("Archive old-notes");
    expect(describeOp({ kind: "folder", path: "2-areas/Trips" })).toBe("New folder: Trips");
  });

  test("a renamed note's edit is marked on the row the person sees, and a new note is called one", () => {
    let outbox = move(emptyOutbox(WS), "plan.md", "plan-2026.md", "e1");
    outbox = edit(outbox, "plan.md", "typed", "e1", 4_000);
    outbox = edit(outbox, "0-inbox/Groceries.md", "# Groceries", null, 5_000);
    const marks = pendingMarks(outbox.writes, {
      ops: opsOf(outbox),
      localPathOf: (path) => (path === "plan.md" ? "plan-2026.md" : path),
      creates: new Set(["0-inbox/Groceries.md"]),
    });
    expect(marks.stateFor("plan-2026.md")).toBe("queued");
    expect(marks.stateFor("plan.md")).toBeNull();
    expect(marks.labelFor?.("0-inbox/Groceries.md")).toBe("New note: Groceries");
    expect(marks.operations).toMatchObject([{ text: "Rename plan → plan-2026", mark: "queued", answers: [] }]);
  });
});

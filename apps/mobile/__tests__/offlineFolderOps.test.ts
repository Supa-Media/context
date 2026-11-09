/**
 * FOLDERS IN THE OFFLINE QUEUE.
 *
 * Owner, 2026-11-09, approving the offline-first boards: "every action works
 * offline: … folders, moving, renaming, deleting." A folder's op moves every
 * note in it, so it is the one op that is not independent of the others. The
 * rules (`outboxPaths.ts`): a folder op is sent after everything queued inside
 * the folder, everything queued inside a moved folder is kept under the
 * folder's old name, and folder ops do not nest.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   folder ops not sent last (drainUnits sorts by time only)            2
 *   a folder op does not wait for a parked edit inside it               1
 *   serverPathOf ignores folder moves                                   4
 *   folder ops allowed to nest                                          1
 *   the overlay draws folder ops as note ops                            3
 *   (and in `offlineFileOpsConsole.test.ts`, through the real console:
 *   serverPathOf ignoring folder moves fails 1, the overlay 1)
 */

import { describe, expect, test } from "@jest/globals";
import {
  emptyOutbox,
  enqueue,
  markConflict,
  opsOf,
  queueFolder,
  queueFolderMove,
  queueFolderRemoval,
  queueMove,
  type Outbox,
  type PendingOp,
  type PendingWrite,
} from "../features/offline/outbox";
import { beforeFolderMoves, localPathOf, routesThroughQueue, serverPathOf } from "../features/offline/outboxPaths";
import { drainOutbox, type OpOutcome, type WriteOutcome } from "../features/offline/sync";
import { overlayListings } from "../features/offline/overlay";
import type { FolderListing } from "../features/console/files/types";

const W = "ws_one";
let clock = 1_000;
const now = () => (clock += 1);
let ids = 0;
const id = () => `op${(ids += 1)}`;

function save(outbox: Outbox, path: string, text: string, baseEtag: string | null): Outbox {
  return enqueue(outbox, { path: serverPathOf(outbox, path), text, baseEtag, now: now() });
}

/** A bucket that records what was sent, in order. */
function bucket(answer: (op: PendingOp) => OpOutcome = () => ({ kind: "done" })) {
  const sent: string[] = [];
  return {
    sent,
    write: async (write: PendingWrite): Promise<WriteOutcome> => {
      sent.push(`write ${write.path}`);
      return { kind: "written", etag: `${write.path}@2`, conflictCheck: "conditional" };
    },
    op: async (op: PendingOp): Promise<OpOutcome> => {
      sent.push(`${op.kind} ${op.path}${op.to === undefined ? "" : ` → ${op.to}`}`);
      return answer(op);
    },
  };
}

describe("a folder renamed offline", () => {
  test("is drawn at its new name, and its notes are queued under the old one", () => {
    let outbox = queueFolderMove(emptyOutbox(W), { id: id(), path: "garden", to: "allotment", now: now() })!;
    expect(outbox).not.toBeNull();
    outbox = save(outbox, "allotment/basil.md", "water daily", "e1");
    expect(outbox.writes.map((write) => write.path)).toEqual(["garden/basil.md"]);
    expect(localPathOf(outbox, "garden/basil.md")).toBe("allotment/basil.md");
    expect(serverPathOf(outbox, "allotment/basil.md")).toBe("garden/basil.md");
  });

  test("is sent after the edits inside it, whenever they were typed", async () => {
    let outbox = save(emptyOutbox(W), "garden/mint.md", "before", "m1");
    outbox = queueFolderMove(outbox, { id: id(), path: "garden", to: "allotment", now: now() })!;
    outbox = save(outbox, "allotment/basil.md", "after", "b1");
    const sent = bucket();
    const drained = await drainOutbox(outbox, { write: sent.write, op: sent.op, now });
    expect(sent.sent).toEqual(["write garden/mint.md", "write garden/basil.md", "folderMove garden → allotment"]);
    expect(opsOf(drained.outbox)).toEqual([]);
  });

  test("a note renamed inside it is renamed under the old name first", async () => {
    let outbox = queueFolderMove(emptyOutbox(W), { id: id(), path: "garden", to: "allotment", now: now() })!;
    outbox = queueMove(outbox, {
      id: id(),
      path: serverPathOf(outbox, "allotment/basil.md"),
      to: serverPathOf(outbox, "allotment/sweet-basil.md"),
      etag: "b1",
      now: now(),
      coalesce: true,
    })!;
    expect(localPathOf(outbox, "garden/basil.md")).toBe("allotment/sweet-basil.md");
    const sent = bucket();
    await drainOutbox(outbox, { write: sent.write, op: sent.op, now });
    expect(sent.sent).toEqual(["move garden/basil.md → garden/sweet-basil.md", "folderMove garden → allotment"]);
  });

  test("waits, uncharged, while an edit inside it is parked", async () => {
    let outbox = save(emptyOutbox(W), "garden/mint.md", "mine", "m1");
    outbox = markConflict(outbox, "garden/mint.md", { message: "changed", now: now() });
    outbox = queueFolderMove(outbox, { id: id(), path: "garden", to: "allotment", now: now() })!;
    const sent = bucket();
    const drained = await drainOutbox(outbox, { write: sent.write, op: sent.op, now });
    expect(sent.sent).toEqual([]);
    expect(opsOf(drained.outbox)[0]!.attempts).toBe(0);
  });

  test("renamed twice is one rename, and renamed back is none", () => {
    let outbox = queueFolderMove(emptyOutbox(W), { id: id(), path: "garden", to: "allotment", now: now(), coalesce: true })!;
    outbox = queueFolderMove(outbox, { id: id(), path: "allotment", to: "plot", now: now(), coalesce: true })!;
    expect(opsOf(outbox).map((op) => [op.kind, op.path, op.to])).toEqual([["folderMove", "garden", "plot"]]);
    outbox = queueFolderMove(outbox, { id: id(), path: "plot", to: "garden", now: now(), coalesce: true })!;
    expect(opsOf(outbox)).toEqual([]);
  });

  test("deleting a renamed folder deletes the original", () => {
    let outbox = queueFolderMove(emptyOutbox(W), { id: id(), path: "garden", to: "allotment", now: now(), coalesce: true })!;
    outbox = queueFolderRemoval(outbox, { id: id(), path: "allotment", kind: "trash", now: now(), coalesce: true })!;
    expect(opsOf(outbox).map((op) => [op.kind, op.path, op.to])).toEqual([["folderTrash", "garden", undefined]]);
  });

  test("a folder made offline and then renamed is made, then renamed", async () => {
    let outbox = queueFolder(emptyOutbox(W), { id: id(), path: "seeds", now: now() })!;
    outbox = save(outbox, "seeds/list.md", "tomato", null);
    outbox = queueFolderMove(outbox, { id: id(), path: "seeds", to: "seed-box", now: now() })!;
    const sent = bucket();
    await drainOutbox(outbox, { write: sent.write, op: sent.op, now });
    expect(sent.sent).toEqual(["folder seeds", "write seeds/list.md", "folderMove seeds → seed-box"]);
  });

  test("a folder made inside a renamed one is made under the old name, then carried", async () => {
    let outbox = queueFolderMove(emptyOutbox(W), { id: id(), path: "garden", to: "allotment", now: now() })!;
    // As the app queues it (`offlineNotes/api.ts`): the shown path, back through the rename.
    outbox = queueFolder(outbox, { id: id(), path: beforeFolderMoves(outbox, "allotment/seeds"), now: now() })!;
    const sent = bucket();
    await drainOutbox(outbox, { write: sent.write, op: sent.op, now });
    expect(sent.sent).toEqual(["folder garden/seeds", "folderMove garden → allotment"]);
  });
});

describe("what is refused, and why", () => {
  test("folder ops do not nest: inside, around or onto one already queued", () => {
    const outbox = queueFolderMove(emptyOutbox(W), { id: id(), path: "garden", to: "allotment", now: now() })!;
    expect(queueFolderMove(outbox, { id: id(), path: "allotment/herbs", to: "allotment/greens", now: now() })).toBeNull();
    expect(queueFolderRemoval(outbox, { id: id(), path: "projects", kind: "trash", now: now() })).not.toBeNull();
    expect(queueFolderMove(outbox, { id: id(), path: "projects", to: "allotment/projects", now: now() })).toBeNull();
  });

  test("not into itself, and not onto a name the queue has claimed", () => {
    expect(queueFolderMove(emptyOutbox(W), { id: id(), path: "garden", to: "garden/inner", now: now() })).toBeNull();
    const claimed = save(emptyOutbox(W), "allotment/new.md", "x", null);
    expect(queueFolderMove(claimed, { id: id(), path: "garden", to: "allotment", now: now() })).toBeNull();
  });

  test("online, a folder with something queued inside it goes through the queue", () => {
    const outbox = save(emptyOutbox(W), "garden/mint.md", "mine", "m1");
    expect(routesThroughQueue(outbox, "garden", true)).toBe(true);
    expect(routesThroughQueue(outbox, "projects", true)).toBe(false);
  });

  test("a refused folder move leaves its notes where the bucket has them", async () => {
    let outbox = queueFolderMove(emptyOutbox(W), { id: id(), path: "garden", to: "allotment", now: now() })!;
    const sent = bucket(() => ({ kind: "rejected", code: "DESTINATION_EXISTS", message: "taken" }));
    outbox = (await drainOutbox(outbox, { write: sent.write, op: sent.op, now })).outbox;
    expect(opsOf(outbox)[0]!.state).toBe("rejected");
    // Drawn where the person put it until they answer; the bucket still has it under its old name.
    expect(serverPathOf(outbox, "allotment/basil.md")).toBe("garden/basil.md");
  });
});

describe("drawn on this device", () => {
  const entry = (path: string, kind: "file" | "folder" = "file") => ({
    kind,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private" as const,
    inherited: "private" as const,
    exception: false,
    readOnly: false,
  });
  const listing = (path: string, entries: ReturnType<typeof entry>[]): FolderListing => ({
    path,
    folderDefault: "private",
    entries,
    truncated: false,
    manifestUsable: true,
  });
  const bucketListings = () => ({
    "": listing("", [entry("garden", "folder"), entry("projects", "folder")]),
    garden: listing("garden", [entry("garden/basil.md"), entry("garden/herbs", "folder")]),
    "garden/herbs": listing("garden/herbs", [entry("garden/herbs/mint.md")]),
    projects: listing("projects", []),
  });

  test("a renamed folder is drawn at its new name, with everything under it", () => {
    const outbox = queueFolderMove(emptyOutbox(W), { id: id(), path: "garden", to: "allotment", now: now() })!;
    const shown = overlayListings(bucketListings(), outbox);
    expect(shown[""]!.entries.map((one) => one.path).sort()).toEqual(["allotment", "projects"]);
    expect(shown.garden).toBeUndefined();
    expect(shown.allotment!.entries.map((one) => one.path)).toEqual(["allotment/herbs", "allotment/basil.md"]);
    expect(shown["allotment/herbs"]!.entries.map((one) => one.path)).toEqual(["allotment/herbs/mint.md"]);
  });

  test("a note made inside a renamed folder is drawn in it", () => {
    let outbox = queueFolderMove(emptyOutbox(W), { id: id(), path: "garden", to: "allotment", now: now() })!;
    outbox = save(outbox, "allotment/thyme.md", "x", null);
    const shown = overlayListings(bucketListings(), outbox);
    expect(shown.allotment!.entries.map((one) => one.path)).toContain("allotment/thyme.md");
  });

  test("a deleted folder is gone, and so is everything under it", () => {
    const outbox = queueFolderRemoval(emptyOutbox(W), { id: id(), path: "garden", kind: "trash", now: now() })!;
    const shown = overlayListings(bucketListings(), outbox);
    expect(shown[""]!.entries.map((one) => one.path)).toEqual(["projects"]);
    expect(shown.garden).toBeUndefined();
    expect(shown["garden/herbs"]).toBeUndefined();
  });
});

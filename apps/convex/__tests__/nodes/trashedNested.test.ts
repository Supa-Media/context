/**
 * A note inside a folder that went to the trash: Restore of just that note,
 * and its text read back where the trash holds it, for the console to show it
 * in place after a reload (`readTrashedText`, `trashedNotes.readTrashedNote`).
 *
 * The store here is built the way the credential barrier builds it
 * (`storeWithMoves`, then `attachQueueMove`), so a request reads through the
 * moves that were pending when it began, as a real one does.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop the folder match in `undoTrash` ("busy" for a key inside a queued
 *    folder trash) and Restore while queued is "not found";
 *  - answer `false` instead of a fresh store once the trash landed and the
 *    restore fails, writing through moves that are already over;
 *  - drop the `match[1] !== path` check in `readTrashedText` and another
 *    note's trash key reads back under this name;
 *  - drop its `canSee` and a member reads a private note's trashed text;
 *  - fold through nothing (read only the trash key) and a note whose trash is
 *    still queued is "not found";
 *  - drop the trail check in `readTrashedNote` and a path with no trash
 *    reaches storage rather than being refused.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import { executeOperation } from "../../functions/lib/filesFns/executeOperation";
import { readTrashedText } from "../../functions/lib/fileOps/trashedReading";
import { attachQueueMove, storeWithMoves } from "../../functions/lib/nodes/moveBarrier";
import { OWNER, TEAM, bucketKeys, drain, fixture, type Fixture } from "./moveFixture.helpers";

type Moved = { kind: "moved"; from: string; to: string; paths: string[]; queued?: number };
type Operation = { kind: "trash"; path: string } | { kind: "restoreTrash"; from: string; to: string };

/** One request as the barrier makes it: through the moves pending now, with the queue's seams attached. */
async function request(f: Fixture, operation: Operation, clearance = OWNER, wait?: (ms: number) => Promise<void>) {
  const args = { workspaceId: f.ws, scope: clearance.scope, operation: { kind: operation.kind } };
  const store = await requestStore(f, args);
  attachQueueMove(f.ctx, args, store, f.store, wait);
  return (await executeOperation(store, clearance, operation, Date.now())) as Moved;
}

async function requestStore(f: Fixture, args: { workspaceId: Fixture["ws"]; scope: "private" | "team"; operation: { kind: string } }) {
  const moves = await f.t.query(internal.functions.nodeMoves.active, { workspaceId: f.ws });
  return await storeWithMoves(f.ctx, args, f.store, moves);
}

const BRIEF = "1-projects/launch/brief.md";
const trashKeys = (f: Fixture) => Object.keys(f.store.snapshot()).filter((key) => key.startsWith(".context/trash/")).sort();

describe("restoring one note out of a trashed folder", () => {
  test("after the bucket caught up, takes that note back and leaves the rest in the trash", async () => {
    const f = await fixture("s3");
    const folder = await request(f, { kind: "trash", path: "1-projects/launch" });
    await drain(f);
    await request(f, { kind: "restoreTrash", from: `${folder.to}/brief.md`, to: BRIEF });
    expect(f.store.snapshot()[BRIEF]).toContain("# Brief");
    expect(trashKeys(f).map((key) => key.slice(folder.to.length))).toEqual(["/pic.png", "/plan.md", "/sub/deep.md"]);
  });

  test("while the folder's trash is still queued, waits for it to land and then takes the note back", async () => {
    const f = await fixture("s3");
    const folder = await request(f, { kind: "trash", path: "1-projects/launch" });
    expect(bucketKeys(f.store)).toContain(BRIEF);
    let waits = 0;
    const restored = await request(f, { kind: "restoreTrash", from: `${folder.to}/brief.md`, to: BRIEF }, OWNER, async () => {
      waits += 1;
      await drain(f);
    });
    expect(waits).toBe(1);
    expect(restored).toMatchObject({ to: BRIEF });
    expect(f.store.snapshot()[BRIEF]).toContain("# Brief");
    expect(trashKeys(f).map((key) => key.slice(folder.to.length))).toEqual(["/pic.png", "/plan.md", "/sub/deep.md"]);
  });

  test("the queue says busy only for a key inside the queued folder's own trash", async () => {
    const f = await fixture("s3");
    const folder = await request(f, { kind: "trash", path: "1-projects/launch" });
    const ask = (trash: string, path: string) =>
      f.t.mutation(internal.functions.nodeMoves.undoTrash, { workspaceId: f.ws, trash, path, now: Date.now() });
    expect(await ask(`${folder.to}/brief.md`, BRIEF)).toBe("busy");
    expect(await ask(".context/trash/1999-01-01T00-00-00-000Z/1-projects/launch/brief.md", BRIEF)).toBe("none");
    expect(await ask(`${folder.to}/brief.md`, "1-projects/launch/plan.md")).toBe("none");
  });
});

describe("reading a trashed note's text", () => {
  const read = async (f: Fixture, path: string, trash: string, clearance = OWNER) =>
    await readTrashedText(await requestStore(f, { workspaceId: f.ws, scope: clearance.scope, operation: { kind: "readTrashed" } }), { path, trash, clearance });

  test("reads it where the trash holds it, and where the bucket still has it while the trash is queued", async () => {
    const f = await fixture("s3");
    const folder = await request(f, { kind: "trash", path: "1-projects/launch" });
    expect(await read(f, BRIEF, `${folder.to}/brief.md`)).toMatchObject({ kind: "trashedText", path: BRIEF, text: "# Brief\n" });
    // Read without moving it: the folder's move still carries it.
    expect(bucketKeys(f.store)).toContain(BRIEF);
    await drain(f);
    expect(await read(f, BRIEF, `${folder.to}/brief.md`)).toMatchObject({ text: "# Brief\n" });
  });

  test("refuses a key that is not this note's own copy in the trash", async () => {
    const f = await fixture("s3");
    const folder = await request(f, { kind: "trash", path: "1-projects/launch" });
    await drain(f);
    await expect(read(f, BRIEF, `${folder.to}/plan.md`)).rejects.toThrow("That file does not exist.");
    await expect(read(f, BRIEF, ".context/forwarding.json")).rejects.toThrow("That file does not exist.");
    await expect(read(f, `${folder.to}/brief.md`, `${folder.to}/brief.md`)).rejects.toThrow();
  });

  test("a member never reads a private note's trashed text, even with its key", async () => {
    const f = await fixture("s3");
    const trashed = await request(f, { kind: "trash", path: "1-projects/secret/codes.md" });
    await drain(f);
    await expect(read(f, "1-projects/secret/codes.md", trashed.to, TEAM)).rejects.toThrow("That file does not exist.");
    expect(await read(f, "1-projects/secret/codes.md", trashed.to)).toMatchObject({ text: "# Codes\n" });
  });
});

describe("readTrashedNote, the console's action", () => {
  const trail = (f: Fixture, note: string, trash: string) =>
    f.t.mutation(internal.functions.audit.recordEvent, {
      workspaceId: f.ws,
      actorUserId: f.ownerId,
      action: "file.archive",
      paths: [note, trash],
      details: { files: 1, recoverable: true, trash: true },
    });
  const ask = (who: Fixture["owner"], f: Fixture, path: string) =>
    who.action(api.functions.trashedNotes.readTrashedNote, { workspaceId: f.ws, path });

  test("refuses, before any storage, a note with no trash, a hidden one, and a trash key named directly", async () => {
    const f = await fixture("s3");
    const SECRET_TRASH = ".context/trash/2026-10-14T05-00-00-000Z/1-projects/secret/codes.md";
    await trail(f, "1-projects/secret/codes.md", SECRET_TRASH);
    // The workspace has no storage bound: an answer past the trail would be a storage refusal, not this.
    await expect(ask(f.owner, f, "1-projects/launch/plan.md")).rejects.toThrow("That file does not exist.");
    await expect(ask(f.member, f, "1-projects/secret/codes.md")).rejects.toThrow("That file does not exist.");
    await expect(ask(f.member, f, SECRET_TRASH)).rejects.toThrow("That file does not exist.");
    await expect(ask(f.owner, f, SECRET_TRASH)).rejects.toThrow("That file does not exist.");
    // The owner's own trail does reach storage, which is what makes the refusals above the trail's.
    await expect(ask(f.owner, f, "1-projects/secret/codes.md")).rejects.toThrow("no bucket connected");
  });
});

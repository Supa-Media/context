/**
 * A move between two keyed workspaces (`docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * Every workspace is keyed: a note's bytes live only at `notes/<noteId>.md`,
 * and the tree's rows name them. So a move:
 *  - lists what moves from the source's rows, never the bucket;
 *  - reads each note at its key, through the same store layer every read uses;
 *  - lands each note in the destination as a new note of its own, under a new id;
 *  - leaves the source's note in its trash as a row (restorable there), never deleted.
 *
 * Each case fails if its guard is removed: a move that reads or lists by path
 * lands the wrong text, or a name the tree already holds.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, createUser, drainScheduled } from "./fixtures.helpers";
import {
  bodyOfRow,
  liveFileAt,
  liveFilesUnder,
  pair as pairOf,
  writeAs,
  type Pair,
} from "./contextMove.helpers";

async function move(p: Pair, from: string, to: string) {
  const { moveId } = await asUser(p.t, p.mover).action(api.functions.contextMoves.startContextMove, {
    sourceWorkspaceId: p.from,
    from,
    destinationWorkspaceId: p.to,
    to,
  });
  await drainScheduled(p.t);
  return await p.t.run((ctx) => ctx.db.get(moveId));
}

describe.each([
  { carrier: "this deployment", mover: false },
  { carrier: "the gateway's mover", mover: true },
])("a move between keyed workspaces, carried by $carrier", { timeout: 30_000 }, ({ mover }) => {
  const pair = (options: Parameters<typeof pairOf>[0] = {}) => pairOf({ ...options, mover });

  test("one note arrives as a new note at its own key, and the source's goes to its trash", async () => {
    const p = await pair({ notes: 3, into: "own" });
    const before = await liveFileAt(p.t, p.from, "1-projects/acme/note-001.md");

    const row = await move(p, "1-projects/acme/note-001.md", "work/note-001.md");

    expect([row?.status, row?.error]).toEqual(["complete", undefined]);
    expect(row?.movedObjects).toBe(1);
    const landed = await liveFileAt(p.t, p.to, "work/note-001.md");
    expect(landed?.storageKey).toMatch(/^notes\/[0-9a-f-]+\.md$/);
    expect(landed?.noteId).not.toBe(before?.noteId);
    expect(bodyOfRow(p.destination, landed)).toBe("# 1\n");
    // Never written by path in the destination.
    expect(p.destination.objects.has("work/note-001.md")).toBe(false);

    expect(await liveFileAt(p.t, p.from, "1-projects/acme/note-001.md")).toBeNull();
    const trashed = (await liveFilesUnder(p.t, p.from, ".context/trash/")).find((r) => r.noteId === before?.noteId);
    expect(trashed?.path).toMatch(/^\.context\/trash\/[^/]+\/1-projects\/acme\/note-001\.md$/);
    // The bytes stay at the source's key: the trash restores them.
    expect(bodyOfRow(p.source, before)).toBe("# 1\n");
    // The neighbours are untouched.
    expect(await liveFileAt(p.t, p.from, "1-projects/acme/note-000.md")).not.toBeNull();
  });

  test("a folder bigger than one batch arrives whole, private, and leaves the source empty", async () => {
    const p = await pair({ notes: 45, into: "shared" });
    // A member of the shared destination, who reads its team folders and nothing private.
    const member = await createUser(p.t, "member@example.invalid");
    await addMember(p.t, p.to, member, "member");

    const row = await move(p, "1-projects/acme", "work/acme");

    expect([row?.status, row?.error]).toEqual(["complete", undefined]);
    expect(row?.movedObjects).toBe(45);
    const landed = await liveFilesUnder(p.t, p.to, "work/acme/");
    expect(landed).toHaveLength(45);
    const first = await liveFileAt(p.t, p.to, "work/acme/note-000.md");
    expect(bodyOfRow(p.destination, first)).toBe("# 0\n");
    // The notes were private where they came from, so they land private in a team folder.
    const seen = await asUser(p.t, member).query(api.functions.nodesListing.listFolder, { workspaceId: p.to, path: "work/acme" });
    expect(seen?.entries ?? []).toEqual([]);
    expect(await liveFilesUnder(p.t, p.from, "1-projects/acme/")).toEqual([]);
    expect(await liveFileAt(p.t, p.from, "1-projects/README.md")).not.toBeNull();
    // Nothing is written into the destination by path.
    expect([...p.destination.objects.keys()].some((key) => key.startsWith("work/acme/"))).toBe(false);
  });

  test("a name already taken in the destination stops the move and leaves the source in place", async () => {
    const p = await pair({ notes: 2, into: "own" });
    await writeAs(p, p.mover, p.to, "work/note-000.md", "already here\n");
    const taken = await liveFileAt(p.t, p.to, "work/note-000.md");

    const row = await move(p, "1-projects/acme/note-000.md", "work/note-000.md");

    expect(row?.status).toBe("failed");
    expect(await liveFileAt(p.t, p.from, "1-projects/acme/note-000.md")).not.toBeNull();
    expect(bodyOfRow(p.destination, taken)).toBe("already here\n");
  });
});

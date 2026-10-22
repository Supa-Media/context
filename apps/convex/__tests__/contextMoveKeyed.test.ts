/**
 * A move into another workspace when either end keeps its notes under their
 * ids (`docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * In a keyed workspace a note's bytes live only at `notes/<noteId>.md` and the
 * object at its path is a frozen copy nothing reads again. The move used to
 * refuse there ("this operation works on paths"), which left a person with no
 * way to move a note from one workspace to another once both were keyed.
 *
 * So the keyed half of each end works through the tree and the id layer:
 *  - the source lists what moves from its rows, never the bucket;
 *  - it reads each note at its key, through the same store layer every read uses;
 *  - the destination lands each note as a new note of its own, under a new id;
 *  - the source's note goes to its trash as a row (restorable there), never deleted.
 *
 * Each case fails if its guard is removed: the frozen copies are seeded with
 * text that must never arrive, and a move that reads or lists by path carries it.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, createUser, drainScheduled, type TestConvex } from "./fixtures.helpers";
import { pair as pairOf, recopyTree, type Pair } from "./contextMove.helpers";
import { keyWorkspace } from "./contextMoveKeyed.helpers";
import type { MemoryS3 } from "./storeStub.helpers";

/**
 * Access on the rows, as production runs: the rules are the authority, the rows
 * are derived from them and checked, and staff switch the readers to the rows.
 */
async function rowsMode(t: TestConvex): Promise<void> {
  const staff = "staff@example.invalid";
  vi.stubEnv(ADMIN_EMAILS_ENV_VAR, staff);
  const admin = asUser(t, await createUser(t, staff));
  await t.run(async (ctx) => {
    const row = await ctx.db.query("nodeMigration").first();
    if (row === null) await ctx.db.insert("nodeMigration", { paused: false, privacyAuthority: true, updatedAt: 1 });
    else await ctx.db.patch(row._id, { privacyAuthority: true });
  });
  await admin.mutation(api.functions.privacyRows.startKeeping, {});
  await drainScheduled(t);
  await admin.mutation(api.functions.privacyRows.checkAll, {});
  await drainScheduled(t);
  await admin.mutation(api.functions.privacyRows.useRows, {});
}

afterEach(() => vi.unstubAllEnvs());

async function liveRow(t: TestConvex, workspaceId: Id<"workspaces">, path: string) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
      .unique();
    return row !== null && row.goneAt === undefined ? row : null;
  });
}

async function liveRowsUnder(t: TestConvex, workspaceId: Id<"workspaces">, prefix: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId)).collect()).filter(
      (row) => row.goneAt === undefined && row.path.startsWith(prefix),
    ),
  );
}

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

function bodyAtKey(bucket: MemoryS3, key: string | undefined): string | undefined {
  return key === undefined ? undefined : bucket.objects.get(key)?.body;
}

describe.each([
  { carrier: "this deployment", mover: false, access: "privacy.md" },
  { carrier: "the gateway's mover", mover: true, access: "privacy.md" },
  { carrier: "the gateway's mover", mover: true, access: "rows" },
])("a move between keyed workspaces, carried by $carrier, access from $access", { timeout: 30_000 }, ({ mover, access }) => {
  const pair = (options: Parameters<typeof pairOf>[0] = {}) => pairOf({ ...options, mover });
  /** Key the ends asked for, then (for `rows`) switch the deployment's access to the rows. */
  const keyed = async (p: Pair, ends: { from?: boolean; to?: boolean }) => {
    if (ends.from === true) await keyWorkspace(p.t, p.from, p.source);
    if (ends.to === true) await keyWorkspace(p.t, p.to, p.destination);
    if (access === "rows") await rowsMode(p.t);
  };

  test("one note arrives as a new note at its own key, and the source's goes to its trash", async () => {
    const p = await pair({ notes: 3, into: "own" });
    await keyed(p, { from: true, to: true });
    const before = await liveRow(p.t, p.from, "1-projects/acme/note-001.md");

    const row = await move(p, "1-projects/acme/note-001.md", "work/note-001.md");

    expect([row?.status, row?.error]).toEqual(["complete", undefined]);
    expect(row?.movedObjects).toBe(1);
    const landed = await liveRow(p.t, p.to, "work/note-001.md");
    expect(landed?.storageKey).toMatch(/^notes\/[0-9a-f-]+\.md$/);
    expect(landed?.noteId).not.toBe(before?.noteId);
    expect(bodyAtKey(p.destination, landed?.storageKey)).toBe("# 1\n");
    // Never written by path in the destination.
    expect(p.destination.objects.has("work/note-001.md")).toBe(false);

    expect(await liveRow(p.t, p.from, "1-projects/acme/note-001.md")).toBeNull();
    const trashed = (await liveRowsUnder(p.t, p.from, ".context/trash/")).find((r) => r.noteId === before?.noteId);
    expect(trashed?.path).toMatch(/^\.context\/trash\/[^/]+\/1-projects\/acme\/note-001\.md$/);
    // The bytes stay at the source's key: the trash restores them.
    expect(bodyAtKey(p.source, before?.storageKey)).toBe("# 1\n");
    // The neighbours are untouched.
    expect(await liveRow(p.t, p.from, "1-projects/acme/note-000.md")).not.toBeNull();
  });

  test("a folder bigger than one batch arrives whole, private, and leaves the source empty", async () => {
    const p = await pair({ notes: 45, into: "shared" });
    // A member of the shared destination, who reads its team folders and nothing private.
    const member = await createUser(p.t, "member@example.invalid");
    await addMember(p.t, p.to, member, "member");
    await keyed(p, { from: true, to: true });

    const row = await move(p, "1-projects/acme", "work/acme");

    expect([row?.status, row?.error]).toEqual(["complete", undefined]);
    expect(row?.movedObjects).toBe(45);
    const landed = await liveRowsUnder(p.t, p.to, "work/acme/");
    expect(landed.filter((r) => r.kind === "file")).toHaveLength(45);
    const first = await liveRow(p.t, p.to, "work/acme/note-000.md");
    expect(bodyAtKey(p.destination, first?.storageKey)).toBe("# 0\n");
    // The notes were private where they came from, so they land private in a team folder.
    const seen = await asUser(p.t, member).query(api.functions.nodesListing.listFolder, { workspaceId: p.to, path: "work/acme" });
    expect(seen?.entries ?? []).toEqual([]);
    expect((await liveRowsUnder(p.t, p.from, "1-projects/acme/")).filter((r) => r.kind === "file")).toEqual([]);
    expect(await liveRow(p.t, p.from, "1-projects/README.md")).not.toBeNull();
    // Nothing that arrived is a source's frozen path copy (the destination's own README is frozen too).
    for (const landedRow of landed.filter((r) => r.kind === "file")) {
      expect(bodyAtKey(p.destination, landedRow.storageKey)).not.toContain("FROZEN COPY");
    }
    expect([...p.destination.objects.keys()].some((key) => key.startsWith("work/acme/"))).toBe(false);
  });

  test("a move with a side not keyed yet fails and leaves the note where it was: path keys are gone", async () => {
    for (const side of [{ from: true }, { to: true }]) {
      const p = await pair({ notes: 2, into: "own" });
      await keyed(p, side);
      const before = await liveRow(p.t, p.from, "1-projects/acme/note-000.md");

      const row = await move(p, "1-projects/acme/note-000.md", "work/note-000.md");

      expect(row?.status).toBe("failed");
      const after = await liveRow(p.t, p.from, "1-projects/acme/note-000.md");
      expect(after?._id).toBe(before?._id);
      expect(await liveRow(p.t, p.to, "work/note-000.md")).toBeNull();
      expect(p.destination.objects.has("work/note-000.md")).toBe(false);
    }
  });

  test("a name already taken in a keyed destination stops the move and leaves the source in place", async () => {
    const p = await pair({ notes: 2, into: "own" });
    p.destination.seed("work/note-000.md", "already here\n");
    await recopyTree(p.t, p.to);
    await keyed(p, { from: true, to: true });
    const taken = await liveRow(p.t, p.to, "work/note-000.md");

    const row = await move(p, "1-projects/acme/note-000.md", "work/note-000.md");

    expect(row?.status).toBe("failed");
    expect(await liveRow(p.t, p.from, "1-projects/acme/note-000.md")).not.toBeNull();
    expect(bodyAtKey(p.destination, taken?.storageKey)).toBe("already here\n");
  });
});

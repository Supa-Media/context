/**
 * Access asked for on a path with no row yet, in rows mode (`lib/nodes/pendingAccess.ts`):
 * the row is born with it, the path is closed while it waits, and a wait that runs past an
 * hour is dropped. Driven through the real seams: `setAccessRow` (what the gateway's
 * `setAccess` and the console call) and `noteIdsKeyed.adoptKeyed` (what a keyed write
 * brings), so the row is born the way a note's row is.
 *
 * What is proved:
 *  - a private base asked before the row exists is the row's once the note is adopted, and a
 *    member cannot see the note (the bucket write that follows the ask is what births it);
 *  - while it waits the path is closed: a private base renders as a private override, so the
 *    path is not visible to a member even under a team folder;
 *  - a team base waits and is applied, and the row is team under a private folder;
 *  - an entry older than `PENDING_TTL_MS` is dropped unapplied; the row inherits;
 *  - `inherit` drops a waiting entry; a list on a path with no row is still refused;
 *  - the waiting list has a cap (`PENDING_MAX`), refused as `PENDING_FULL`;
 *  - a website folder with no row takes team as pending, and keeps a base already waiting for it.
 *
 * Sabotage (each must fail its own case): drop the `applyPendingAccess` call in
 * `convexNodeTable.insert` (the born-private and born-team cases fail); drop the
 * `Date.now()` expiry check in `applyPendingAccess` (the expired case fails).
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { canSee } from "../../functions/lib/privacy";
import { idKeyFor } from "../../functions/lib/nodes/noteIds";
import { PARA_FOLDERS } from "../../functions/lib/scaffold/store";
import { PENDING_MAX, PENDING_TTL_MS } from "../../functions/lib/nodes/pendingAccess";
import { convexNodeTable } from "../../functions/lib/nodes/convexTable";
import { rulesForReaders } from "../../functions/lib/nodes/readerRules";
import { setAccessRow } from "../../functions/lib/nodes/setAccess";
import { NOTE_ID, keyedFixture } from "./keyedFixture.helpers";
import { listed, type Fixture } from "./moveFixture.helpers";
import { nodeAt as treeNodeAt } from "../../functions/lib/nodes/paths";
import { parentRows } from "./treeRows.helpers";

async function setRowsMode(f: Fixture): Promise<void> {
  await f.t.run(async (ctx) => {
    const row = await ctx.db.query("nodeMigration").first();
    if (row === null) await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 });
    else await ctx.db.patch(row._id, { accessSource: "rows" });
  });
}

/** The owner sets one row's base, as the console or the gateway would. */
async function setBase(f: Fixture, path: string, base: "private" | "team" | "inherit") {
  return await f.t.run(async (ctx) =>
    setAccessRow(ctx as MutationCtx, { workspaceId: f.ws, path, base, grantees: [], actor: { userId: f.ownerId, role: "owner" } }),
  );
}

/** A path with no row yet: the owner asks for a base for it, as `write_note` does before its bucket write. */
async function askFor(f: Fixture, path: string, base: "private" | "team", kind: "file" | "folder" = "file") {
  return await f.t.run(async (ctx) =>
    setAccessRow(ctx as MutationCtx, { workspaceId: f.ws, path, base, grantees: [], kind, actor: { userId: f.ownerId, role: "owner" } }),
  );
}

/** The note's row is adopted at its id key: the keyed write the store seam makes. */
async function adopt(f: Fixture, path: string, noteId: string) {
  return await f.t.mutation(internal.functions.noteIdsKeyed.adoptKeyed, {
    workspaceId: f.ws,
    path,
    noteId,
    key: idKeyFor(noteId, path),
    etag: `k-${noteId}`,
    at: Date.now(),
  });
}

/**
 * The PARA folders the fixture's seeded `privacy.md` names (`renderPrivacyManifest("para")`) have no rows, so they
 * wait as pending entries the whole run. They are fixture noise, not what a case asserts about, so the waiting
 * list a case reads leaves them out. Every other entry still counts.
 */
const FIXTURE_WAITING = new Set<string>(PARA_FOLDERS);

async function waitingOf(f: Fixture) {
  const state = await stateOf(f);
  return (state?.pending ?? []).filter((entry) => !FIXTURE_WAITING.has(entry.path));
}

async function nodeAt(f: Fixture, path: string) {
  return await f.t.run(async (ctx) => treeNodeAt(ctx.db, f.ws, path));
}

async function stateOf(f: Fixture) {
  return await f.t.run(async (ctx) =>
    ctx.db
      .query("nodeAccessState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws))
      .unique(),
  );
}

/** Whether the readers the rows give let a clearance see the path (`canSee`, as every reader asks it). */
async function readersSee(f: Fixture, path: string, scope: "private" | "team"): Promise<boolean> {
  return await f.t.run(async (ctx) => {
    const rules = await rulesForReaders(ctx as unknown as QueryCtx, f.ws);
    return canSee(path, scope, rules.rules, rules.overrides, new Set());
  });
}

const NEW = "1-projects/new.md";
const NEW_ID = NOTE_ID(50);

describe("a private base asked before the row exists", () => {
  test("is the row's when the note is adopted, and a member cannot see the note", async () => {
    const f = await keyedFixture();
    await setRowsMode(f);
    await setBase(f, "1-projects", "team");

    expect(await askFor(f, NEW, "private")).toMatchObject({ ok: true });
    // Closed while it waits: the path is a private override, so the team folder does not reach it.
    expect(await readersSee(f, NEW, "team")).toBe(false);
    expect(await readersSee(f, "1-projects/keep.md", "team")).toBe(true);

    expect(await adopt(f, NEW, NEW_ID)).toEqual({ adopted: true });
    expect((await nodeAt(f, NEW))?.access).toEqual({ base: "private" });
    expect(await listed(f.member, f.ws, "1-projects")).not.toContain(NEW);
    expect(await listed(f.owner, f.ws, "1-projects")).toContain(NEW);
    expect(await waitingOf(f)).toEqual([]);
  });

  test("a team base waits too, and the row is team under a private folder", async () => {
    const f = await keyedFixture();
    await setRowsMode(f);
    await setBase(f, "1-projects/secret", "private");
    const path = "1-projects/secret/new.md";

    expect(await askFor(f, path, "team")).toMatchObject({ ok: true });
    // A team base is not rendered while it waits: the path inherits its private folder.
    expect(await readersSee(f, path, "team")).toBe(false);

    expect(await adopt(f, path, NOTE_ID(51))).toEqual({ adopted: true });
    expect((await nodeAt(f, path))?.access).toEqual({ base: "team" });
    expect(await readersSee(f, path, "team")).toBe(true);
  });

  test("an entry older than an hour is dropped unapplied: the row inherits", async () => {
    const f = await keyedFixture();
    await setRowsMode(f);
    await setBase(f, "1-projects", "team");
    await askFor(f, NEW, "private");
    await f.t.run(async (ctx) => {
      const state = await ctx.db.query("nodeAccessState").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).unique();
      const pending = (state?.pending ?? []).map((entry) => ({ ...entry, at: Date.now() - PENDING_TTL_MS - 60_000 }));
      await ctx.db.patch(state!._id, { pending });
    });
    // Expired: not rendered, so the path is open to the team folder.
    expect(await readersSee(f, NEW, "team")).toBe(true);

    expect(await adopt(f, NEW, NEW_ID)).toEqual({ adopted: true });
    expect((await nodeAt(f, NEW))?.access).toBeUndefined();
    expect(await waitingOf(f)).toEqual([]);
  });

  test("inherit drops a waiting entry, so the row is born with no base", async () => {
    const f = await keyedFixture();
    await setRowsMode(f);
    await setBase(f, "1-projects", "team");
    await askFor(f, NEW, "private");
    expect(await setBase(f, NEW, "inherit")).toMatchObject({ ok: true });
    expect(await readersSee(f, NEW, "team")).toBe(true);

    expect(await adopt(f, NEW, NEW_ID)).toEqual({ adopted: true });
    expect((await nodeAt(f, NEW))?.access).toBeUndefined();
  });

  test("a second ask replaces the first and moves the version, and a stale version is a conflict", async () => {
    const f = await keyedFixture();
    await setRowsMode(f);
    const first = await askFor(f, NEW, "private");
    expect(first).toMatchObject({ ok: true });
    const firstVersion = (first as { version: number }).version;
    expect(await askFor(f, NEW, "team")).toEqual({ ok: true, version: firstVersion + 1 });
    expect(await f.t.run(async (ctx) => setAccessRow(ctx as MutationCtx, {
      workspaceId: f.ws, path: NEW, base: "private", grantees: [], expectedVersion: firstVersion, actor: { userId: f.ownerId, role: "owner" },
    }))).toEqual({ ok: false, code: "CONFLICT" });
    expect((await waitingOf(f)).filter((entry) => entry.path === NEW).map((entry) => entry.base)).toEqual(["team"]);
  });

  test("the waiting list has a cap: past it a new path is refused, and an existing one may change", async () => {
    const f = await keyedFixture();
    await setRowsMode(f);
    // The fixture's own waiting entries count toward the cap, so fill only the room that is left.
    const used = (await stateOf(f))?.pending?.length ?? 0;
    for (let n = 0; n < PENDING_MAX - used; n += 1) expect(await askFor(f, `1-projects/p${n}.md`, "private")).toMatchObject({ ok: true });
    expect(await askFor(f, "1-projects/one-too-many.md", "private")).toEqual({ ok: false, code: "PENDING_FULL" });
    expect(await askFor(f, "1-projects/p0.md", "team")).toMatchObject({ ok: true });
  });

  test("a row that stands at a waiting path takes the owner's next write, and the waiting entry is dropped", async () => {
    const f = await keyedFixture();
    await setRowsMode(f);
    await setBase(f, "1-projects", "team");
    await askFor(f, NEW, "private");
    // A row born without the seam: nothing applies the waiting entry to it.
    await f.t.run(async (ctx) => {
      await ctx.db.insert("nodes", {
        workspaceId: f.ws,
        path: NEW,
        name: "new.md",
        kind: "file",
        observedAt: 1,
      });
      await parentRows(ctx, f.ws);
    });
    expect(await setBase(f, NEW, "team")).toMatchObject({ ok: true });
    expect(await waitingOf(f)).toEqual([]);
    expect((await nodeAt(f, NEW))?.access).toEqual({ base: "team" });
    expect(await readersSee(f, NEW, "team")).toBe(true);
  });

  test("a list on a path with no row is still refused, as NOT_FOUND", async () => {
    const f = await keyedFixture();
    await setRowsMode(f);
    const answer = await f.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, {
        workspaceId: f.ws,
        path: NEW,
        base: "private",
        grantees: [{ kind: "email", email: "friend@example.test", role: "view" }],
        actor: { userId: f.ownerId, role: "owner" },
      }),
    );
    expect(answer).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await waitingOf(f)).toEqual([]);
  });
});

describe("a website folder with no row yet", () => {
  test("takes team as pending, and the folder row is born team", async () => {
    const f = await keyedFixture();
    await setRowsMode(f);
    const answer = await f.t.mutation(internal.functions.nodesAccess.ensureFolderDefault, {
      workspaceId: f.ws,
      actorUserId: f.ownerId,
      path: "3-site",
    });
    expect(answer).toEqual({ ok: true, visibility: "team", changed: true });
    expect(await nodeAt(f, "3-site")).toBeNull();

    await f.t.run(async (ctx) =>
      convexNodeTable(ctx as MutationCtx, f.ws).insert({ path: "3-site", name: "3-site", kind: "folder", observedAt: Date.now() }),
    );
    expect((await nodeAt(f, "3-site"))?.access).toEqual({ base: "team" });
  });

  test("keeps a base the owner already asked for it, and does not replace it with team", async () => {
    const f = await keyedFixture();
    await setRowsMode(f);
    expect(await askFor(f, "3-keep", "private", "folder")).toMatchObject({ ok: true });
    const answer = await f.t.mutation(internal.functions.nodesAccess.ensureFolderDefault, {
      workspaceId: f.ws,
      actorUserId: f.ownerId,
      path: "3-keep",
    });
    expect(answer).toEqual({ ok: true, visibility: "private", changed: false });

    await f.t.run(async (ctx) =>
      convexNodeTable(ctx as MutationCtx, f.ws).insert({ path: "3-keep", name: "3-keep", kind: "folder", observedAt: Date.now() }),
    );
    expect((await nodeAt(f, "3-keep"))?.access).toEqual({ base: "private" });
  });
});

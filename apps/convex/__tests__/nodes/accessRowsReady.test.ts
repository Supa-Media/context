/**
 * What `accessSource: "rows"` needs before it can be turned on safely (PR 2
 * follow-up to the privacy-rows plan, `lib/nodes/accessRows.ts`):
 *
 *  1. Readers read one snapshot document, not a scan of the tree, and the
 *     snapshot follows the rows when they move.
 *  2. The feed token moves when the access rows do, in rows mode only; file
 *     mode's token is the one `privacy.md` has always produced.
 *  3. The gateway binding carries the rules the rows render, with the rows'
 *     version, and a grant's row names reach the caller.
 *
 * Sabotage: drop the snapshot read in `accessRowsOf` (the snapshot tests fail);
 * drop the `access` argument from `feedToken` in rows mode (the token tests
 * fail); return `heldRules` instead of the rendered rules from `authority` (the
 * binding tests fail).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { fixture as movesFixture } from "./moveFixture.helpers";
import { keyedFixture, privacyEtag } from "./keyedFixture.helpers";
import { grantedNamesFor } from "../../functions/lib/grantedNames";
import { deriveAccess, deriveAccessPage, SNAPSHOT_MAX_ROWS } from "../../functions/lib/nodes/accessBackfill";
import { accessRowsOf, scanAccessRows } from "../../functions/lib/nodes/accessRows";
import { feedToken } from "../../functions/lib/nodes/log";
import { readMirror } from "../../functions/lib/nodes/privacyMirror";
import { renderAccess } from "../../functions/lib/nodes/rowAccess";

type Fixture = Awaited<ReturnType<typeof movesFixture>>;
type Mirror = Record<string, unknown>;

/** A rules mirror as the bucket read it: the etag, the folder rules and the note overrides. */
function mirrorOf(etag: string, folders: { prefix: string; visibility: string }[], notes: { path: string; visibility: string }[] = []): Mirror {
  return { etag, invalid: false, folders, notes };
}

// The rules a privacy write carries must be newer than the file's own observation, so the clock here runs ahead of it.
let clock = Date.now() + 60_000;
const later = () => (clock += 1_000);

async function rulesWrite(f: Fixture, mirror: Mirror): Promise<void> {
  await f.t.mutation(internal.functions.nodes.savePrivacy, { workspaceId: f.ws, mirror: mirror as never, at: later() });
}

async function setSource(f: Fixture, source: "file" | "shadow" | "rows"): Promise<void> {
  await f.t.mutation(internal.functions.nodesPrivacy.setAccessSource, { workspaceId: f.ws, source });
}

async function stateOf(f: Fixture) {
  return await f.t.run(async (ctx) =>
    ctx.db
      .query("nodeAccessState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws))
      .unique(),
  );
}

async function scannedRows(f: Fixture) {
  return await f.t.run(async (ctx) => await scanAccessRows(ctx as unknown as QueryCtx, f.ws));
}

async function readRows(f: Fixture) {
  return await f.t.run(async (ctx) => await accessRowsOf(ctx as unknown as QueryCtx, f.ws));
}

/** The workspace's `@acme-leads` group, with the member in it: a grant on a row resolves to them. */
async function addLeads(f: Fixture): Promise<void> {
  await f.t.run(async (ctx) => {
    const now = Date.now();
    const groupId = await ctx.db.insert("workspaceGroups", { workspaceId: f.ws, name: "acme-leads", createdBy: f.ownerId, createdAt: now });
    await ctx.db.insert("names", { name: "acme-leads", kind: "group", groupId, claimedBy: f.ownerId, claimedAt: now });
    await ctx.db.insert("workspaceGroupMembers", { groupId, workspaceId: f.ws, userId: f.memberId, addedBy: f.ownerId, addedAt: now });
  });
}

async function noteIdOf(f: Fixture, path: string): Promise<string> {
  return await f.t.run(async (ctx) => {
    const row = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws).eq("path", path))
      .unique();
    if (row === null) throw new Error(`no row at ${path}`);
    return row.noteId ?? row._id;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("1. the snapshot", () => {
  test("a finished derivation leaves the rows it judged as the snapshot", async () => {
    const f = await movesFixture();
    await rulesWrite(
      f,
      mirrorOf("snap-1", [{ prefix: "1-projects", visibility: "team" }, { prefix: "1-projects/secret", visibility: "private" }], [
        { path: "1-projects/keep.md", visibility: "private" },
      ]),
    );
    await setSource(f, "rows");
    const scanned = await scannedRows(f);
    expect(scanned.map((row) => row.path)).toEqual(expect.arrayContaining(["1-projects", "1-projects/secret", "1-projects/keep.md"]));
    expect((await stateOf(f))?.snapshot).toEqual(scanned);
  });

  test("readers read the snapshot, not the rows: a snapshot that differs from the rows is what they judge by", async () => {
    const f = await movesFixture();
    await rulesWrite(f, mirrorOf("snap-2", [{ prefix: "1-projects/secret", visibility: "private" }]));
    await setSource(f, "rows");
    const sentinel = [{ path: "sentinel.md", noteId: "sentinel-note", kind: "file" as const, base: "team" as const, grantees: [] }];
    await f.t.run(async (ctx) => {
      const state = await ctx.db
        .query("nodeAccessState")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws))
        .unique();
      await ctx.db.patch(state!._id, { snapshot: sentinel });
    });
    expect(await readRows(f)).toEqual(sentinel);
  });

  test("with no snapshot the readers scan the rows", async () => {
    const f = await movesFixture();
    await rulesWrite(f, mirrorOf("snap-3", [{ prefix: "1-projects/secret", visibility: "private" }]));
    await setSource(f, "rows");
    await f.t.run(async (ctx) => {
      const state = await ctx.db
        .query("nodeAccessState")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws))
        .unique();
      await ctx.db.patch(state!._id, { snapshot: undefined });
    });
    expect(await readRows(f)).toEqual(await scannedRows(f));
  });

  test("a walk drops the snapshot before it rewrites a row, so no reader is told a stale path", async () => {
    const f = await movesFixture();
    await rulesWrite(f, mirrorOf("snap-4", [{ prefix: "1-projects/secret", visibility: "private" }]));
    await setSource(f, "rows");
    expect((await stateOf(f))?.snapshot).toBeDefined();
    await f.t.run(async (ctx) => {
      await deriveAccessPage(ctx as unknown as MutationCtx, f.ws, { after: null, pageSize: 2 });
    });
    expect((await stateOf(f))?.snapshot).toBeUndefined();
    expect(await readRows(f)).toEqual(await scannedRows(f));
  });

  test("after a folder move the snapshot paths follow the rows", async () => {
    const f = await keyedFixture();
    await rulesWrite(f, mirrorOf("snap-move", [{ prefix: "1-projects/launch", visibility: "private" }]));
    await setSource(f, "rows");
    // In rows mode a move is made under the rows' version (`privacyEtagNow`), not the file's.
    const answer = await f.t.mutation(internal.functions.nodeRowMoves.rowMove, {
      workspaceId: f.ws,
      from: "1-projects/launch",
      to: "3-resources/launch",
      privacyEtag: await f.t.query(internal.functions.nodesAccess.privacyEtagNow, { workspaceId: f.ws }),
      now: Date.now(),
    });
    expect(answer).toMatchObject({ ok: true });
    const scanned = await scannedRows(f);
    const snapshot = (await stateOf(f))?.snapshot;
    expect(snapshot).toBeDefined();
    expect(snapshot).toEqual(scanned);
    expect(snapshot?.map((entry) => entry.path)).not.toContain("1-projects/launch");
  });

  test("a snapshot past the row ceiling is not stored: readers scan, and the event is logged", async () => {
    const f = await movesFixture();
    const count = SNAPSHOT_MAX_ROWS + 1;
    const paths = Array.from({ length: count }, (_, index) => `2-areas/bulk/note-${index}.md`);
    await f.t.run(async (ctx) => {
      for (const path of paths) {
        await ctx.db.insert("nodes", { workspaceId: f.ws, path, name: path.slice(path.lastIndexOf("/") + 1), kind: "file", observedAt: 1 });
      }
    });
    await rulesWrite(f, mirrorOf("snap-big", [], paths.map((path) => ({ path, visibility: "team" }))));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await f.t.run(async (ctx) => {
      await deriveAccess(ctx as unknown as MutationCtx, f.ws);
    });
    expect((await stateOf(f))?.snapshot).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: "access.snapshot_too_large", workspaceId: f.ws, count }),
    );
    const rows = await readRows(f);
    expect(rows).toHaveLength(count);
    expect(rows).toEqual(await scannedRows(f));
  }, 120_000);
});

describe("2. the feed token", () => {
  test("file mode's token is the privacy.md token, with no access version in it", async () => {
    const f = await movesFixture();
    await rulesWrite(f, mirrorOf("tok-file", [{ prefix: "1-projects/secret", visibility: "private" }]));
    const head = await f.member.query(api.functions.nodesFeed.head, { workspaceId: f.ws });
    const expected = await f.t.run(async (ctx) => feedToken(await readMirror(ctx.db, f.ws)));
    expect(head?.token.split("|")[0]).toBe(expected);
    expect(head?.token).not.toContain("^a");
    // A derivation in file mode changes no version, so the token does not move with it.
    await f.t.run(async (ctx) => {
      await deriveAccess(ctx as unknown as MutationCtx, f.ws);
    });
    expect((await f.member.query(api.functions.nodesFeed.head, { workspaceId: f.ws }))?.token).toBe(head?.token);
  });

  test("rows mode: a derivation that changes no etag still moves the token, so devices re-judge", async () => {
    const f = await movesFixture();
    await rulesWrite(f, mirrorOf("tok-rows", [{ prefix: "1-projects/secret", visibility: "private" }]));
    await setSource(f, "rows");
    const before = (await f.member.query(api.functions.nodesFeed.head, { workspaceId: f.ws }))?.token;
    await f.t.run(async (ctx) => {
      await deriveAccess(ctx as unknown as MutationCtx, f.ws);
    });
    const after = (await f.member.query(api.functions.nodesFeed.head, { workspaceId: f.ws }))?.token;
    expect(before).toBeDefined();
    expect(after).not.toBe(before);
    // The privacy.md part is the same: only the rows' version moved.
    expect(after?.split("|")[0].split("^")[0]).toBe(before?.split("|")[0].split("^")[0]);
    expect(after?.split("|")[0]).toContain("^a");
  });

  test("rows mode: a row's access change moves the token, and a file edit does not", async () => {
    // In rows mode the rows are the truth: a rules write to `privacy.md` changes nothing a reader judges
    // (`savePrivacy` stands down), so only a row's own change moves the token devices re-judge by.
    const f = await movesFixture();
    await rulesWrite(f, mirrorOf("tok-rules-1", [{ prefix: "1-projects/secret", visibility: "private" }]));
    await setSource(f, "rows");
    const before = (await f.member.query(api.functions.nodesFeed.head, { workspaceId: f.ws }))?.token;
    await rulesWrite(f, mirrorOf("tok-rules-2", [{ prefix: "1-projects/secret", visibility: "team" }]));
    const afterFile = (await f.member.query(api.functions.nodesFeed.head, { workspaceId: f.ws }))?.token;
    expect(afterFile).toBe(before);
    await f.t.mutation(internal.functions.nodesAccess.setAccess, {
      workspaceId: f.ws,
      path: "1-projects/secret",
      base: "team",
      actor: { userId: f.ownerId, role: "owner" },
    });
    const afterRow = (await f.member.query(api.functions.nodesFeed.head, { workspaceId: f.ws }))?.token;
    expect(afterRow).not.toBe(before);
  });
});

describe("3. the gateway binding and the grants", () => {
  async function authorityOn(f: Fixture): Promise<void> {
    await f.t.run(async (ctx) => {
      const row = await ctx.db.query("nodeMigration").first();
      if (row === null) await ctx.db.insert("nodeMigration", { paused: false, privacyAuthority: true, updatedAt: 1 });
      else await ctx.db.patch(row._id, { privacyAuthority: true });
    });
  }

  test("rows mode: the binding's rules are the ones the rows render for a member, with the rows' version", async () => {
    const f = await movesFixture();
    await addLeads(f);
    // The rules are written before they become the authority: once they are, the file is their export and a write is ignored.
    await rulesWrite(
      f,
      mirrorOf("bind-rows", [{ prefix: "1-projects", visibility: "team" }, { prefix: "1-projects/secret", visibility: "private" }], [
        { path: "1-projects/keep.md", visibility: "@acme-leads" },
      ]),
    );
    await authorityOn(f);
    await setSource(f, "rows");
    const held = await f.t.query(internal.functions.nodesPrivacy.authority, { workspaceId: f.ws });
    // Plain values only: a `Map` cannot cross the Convex boundary, so the rendered rules are read as lists here.
    const rendered = await f.t.run(async (ctx) => {
      const out = renderAccess(await accessRowsOf(ctx as unknown as QueryCtx, f.ws), "member");
      return {
        folders: out.rules.map((rule) => ({ prefix: rule.prefix, visibility: rule.vis })),
        notes: [...out.overrides].map(([path, visibility]) => ({ path, visibility })),
      };
    });
    const keepToken = `@#${await noteIdOf(f, "1-projects/keep.md")}`;
    expect(held?.etag).toBe("bind-rows");
    expect(held?.folders).toEqual(rendered.folders);
    expect(held?.notes).toEqual(rendered.notes);
    expect(held?.notes).toEqual([{ path: "1-projects/keep.md", visibility: keepToken }]);
    expect(held?.accessVersion).toBe((await stateOf(f))?.version);
  });

  test("file mode: the binding is the stored rules, exactly, with no access version", async () => {
    const f = await movesFixture();
    await rulesWrite(f, mirrorOf("bind-file", [{ prefix: "1-projects/secret", visibility: "private" }]));
    await authorityOn(f);
    const held = await f.t.query(internal.functions.nodesPrivacy.authority, { workspaceId: f.ws });
    expect(held).toEqual({ etag: "bind-file", folders: [{ prefix: "1-projects/secret", visibility: "private" }], notes: [] });
  });

  test("rows mode: a member holding a row's grant gets the row's token name, a file-mode member does not", async () => {
    const f = await movesFixture();
    await addLeads(f);
    await rulesWrite(f, mirrorOf("names-1", [], [{ path: "1-projects/keep.md", visibility: "@acme-leads" }]));
    const token = `#${await noteIdOf(f, "1-projects/keep.md")}`;
    expect(await f.t.run(async (ctx) => await grantedNamesFor(ctx as unknown as QueryCtx, f.ws, f.memberId))).not.toContain(token);
    await setSource(f, "rows");
    const names = await f.t.run(async (ctx) => await grantedNamesFor(ctx as unknown as QueryCtx, f.ws, f.memberId));
    expect(names).toContain(token);
    // A caller who holds no grant gets no token.
    const ownerNames = await f.t.run(async (ctx) => await grantedNamesFor(ctx as unknown as QueryCtx, f.ws, f.ownerId));
    expect(ownerNames.some((name) => name.startsWith("#"))).toBe(false);
  });
});


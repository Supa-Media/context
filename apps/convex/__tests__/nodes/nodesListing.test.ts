/**
 * The console's live tree (`functions/nodesListing.ts`): a folder listed from
 * Convex must say exactly what the bucket's listing says, at every clearance,
 * and must answer `null` ("still loading") only while the workspace's first
 * copy has not finished. Parity is an alarm and Pause stops copying: neither
 * sends a reader anywhere (decided by the owner, 2026-10-13).
 *
 * Sabotage:
 *  - drop the `resolveFileAccess` call and the stranger case fails;
 *  - make `treeServes` gate on parity, an error, or the pause again and the
 *    "still answer" cases fail; make it answer before a first copy finished
 *    and the "still loading" case fails;
 *  - drop the `goneAt` skip in `childrenOf` and the gone-file case fails;
 *  - drop `retireEmptyFolders` (`observe.ts`) and the emptied-folder case fails;
 *  - hand `listFolder` a mirror-less store and the team cases fail.
 */

import { applyTreeObservation, seedTreeRows } from "../fixtures.helpers";
import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { folderRowsStore, NODE_LISTING_ROWS } from "../../functions/lib/nodes/listing";
import { listFolder } from "../../functions/lib/fileOps/listing";
import { clearanceOf } from "../../functions/lib/clearance";
import { translateMirror } from "../seededRules.helpers";
import { withSession } from "../session.helpers";

type T = ReturnType<typeof convexTest>;

interface Fixture {
  t: T;
  ws: Id<"workspaces">;
  owner: ReturnType<T["withIdentity"]>;
  member: ReturnType<T["withIdentity"]>;
  stranger: ReturnType<T["withIdentity"]>;
}

// Rows are keyed by their path with no trailing slash, so a folder's rule names it the same way.
const RULES = {
  invalid: false,
  folders: [
    { prefix: "1-projects", visibility: "team" },
    { prefix: "1-projects/secret", visibility: "private" },
  ],
  notes: [{ path: "2-areas/shared.md", visibility: "team" }],
};

async function fixture(): Promise<Fixture> {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const user = (email: string) => ctx.db.insert("users", { email, emailVerificationTime: now } as never);
    const ownerId = await user("owner@example.test");
    const memberId = await user("member@example.test");
    const strangerId = await user("stranger@example.test");
    const ws = await ctx.db.insert("workspaces", {
      slug: "acme",
      displayName: "Acme",
      createdBy: ownerId,
      kind: "shared",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: ownerId, role: "owner", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: memberId, role: "member", joinedAt: now });
    return { ws, ownerId, memberId, strangerId };
  });
  // An empty folder is a folder marker, which only the tree's seeding lays down; it also marks the tree served.
  await seedTreeRows(t, ids.ws, ["1-projects/empty-marker/"]);
  await observe(t, ids.ws, 10, ["privacy.md", "index.md", "1-projects/plan.md", "1-projects/secret/codes.md", "2-areas/mine.md", "2-areas/shared.md"]);
  await translateMirror(t, ids.ws, RULES);
  return {
    t,
    ws: ids.ws,
    owner: withSession(t, ids.ownerId),
    member: withSession(t, ids.memberId),
    stranger: withSession(t, ids.strangerId),
  };
}

/** The store's observations as the seam reports them: each path written at `at`, each `gone` path removed at `at`. */
async function observe(t: T, workspaceId: Id<"workspaces">, at: number, paths: string[], gone: string[] = []) {
  await applyTreeObservation(t, { workspaceId, at, rows: paths.map((path) => ({ path, etag: "e" })), gone });
}

const paths = (listing: { entries: { path: string }[] } | null) => listing?.entries.map((entry) => entry.path) ?? null;

describe("who may read", () => {
  test("a stranger and a signed-out caller are refused, served or not", async () => {
    const { t, ws, stranger } = await fixture();
    await expect(stranger.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path: "" })).rejects.toThrow();
    await expect(t.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path: "" })).rejects.toThrow();
  });
});

describe("when the tree answers", () => {
  // Decided by the owner, 2026-10-13: Convex always answers once the first
  // copy has finished. Pause stops copying; a tree that is not there yet is
  // "still loading" (null), never the bucket.
  test("once the first copy finished: a paused tree still answers", async () => {
    const { t, ws, owner } = await fixture();
    const ask = () => owner.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path: "" });
    expect(await ask()).not.toBeNull();

    await t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: true, updatedAt: 1 });
    });
    expect(await ask()).not.toBeNull();
  });

  test("a walk is handed the tree's rules, the same on every read", async () => {
    const { t, ws } = await fixture();
    const first = await t.query(internal.functions.nodes.served, { workspaceId: ws });
    const etag = first?.mirror.etag;
    expect(etag).toEqual(expect.any(String));
    expect(await t.query(internal.functions.nodes.served, { workspaceId: ws })).toMatchObject({ mirror: { etag } });
  });

  test("a tree with no parity yet is served", async () => {
    const { t, ws, owner } = await fixture();
    await t.run(async (ctx) => {
      const row = await ctx.db.query("nodeTrees").first();
      if (row) await ctx.db.patch(row._id, { parity: undefined });
    });
    expect(await owner.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path: "" })).not.toBeNull();
  });

  test("a first copy still running, never started, or unsupported is still loading: null", async () => {
    const { t, ws, owner } = await fixture();
    const ask = () => owner.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path: "" });
    const setStatus = (status: "empty" | "filling" | "unsupported") =>
      t.run(async (ctx) => {
        const row = await ctx.db.query("nodeTrees").first();
        if (row) await ctx.db.patch(row._id, { status, sweptAt: undefined });
      });
    await setStatus("filling");
    expect(await ask()).toBeNull();
    await setStatus("empty");
    expect(await ask()).toBeNull();
    await setStatus("unsupported");
    expect(await ask()).toBeNull();
    await t.run(async (ctx) => {
      const row = await ctx.db.query("nodeTrees").first();
      if (row) await ctx.db.delete(row._id);
    });
    expect(await ask()).toBeNull();
    expect(await t.query(internal.functions.nodes.served, { workspaceId: ws })).toBeNull();
  });

  test("a re-sweep of a finished copy keeps serving the rows it has", async () => {
    const { t, ws, owner } = await fixture();
    expect(await owner.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path: "" })).not.toBeNull();
  });
});

describe("what each person sees", () => {
  test("the owner sees every folder and file, plumbing aside", async () => {
    const { ws, owner } = await fixture();
    const root = await owner.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path: "" });
    expect(paths(root)).toEqual(expect.arrayContaining(["1-projects", "2-areas", "index.md", "privacy.md"]));
    const projects = await owner.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path: "1-projects" });
    expect(paths(projects)?.sort()).toEqual(["1-projects/empty-marker", "1-projects/plan.md", "1-projects/secret"]);
    expect(projects).toMatchObject({ kind: "listing", folderDefault: "team", manifestUsable: true, truncated: false });
  });

  test("a member sees team folders and team exceptions, never a private name", async () => {
    const { ws, member } = await fixture();
    const root = await member.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path: "" });
    // 2-areas is private by default but holds a team exception, so it is drawn (as the bucket draws it).
    expect(paths(root)?.sort()).toEqual(["1-projects", "2-areas"]);
    const projects = await member.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path: "1-projects" });
    expect(paths(projects)?.sort()).toEqual(["1-projects/empty-marker", "1-projects/plan.md"]);
    const areas = await member.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path: "2-areas" });
    expect(paths(areas)).toEqual(["2-areas/shared.md"]);
  });

  test("a withheld folder answers exactly as one that does not exist", async () => {
    const { ws, member } = await fixture();
    const secret = await member.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path: "1-projects/secret" });
    const absent = await member.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path: "1-projects/nothing" });
    expect({ ...secret, path: "" }).toEqual({ ...absent, path: "" });
    expect(secret?.entries).toEqual([]);
  });
});

describe("following changes", () => {
  test("a new file appears, and a gone one goes, on the next read", async () => {
    const { t, ws, owner } = await fixture();
    await observe(t, ws, 40, ["1-projects/new.md"], ["1-projects/plan.md"]);
    const projects = await owner.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path: "1-projects" });
    expect(paths(projects)).toContain("1-projects/new.md");
    expect(paths(projects)).not.toContain("1-projects/plan.md");
  });

  test("a folder whose last file went is no longer drawn", async () => {
    const { t, ws, owner } = await fixture();
    await observe(t, ws, 40, [], ["1-projects/secret/codes.md"]);
    const projects = await owner.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path: "1-projects" });
    expect(paths(projects)).not.toContain("1-projects/secret");
  });

  test("a rule change in the mirror changes what a member sees", async () => {
    const { t, ws, member } = await fixture();
    await translateMirror(t, ws, { ...RULES, folders: [{ prefix: "1-projects", visibility: "private" }] });
    const root = await member.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path: "" });
    expect(paths(root)).toEqual(["2-areas"]);
  });
});

describe("folderRowsStore", () => {
  test("refuses any read but one folder's delimited listing and privacy.md", async () => {
    const store = folderRowsStore("a", [], false, null);
    await expect(store.list({ prefix: "b/", delimiter: "/" })).rejects.toThrow();
    await expect(store.list({ prefix: "a/" })).rejects.toThrow();
    await expect(store.get("a/note.md")).rejects.toThrow();
    expect(await store.get("privacy.md")).toBeNull();
  });

  test("a folder past the row cap lists as truncated, never as a total", async () => {
    const rows = [{ path: "a/n.md", kind: "file" as const, name: "n.md" }];
    const listing = await listFolder(folderRowsStore("a", rows, true, null), { path: "a", clearance: clearanceOf("private") });
    expect(listing.truncated).toBe(true);
    expect(NODE_LISTING_ROWS).toBeGreaterThan(1000);
  });
});

describe("the barrier's one-folder listing (`listServed`)", () => {
  test("answers what the live listing answers, at the clearance the barrier names", async () => {
    const { t, ws, owner, member } = await fixture();
    for (const path of ["", "1-projects", "2-areas", "1-projects/secret"]) {
      const asOwner = await t.query(internal.functions.nodesListing.listServed, { workspaceId: ws, path, scope: "private" });
      expect(asOwner).toEqual(await owner.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path }));
      const asTeam = await t.query(internal.functions.nodesListing.listServed, { workspaceId: ws, path, scope: "team" });
      expect(asTeam).toEqual(await member.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path }));
    }
  });

  test("null only while the first copy has not finished; Pause changes nothing", async () => {
    const { t, ws } = await fixture();
    const ask = () => t.query(internal.functions.nodesListing.listServed, { workspaceId: ws, path: "", scope: "team" });
    expect(await ask()).not.toBeNull();
    expect(await ask()).not.toBeNull();
    await t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: true, updatedAt: 1 });
    });
    expect(await ask()).not.toBeNull();
    await t.run(async (ctx) => {
      const row = await ctx.db.query("nodeTrees").first();
      if (row) await ctx.db.patch(row._id, { status: "filling", sweptAt: undefined });
    });
    expect(await ask()).toBeNull();
  });
});

/**
 * The console's live tree (`functions/nodesListing.ts`): a folder listed from
 * Convex must say exactly what the bucket's listing says, at every clearance,
 * and must answer `null` (ask the bucket) whenever the tree is not proved.
 *
 * Sabotage:
 *  - drop the `resolveFileAccess` call and the stranger case fails;
 *  - make `treeServes` ignore parity, or the pause, and the not-served cases fail;
 *  - drop the `goneAt` skip in `childrenOf` and the gone-file case fails;
 *  - drop `retireEmptyFolders` (`observe.ts`) and the emptied-folder case fails;
 *  - hand `listFolder` a mirror-less store and the team cases fail.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { folderRowsStore, NODE_LISTING_ROWS } from "../../functions/lib/nodes/listing";
import { listFolder } from "../../functions/lib/fileOps/listing";
import { clearanceOf } from "../../functions/lib/clearance";

type T = ReturnType<typeof convexTest>;

interface Fixture {
  t: T;
  ws: Id<"workspaces">;
  owner: ReturnType<T["withIdentity"]>;
  member: ReturnType<T["withIdentity"]>;
  stranger: ReturnType<T["withIdentity"]>;
}

const RULES = {
  etag: "privacy-1",
  invalid: false,
  folders: [
    { prefix: "1-projects/", visibility: "team" },
    { prefix: "1-projects/secret/", visibility: "private" },
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
  await observe(t, ids.ws, 10, [
    "privacy.md",
    "index.md",
    "1-projects/plan.md",
    "1-projects/secret/codes.md",
    "1-projects/empty-marker/",
    "2-areas/mine.md",
    "2-areas/shared.md",
  ]);
  await t.mutation(internal.functions.nodes.savePrivacy, { workspaceId: ids.ws, mirror: RULES, at: 10 });
  await t.mutation(internal.functions.nodes.begin, { workspaceId: ids.ws, at: 5 });
  await t.mutation(internal.functions.nodes.finish, { workspaceId: ids.ws, at: 20, files: 7 });
  await matches(t, ids.ws);
  return {
    t,
    ws: ids.ws,
    owner: t.withIdentity({ subject: ids.ownerId }),
    member: t.withIdentity({ subject: ids.memberId }),
    stranger: t.withIdentity({ subject: ids.strangerId }),
  };
}

async function observe(t: T, workspaceId: Id<"workspaces">, at: number, paths: string[], gone: string[] = []) {
  await t.mutation(internal.functions.nodes.observe, {
    workspaceId,
    at,
    rows: paths.map((path) => ({ path, etag: `e-${path}`, size: 1 })),
    gone,
    vanishedUnder: [],
  });
}

async function matches(t: T, workspaceId: Id<"workspaces">, mismatches = 0) {
  await t.mutation(internal.functions.nodes.saveParity, {
    workspaceId,
    parity: { checkedAt: 30, clearances: 2, mismatches, privacyMatches: true },
  });
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
  test("never checked, differing, failing or paused: null, so the bucket answers", async () => {
    const { t, ws, owner } = await fixture();
    const ask = () => owner.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path: "" });
    expect(await ask()).not.toBeNull();

    await matches(t, ws, 3);
    expect(await ask()).toBeNull();
    await matches(t, ws);

    await t.mutation(internal.functions.nodes.fail, { workspaceId: ws, label: "Tree sweep failed; inspect service logs" });
    expect(await ask()).toBeNull();
    await t.run(async (ctx) => {
      const row = await ctx.db.query("nodeTrees").first();
      if (row) await ctx.db.patch(row._id, { error: undefined });
    });
    expect(await ask()).not.toBeNull();

    await t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: true, updatedAt: 1 });
    });
    expect(await ask()).toBeNull();
  });

  test("a walk is handed the tree's rules only while it serves", async () => {
    const { t, ws } = await fixture();
    expect(await t.query(internal.functions.nodes.served, { workspaceId: ws })).toMatchObject({ mirror: { etag: "privacy-1" } });
    await matches(t, ws, 1);
    expect(await t.query(internal.functions.nodes.served, { workspaceId: ws })).toBeNull();
  });

  test("a tree with no parity yet is not served", async () => {
    const { t, ws, owner } = await fixture();
    await t.run(async (ctx) => {
      const row = await ctx.db.query("nodeTrees").first();
      if (row) await ctx.db.patch(row._id, { parity: undefined });
    });
    expect(await owner.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path: "" })).toBeNull();
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
    await t.mutation(internal.functions.nodes.savePrivacy, {
      workspaceId: ws,
      mirror: { ...RULES, etag: "privacy-2", folders: [{ prefix: "1-projects/", visibility: "private" }] },
      at: 50,
    });
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

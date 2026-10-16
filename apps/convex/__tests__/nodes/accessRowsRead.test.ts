/**
 * Convex readers under `nodeMigration.accessSource` (PR 2 of the privacy-rows
 * plan, `lib/nodes/readerRules.ts`). `file` and unset read the privacy mirror,
 * exactly as before; `shadow` reads the mirror and logs a count of disagreement
 * with the rows; `rows` judges members against the access rows, and names come
 * from grants on those rows, intersected with live membership.
 *
 * Sabotage: in `grantedNames.ts` let rows mode reach the names of a caller who is
 * not a live member (skip the early return) and the "non-member gives nothing"
 * cases fail. Drop the `rows` branch in `readerRules.ts` and the rows-mode
 * listings differ from file mode, failing the equivalence cases.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { grantedNamesFor } from "../../functions/lib/grantedNames";
import { rulesForReaders } from "../../functions/lib/nodes/readerRules";
import { mirrorRules } from "../../functions/lib/nodes/log";
import { readMirror } from "../../functions/lib/nodes/privacyMirror";

const makeTest = () => convexTest(schema, modules);
type T = ReturnType<typeof makeTest>;
type Source = "file" | "shadow" | "rows";

interface Fixture {
  t: T;
  ws: Id<"workspaces">;
  owner: ReturnType<T["withIdentity"]>;
  kola: ReturnType<T["withIdentity"]>;
  bob: ReturnType<T["withIdentity"]>;
  carol: ReturnType<T["withIdentity"]>;
  ids: { owner: Id<"users">; kola: Id<"users">; bob: Id<"users">; carol: Id<"users">; stranger: Id<"users"> };
}

/** The workspace's privacy rules, as the mirror holds them. Trailing-slash-free prefixes, as the parser gives them. */
const RULES = {
  etag: "privacy-1",
  invalid: false,
  folders: [
    { prefix: "1-projects", visibility: "team" },
    { prefix: "1-projects/secret", visibility: "private" },
    { prefix: "2-areas", visibility: "team" },
    { prefix: "2-areas/vault", visibility: "private" },
  ],
  notes: [
    { path: "1-projects/groupnote.md", visibility: "@acme-leads" },
    { path: "1-projects/personnote.md", visibility: "@kola" },
    { path: "1-projects/carolnote.md", visibility: "@carol" },
  ],
};

const TREE = [
  "1-projects/",
  "1-projects/plan.md",
  "1-projects/secret/",
  "1-projects/secret/codes.md",
  "1-projects/groupnote.md",
  "1-projects/personnote.md",
  "1-projects/carolnote.md",
  "2-areas/",
  "2-areas/mine.md",
  "2-areas/vault/",
  "2-areas/vault/vault.md",
];

async function fixture(): Promise<Fixture> {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const user = (email: string) => ctx.db.insert("users", { email, emailVerificationTime: now } as never);
    const owner = await user("owner@example.test");
    const kola = await user("kola@example.test");
    const bob = await user("bob@example.test");
    const carol = await user("carol@example.test");
    const stranger = await user("stranger@example.test");
    const workspace = (slug: string, kind: "shared" | "personal", createdBy: Id<"users">) =>
      ctx.db.insert("workspaces", {
        slug,
        displayName: slug,
        createdBy,
        kind,
        structureTemplate: "para",
        createdAt: now,
        updatedAt: now,
      });
    const ws = await workspace("acme", "shared", owner);
    const kolaWs = await workspace("kola", "personal", kola);
    const carolWs = await workspace("carol", "personal", carol);
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: owner, role: "owner", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: kola, role: "member", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: bob, role: "member", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: kolaWs, userId: kola, role: "owner", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: carolWs, userId: carol, role: "owner", joinedAt: now });
    // `@kola` and `@carol` name people through their personal contexts' slugs (`identities.ts`).
    await ctx.db.insert("names", { name: "kola", kind: "workspace", workspaceId: kolaWs, claimedBy: kola, claimedAt: now });
    await ctx.db.insert("names", { name: "carol", kind: "workspace", workspaceId: carolWs, claimedBy: carol, claimedAt: now });
    const leads = await ctx.db.insert("workspaceGroups", { workspaceId: ws, name: "acme-leads", createdBy: owner, createdAt: now });
    await ctx.db.insert("names", { name: "acme-leads", kind: "group", groupId: leads, claimedBy: owner, claimedAt: now });
    // Kola is a live member of the group; bob is not.
    await ctx.db.insert("workspaceGroupMembers", { groupId: leads, workspaceId: ws, userId: kola, addedBy: owner, addedAt: now });
    return { ws, owner, kola, bob, carol, stranger };
  });
  await t.mutation(internal.functions.nodes.observe, {
    workspaceId: ids.ws,
    at: 10,
    rows: TREE.map((path) => ({ path, etag: `e-${path}`, size: 1 })),
    gone: [],
    vanishedUnder: [],
  });
  await t.mutation(internal.functions.nodes.savePrivacy, { workspaceId: ids.ws, mirror: RULES, at: 10 });
  await t.mutation(internal.functions.nodes.begin, { workspaceId: ids.ws, at: 5 });
  await t.mutation(internal.functions.nodes.finish, { workspaceId: ids.ws, at: 20, files: TREE.length });
  return {
    t,
    ws: ids.ws,
    ids,
    owner: t.withIdentity({ subject: ids.owner }),
    kola: t.withIdentity({ subject: ids.kola }),
    bob: t.withIdentity({ subject: ids.bob }),
    carol: t.withIdentity({ subject: ids.carol }),
  };
}

async function setSource(f: Fixture, source: Source): Promise<void> {
  await f.t.mutation(internal.functions.nodesPrivacy.setAccessSource, { workspaceId: f.ws, source });
}

/** Rules as plain values: a query or mutation result cannot carry a `Map`. */
function plain(rules: { rules: readonly { prefix: string; vis: string }[]; overrides: ReadonlyMap<string, string> }) {
  return {
    rules: rules.rules.map((rule) => ({ prefix: rule.prefix, vis: rule.vis })),
    overrides: [...rules.overrides].map(([path, vis]) => [path, vis]),
  };
}

/** A listed entry's name, not its path: the listing answers full paths. */
const nameOf = (entry: { path: string }) => entry.path.slice(entry.path.lastIndexOf("/") + 1);

const FOLDERS = ["", "1-projects", "1-projects/secret", "2-areas", "2-areas/vault"];

/** Every folder's listing names, as one caller sees them. */
async function listingsOf(f: Fixture, who: "owner" | "kola" | "bob"): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const folder of FOLDERS) {
    const listing = await f[who].query(api.functions.nodesListing.listFolder, { workspaceId: f.ws, path: folder });
    out[folder] = (listing?.entries.map(nameOf) ?? []).sort();
  }
  return out;
}

/** The names a non-console grant holds: none, as `liveGrants` gives an agent grant. */
async function listingWithoutNames(f: Fixture, folder: string): Promise<string[]> {
  const listing = await f.t.query(internal.functions.nodesListing.listServed, {
    workspaceId: f.ws,
    path: folder,
    scope: "team",
  });
  return (listing?.entries.map(nameOf) ?? []).sort();
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

describe("file mode (unset and file) reads the privacy mirror, unchanged", () => {
  test("readers get the mirror's rules byte-for-byte", async () => {
    const f = await fixture();
    const direct = await f.t.run(async (ctx) => plain(await mirrorRules(await readMirror(ctx.db, f.ws))));
    const readers = await f.t.run(async (ctx) => plain(await rulesForReaders(ctx as unknown as QueryCtx, f.ws)));
    expect(JSON.stringify(readers)).toBe(JSON.stringify(direct));
    expect(readers.rules.map((rule) => `${rule.prefix}=${rule.vis}`)).toEqual([
      "1-projects=team",
      "1-projects/secret=private",
      "2-areas=team",
      "2-areas/vault=private",
    ]);
    expect(readers.overrides).toEqual([
      ["1-projects/carolnote.md", "@carol"],
      ["1-projects/groupnote.md", "@acme-leads"],
      ["1-projects/personnote.md", "@kola"],
    ]);
  });

  test("the listing answers as the mirror says when the switch is unset", async () => {
    const f = await fixture();
    expect(await listingsOf(f, "bob")).toEqual({
      "": ["1-projects", "2-areas"],
      "1-projects": ["plan.md"],
      "1-projects/secret": [],
      "2-areas": ["mine.md"],
      "2-areas/vault": [],
    });
  });
});

describe("shadow reads the mirror and logs disagreement by count", () => {
  test("agreement logs nothing; a row that disagrees logs one line with a count and no paths", async () => {
    const f = await fixture();
    await setSource(f, "shadow");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const agreed = await f.t.run(async (ctx) => plain(await rulesForReaders(ctx as unknown as QueryCtx, f.ws)));
    expect(agreed.rules.map((rule) => rule.prefix)).toEqual(["1-projects", "1-projects/secret", "2-areas", "2-areas/vault"]);
    expect(log).not.toHaveBeenCalled();

    // Make one folder's row disagree with the rule that says team.
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws).eq("path", "1-projects"))
        .unique();
      if (row === null || row.access === undefined) throw new Error("no derived row");
      await ctx.db.patch(row._id, { access: { base: "private" } });
    });
    await f.t.run(async (ctx) => plain(await rulesForReaders(ctx as unknown as QueryCtx, f.ws)));
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(JSON.parse(line)).toEqual({ event: "access.shadow_diff", workspaceId: f.ws, count: 2 });
    expect(line).not.toContain("1-projects");
  });
});

describe("rows mode judges members by the access rows", () => {
  test("every folder answers as file mode does, for each member", async () => {
    const f = await fixture();
    const before = {
      owner: await listingsOf(f, "owner"),
      kola: await listingsOf(f, "kola"),
      bob: await listingsOf(f, "bob"),
    };
    await setSource(f, "rows");
    expect(await listingsOf(f, "owner")).toEqual(before.owner);
    expect(await listingsOf(f, "kola")).toEqual(before.kola);
    expect(await listingsOf(f, "bob")).toEqual(before.bob);
  });

  test("a group-listed note shows to its member and not to bob; a person-listed note shows to the person only", async () => {
    const f = await fixture();
    await setSource(f, "rows");
    expect(await listingsOf(f, "kola")).toMatchObject({ "1-projects": ["groupnote.md", "personnote.md", "plan.md"] });
    expect(await listingsOf(f, "bob")).toMatchObject({ "1-projects": ["plan.md"] });
  });

  test("a person named who is not a member gets nothing, even though the rows name them", async () => {
    const f = await fixture();
    await setSource(f, "rows");
    // Carol holds a person grant on carolnote.md, but she is not a member of this workspace.
    await expect(f.carol.query(api.functions.nodesListing.listFolder, { workspaceId: f.ws, path: "1-projects" })).rejects.toThrow();
    expect(await f.t.run(async (ctx) => await grantedNamesFor(ctx as unknown as QueryCtx, f.ws, f.ids.carol))).toEqual([]);
  });

  test("a group-listed note is invisible to a caller with no names (a non-console grant)", async () => {
    const f = await fixture();
    await setSource(f, "rows");
    expect(await listingWithoutNames(f, "1-projects")).toEqual(["plan.md"]);
  });

  test("names: a live member holds the token of each note listed to her, and no others", async () => {
    const f = await fixture();
    await setSource(f, "rows");
    const names = await f.t.run(async (ctx) => await grantedNamesFor(ctx as unknown as QueryCtx, f.ws, f.ids.kola));
    const groupToken = `#${await noteIdOf(f, "1-projects/groupnote.md")}`;
    const personToken = `#${await noteIdOf(f, "1-projects/personnote.md")}`;
    expect(names).toEqual(expect.arrayContaining(["acme-leads", groupToken, personToken]));
    expect(names).not.toContain(`#${await noteIdOf(f, "1-projects/carolnote.md")}`);
    const bob = await f.t.run(async (ctx) => await grantedNamesFor(ctx as unknown as QueryCtx, f.ws, f.ids.bob));
    expect(bob).toEqual([]);
  });

  test("rows mode reads the rows, not the file: a row changed on its own changes what members see", async () => {
    const f = await fixture();
    await setSource(f, "rows");
    // The file still lists groupnote.md to @acme-leads; the row now says team. Rows win in rows mode.
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws).eq("path", "1-projects/groupnote.md"))
        .unique();
      if (row === null) throw new Error("no row");
      await ctx.db.patch(row._id, { access: { base: "team" } });
    });
    expect(await listingsOf(f, "bob")).toMatchObject({ "1-projects": ["groupnote.md", "plan.md"] });
    await setSource(f, "file");
    expect(await listingsOf(f, "bob")).toMatchObject({ "1-projects": ["plan.md"] });
  });

  test("a note created later under a ruled folder inherits its folder's answer, with no row of its own", async () => {
    const f = await fixture();
    await setSource(f, "rows");
    await f.t.mutation(internal.functions.nodes.observe, {
      workspaceId: f.ws,
      at: 30,
      rows: [
        { path: "1-projects/new.md", etag: "e-new", size: 1 },
        { path: "1-projects/secret/new.md", etag: "e-new2", size: 1 },
      ],
      gone: [],
      vanishedUnder: [],
    });
    expect(await listingsOf(f, "bob")).toMatchObject({
      "1-projects": ["new.md", "plan.md"],
      "1-projects/secret": [],
    });
    const created = await f.t.run(async (ctx) =>
      await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws).eq("path", "1-projects/new.md"))
        .unique(),
    );
    expect(created?.access).toBeUndefined();
  });
});

describe("the source switch is read at each read, not cached", () => {
  test("switching back to file returns the mirror's answer", async () => {
    const f = await fixture();
    await setSource(f, "rows");
    expect(await listingsOf(f, "kola")).toMatchObject({ "1-projects": ["groupnote.md", "personnote.md", "plan.md"] });
    await setSource(f, "file");
    const source = (await f.t.run(async (ctx) => await ctx.db.query("nodeMigration").first()))?.accessSource;
    expect(source).toBe("file");
    expect(await listingsOf(f, "kola")).toMatchObject({ "1-projects": ["groupnote.md", "personnote.md", "plan.md"] });
  });
});

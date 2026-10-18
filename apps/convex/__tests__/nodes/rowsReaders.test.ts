/**
 * Every Convex reader judges a member by the access rows in rows mode, never
 * by the `nodePrivacy` mirror (the `privacy.md` the rules were last written
 * to). A note set private on its row must be gone for a member from every
 * reader at once: the note list, a folder listing, the visible-paths and graph
 * reads, the whole-tree walk, the share-link check, and the mirror the served
 * store is built on. In file mode every one of them answers as before.
 *
 * Sabotage: make `readerMirror` return `readMirror` again and the rows-mode
 * member cases fail (the mirror still says `1-projects` is team, so
 * `1-projects/plan.md` shows); remove the `PRE_PARSED_RULES` branch in
 * `loadPrivacyState` and the token-rules case fails.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { readerMirror } from "../../functions/lib/nodes/readerRules";
import { readMirror } from "../../functions/lib/nodes/privacyMirror";
import { shareableRules } from "../../functions/lib/shares/inboxTitle";
import { mirrorFile } from "../../functions/lib/nodes/privacyMirror";
import { loadPrivacyState } from "../../functions/lib/fileOps/privacyState";
import { PRE_PARSED_RULES } from "../../../mcp/src/privacy/engine.js";
import { clearanceOf } from "../../functions/lib/clearance";
import { type FileStore, resetPrivacyManifest, syncManifest } from "../../functions/lib/fileOps";
import { recordActivity } from "../../functions/lib/activity";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { memoryStore } from "../storeStub.helpers";

const makeTest = () => convexTest(schema, modules);
type T = ReturnType<typeof makeTest>;

interface Fixture {
  t: T;
  ws: Id<"workspaces">;
  owner: ReturnType<T["withIdentity"]>;
  bob: ReturnType<T["withIdentity"]>;
  ids: { owner: Id<"users">; bob: Id<"users"> };
}

/** The mirror as it was last written to `privacy.md`: `1-projects` is team, and the rows do not yet hold back `plan.md`. */
const RULES = {
  etag: "privacy-1",
  invalid: false,
  folders: [
    { prefix: "1-projects", visibility: "team" },
    { prefix: "1-projects/secret", visibility: "private" },
    { prefix: "2-areas", visibility: "team" },
  ],
  notes: [
    { path: "1-projects/groupnote.md", visibility: "@acme-leads" },
    { path: "1-projects/personnote.md", visibility: "@kola" },
  ],
};

const TREE = [
  "1-projects/",
  "1-projects/plan.md",
  "1-projects/secret/",
  "1-projects/secret/codes.md",
  "1-projects/groupnote.md",
  "1-projects/personnote.md",
  "2-areas/",
  "2-areas/mine.md",
];

async function fixture(): Promise<Fixture> {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const user = (email: string) => ctx.db.insert("users", { email, emailVerificationTime: now } as never);
    const owner = await user("owner@example.test");
    const kola = await user("kola@example.test");
    const bob = await user("bob@example.test");
    const ws = await ctx.db.insert("workspaces", {
      slug: "acme",
      displayName: "acme",
      createdBy: owner,
      kind: "shared",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
    const kolaWs = await ctx.db.insert("workspaces", {
      slug: "kola",
      displayName: "kola",
      createdBy: kola,
      kind: "personal",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: owner, role: "owner", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: kola, role: "member", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: bob, role: "member", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: kolaWs, userId: kola, role: "owner", joinedAt: now });
    await ctx.db.insert("names", { name: "kola", kind: "workspace", workspaceId: kolaWs, claimedBy: kola, claimedAt: now });
    const leads = await ctx.db.insert("workspaceGroups", { workspaceId: ws, name: "acme-leads", createdBy: owner, createdAt: now });
    await ctx.db.insert("names", { name: "acme-leads", kind: "group", groupId: leads, claimedBy: owner, claimedAt: now });
    return { ws, owner, bob };
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
    ids: { owner: ids.owner, bob: ids.bob },
    owner: t.withIdentity({ subject: ids.owner }),
    bob: t.withIdentity({ subject: ids.bob }),
  };
}

/** Rows mode on, with `plan.md` set private on its row only: the mirror still lists it as team. */
async function rowsWithPlanPrivate(): Promise<Fixture> {
  const f = await fixture();
  await f.t.mutation(internal.functions.nodesPrivacy.setAccessSource, { workspaceId: f.ws, source: "rows" });
  await f.t.mutation(internal.functions.nodesAccess.setAccess, {
    workspaceId: f.ws,
    path: "1-projects/plan.md",
    base: "private",
    actor: { userId: f.ids.owner, role: "owner" },
  });
  return f;
}

/** A tree read as the member, with no names: what a team member's own console asks. */
async function treeRead(f: Fixture, scope: "team" | "private", operation: Record<string, unknown>) {
  return await f.t.action(internal.functions.files.runFileOperation, {
    workspaceId: f.ws,
    scope,
    operation: operation as never,
  });
}

function flat(answer: { paths?: string[] | null; pathChunks?: string[][] }): string[] {
  return answer.pathChunks !== undefined ? answer.pathChunks.flat() : (answer.paths ?? []);
}

describe("rows mode: a member's readers judge by the rows", () => {
  test("the note list does not name a note the rows hold back", async () => {
    const f = await rowsWithPlanPrivate();
    const listed = await f.bob.action(api.functions.files.notePaths, { workspaceId: f.ws });
    expect(flat(listed)).not.toContain("1-projects/plan.md");
    expect(flat(listed)).toContain("2-areas/mine.md");
  });

  test("a folder listing does not show it to a member, and shows it to the owner", async () => {
    const f = await rowsWithPlanPrivate();
    const member = await f.bob.query(api.functions.nodesListing.listFolder, { workspaceId: f.ws, path: "1-projects" });
    expect((member?.entries ?? []).map((entry) => entry.path)).not.toContain("1-projects/plan.md");
    const owner = await f.owner.query(api.functions.nodesListing.listFolder, { workspaceId: f.ws, path: "1-projects" });
    expect((owner?.entries ?? []).map((entry) => entry.path)).toContain("1-projects/plan.md");
  });

  test("the whole-tree walk and the visible-paths read leave it out for a member", async () => {
    const f = await rowsWithPlanPrivate();
    const walk = (await treeRead(f, "team", { kind: "manifest", source: "tree" })) as { entries: { path: string }[] };
    expect(walk.entries.map((entry) => entry.path)).not.toContain("1-projects/plan.md");
    const visible = (await treeRead(f, "team", {
      kind: "visiblePaths",
      paths: ["1-projects/plan.md", "2-areas/mine.md"],
    })) as { paths: string[] };
    expect(visible.paths).toEqual(["2-areas/mine.md"]);
  });

  test("the graph of the workspace does not draw it for a member", async () => {
    const f = await rowsWithPlanPrivate();
    const graph = (await treeRead(f, "team", { kind: "workspaceGraph" })) as { nodes: { path: string }[] };
    expect(graph.nodes.map((node) => node.path)).not.toContain("1-projects/plan.md");
  });

  test("a share link's courtesy check reads the rows: the note is not visible at team", async () => {
    const f = await rowsWithPlanPrivate();
    const check = await f.t.query(internal.functions.nodes.teamShareable, { workspaceId: f.ws, path: "1-projects/plan.md" });
    expect(check?.visible).toBe(false);
  });

  test("the served mirror is the rows' judgement, and says so in its etag", async () => {
    const f = await rowsWithPlanPrivate();
    const served = await f.t.query(internal.functions.nodes.served, { workspaceId: f.ws });
    expect(served?.mirror?.rows).toBe(true);
    expect(served?.mirror?.etag?.startsWith("rows:")).toBe(true);
    expect(served?.mirror?.notes).toContainEqual({ path: "1-projects/plan.md", visibility: "private" });
  });
});

describe("the remaining readers: facts, feed and inbox titles", () => {
  test("the facts' visible-notes check leaves a row-private note out for a member", async () => {
    const f = await rowsWithPlanPrivate();
    const visible = await f.t.query(internal.functions.nodeFacts.visibleNotes, {
      workspaceId: f.ws,
      paths: ["1-projects/plan.md", "2-areas/mine.md"],
      scope: "team",
      names: [],
    });
    expect(JSON.stringify(visible)).not.toContain("1-projects/plan.md");
    expect(JSON.stringify(visible)).toContain("2-areas/mine.md");
  });

  test("the feed's rules version moves when a row's access does, so a reader is never told the old rules", async () => {
    const f = await rowsWithPlanPrivate();
    const before = await f.t.query(internal.functions.nodesFeed.walkStart, { workspaceId: f.ws, now: Date.now() });
    await f.t.mutation(internal.functions.nodesAccess.setAccess, {
      workspaceId: f.ws,
      path: "2-areas/mine.md",
      base: "private",
      actor: { userId: f.ids.owner, role: "owner" },
    });
    const after = await f.t.query(internal.functions.nodesFeed.walkStart, { workspaceId: f.ws, now: Date.now() });
    expect(before?.privacy).toBeTruthy();
    expect(after?.privacy).not.toBe(before?.privacy);
  });

  test("a shared note's title is judged by the rows' rules, which hold the row-private note back", async () => {
    const f = await rowsWithPlanPrivate();
    const held = await f.t.run(async (ctx) => {
      const rules = await shareableRules(ctx, f.ws);
      return rules === null ? null : [...rules.overrides.entries()];
    });
    expect(held).toContainEqual(["1-projects/plan.md", "private"]);
  });
});

describe("readerMirror", () => {
  test("file mode: it is the mirror, unchanged", async () => {
    const f = await fixture();
    const reader = await f.t.run(async (ctx) => await readerMirror(ctx, f.ws));
    const mirror = await f.t.run(async (ctx) => await readMirror(ctx.db, f.ws));
    expect(reader).toEqual(mirror);
    expect(reader?.rows).toBeUndefined();
  });

  test("rows mode: the rows' rules, with a rows etag that changes when a row does", async () => {
    const f = await rowsWithPlanPrivate();
    const reader = await f.t.run(async (ctx) => await readerMirror(ctx, f.ws));
    expect(reader?.rows).toBe(true);
    expect(reader?.etag?.startsWith("rows:")).toBe(true);
    expect(reader?.notes).toContainEqual({ path: "1-projects/plan.md", visibility: "private" });
    const before = reader?.etag;
    await f.t.mutation(internal.functions.nodesAccess.setAccess, {
      workspaceId: f.ws,
      path: "2-areas/mine.md",
      base: "private",
      actor: { userId: f.ids.owner, role: "owner" },
    });
    const after = await f.t.run(async (ctx) => await readerMirror(ctx, f.ws));
    expect(after?.etag).not.toBe(before);
  });
});

describe("the privacy engine reads rows the mirror's way", () => {
  test("rules that name a row token load from the rows, not from file text", async () => {
    const pre = {
      rules: [{ prefix: "1-projects", vis: "team" }],
      overrides: new Map([["1-projects/x.md", "@#0190-abc"]]),
    };
    const store = {
      get: async () => ({
        etag: "rows:1",
        text: async () => "# not a manifest\n",
        arrayBuffer: async () => new ArrayBuffer(0),
        [PRE_PARSED_RULES]: pre,
      }),
    };
    const state = await loadPrivacyState(store as never);
    expect(state.invalid).toBe(false);
    expect(state.overrides.get("1-projects/x.md")).toBe("@#0190-abc");
  });

  test("a rows mirror renders into an object that carries its rules", async () => {
    const object = mirrorFile({
      etag: "rows:1",
      invalid: false,
      rows: true,
      folders: [{ prefix: "1-projects", visibility: "team" }],
      notes: [{ path: "1-projects/x.md", visibility: "@#0190-abc" }],
    });
    const state = await loadPrivacyState({ get: async () => object } as never);
    expect(state.overrides.get("1-projects/x.md")).toBe("@#0190-abc");
    expect(state.rules).toEqual([{ prefix: "1-projects", vis: "team" }]);
  });
});

/** A store whose `privacy.md` is the rows' view, as every tree-served store answers it in rows mode. */
function rowsServedStore(): FileStore {
  const store = memoryStore() as unknown as FileStore & { seed: (key: string, text: string) => void };
  store.seed("1-projects/plan.md", "# Plan\n");
  store.seed("3-resources/book.md", "# Book\n");
  const object = mirrorFile({
    etag: "rows:1",
    invalid: false,
    rows: true,
    folders: [{ prefix: "1-projects", visibility: "team" }],
    notes: [],
  });
  const get = store.get.bind(store);
  store.get = (async (key: string, ...rest: unknown[]) =>
    key === PRIVACY_KEY ? object : await (get as (...args: unknown[]) => unknown)(key, ...rest)) as FileStore["get"];
  return store;
}

describe("the rows' rules are a usable manifest", () => {
  test("a walk says the manifest is usable, so no 'privacy.md could not be read' banner", async () => {
    const manifest = await syncManifest(rowsServedStore(), { clearance: clearanceOf("private") });
    expect(manifest.manifestUsable).toBe(true);
    expect(manifest.entries.map((entry) => entry.path)).toContain("1-projects/plan.md");
  });

  test("Reset privacy.md is refused: the rules are readable, nothing is broken", async () => {
    const store = rowsServedStore();
    const put = store.put;
    let wrote = false;
    store.put = (async (...args: Parameters<FileStore["put"]>) => {
      wrote = true;
      return await put(...args);
    }) as FileStore["put"];
    await expect(resetPrivacyManifest(store, { clearance: clearanceOf("private"), now: 1 })).rejects.toMatchObject({
      code: "PRIVACY_MANIFEST_USABLE",
    });
    expect(wrote).toBe(false);
  });

  test("activity is still recorded under the rows' rules", async () => {
    const landed = await recordActivity(rowsServedStore(), {
      action: "update_note",
      paths: ["1-projects/plan.md"],
      details: {},
      actor: null,
      teamVisible: true,
    });
    expect(landed).not.toBeNull();
  });
});

describe("writers stand down in rows mode", () => {
  test("a mirror refresh read from the file is not stored in rows mode", async () => {
    const f = await rowsWithPlanPrivate();
    await f.t.mutation(internal.functions.nodes.savePrivacy, {
      workspaceId: f.ws,
      mirror: { ...RULES, etag: "privacy-2", folders: [] },
      at: 30,
    });
    const held = await f.t.query(internal.functions.nodes.privacy, { workspaceId: f.ws });
    expect(held?.etag).toBe("privacy-1");
  });

  test("file mode still stores the refresh it is given", async () => {
    const f = await fixture();
    await f.t.mutation(internal.functions.nodes.savePrivacy, {
      workspaceId: f.ws,
      mirror: { ...RULES, etag: "privacy-2" },
      at: 30,
    });
    const held = await f.t.query(internal.functions.nodes.privacy, { workspaceId: f.ws });
    expect(held?.etag).toBe("privacy-2");
  });
});

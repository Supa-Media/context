/**
 * "Download as folders" in rows mode (`lib/filesFns/exportAccess.ts`): the
 * archive carries an `access.md` made from the rows, never a `privacy.md`, and
 * a note the rows hold back from a member is absent from it even where the
 * privacy mirror still says team. In file mode the answer is the old one, with
 * nothing added.
 *
 * Sabotage: drop the `visible` filter on `notes` and the member cases list
 * `1-projects/plan.md`; drop the `accessSource` gate and file mode answers
 * `rows`; let a member's `names` through and the member's `access.md` names
 * `acme-leads`.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../../_generated/api";
// The public action lives in its own module (`functions/exportAccess.ts`).
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";

const makeTest = () => convexTest(schema, modules);
type T = ReturnType<typeof makeTest>;

interface Fixture {
  t: T;
  ws: Id<"workspaces">;
  owner: ReturnType<T["withIdentity"]>;
  bob: ReturnType<T["withIdentity"]>;
  ids: { owner: Id<"users">; bob: Id<"users"> };
}

/** The workspace's privacy rules, as the mirror holds them (the rows are derived from these). */
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
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: owner, role: "owner", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: kola, role: "member", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: bob, role: "member", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: kolaWs, userId: kola, role: "owner", joinedAt: now });
    // `@kola` names a person through her personal context's slug (`identities.ts`).
    await ctx.db.insert("names", { name: "kola", kind: "workspace", workspaceId: kolaWs, claimedBy: kola, claimedAt: now });
    const leads = await ctx.db.insert("workspaceGroups", { workspaceId: ws, name: "acme-leads", createdBy: owner, createdAt: now });
    await ctx.db.insert("names", { name: "acme-leads", kind: "group", groupId: leads, claimedBy: owner, claimedAt: now });
    await ctx.db.insert("workspaceGroupMembers", { groupId: leads, workspaceId: ws, userId: kola, addedBy: owner, addedAt: now });
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

async function setSource(f: Fixture, source: "file" | "rows"): Promise<void> {
  await f.t.mutation(internal.functions.nodesPrivacy.setAccessSource, { workspaceId: f.ws, source });
}

/** An archive's answer, as one list of note paths. */
function pathsOf(answer: { mode: string; chunks?: string[][] | null }): string[] {
  return ((answer.chunks ?? []) as string[][]).flat();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("file mode: the archive is made as it was before rows", () => {
  test("the answer names no rows, so nothing is added to the archive", async () => {
    const f = await fixture();
    const answer = await f.owner.action(api.functions.exportAccess.exportAccess, { workspaceId: f.ws, folder: "" });
    expect(answer).toEqual({ mode: "file" });
  });
});

describe("rows mode: access.md from the rows, and never privacy.md", () => {
  test("the owner's access.md names each row with its own setting, and the archive has no privacy.md", async () => {
    const f = await fixture();
    await setSource(f, "rows");
    const answer = await f.owner.action(api.functions.exportAccess.exportAccess, { workspaceId: f.ws, folder: "" });
    expect(answer.mode).toBe("rows");
    if (answer.mode !== "rows") throw new Error("rows");
    expect(answer.access.startsWith("# Access\n")).toBe(true);
    expect(answer.access).toContain("- 1-projects/secret/ — private\n");
    expect(answer.access).toContain("- 1-projects/groupnote.md — private, plus group acme-leads (view)\n");
    expect(answer.access).toContain("- 1-projects/personnote.md — private, plus @kola (view)\n");
    expect(answer.access).not.toContain("privacy.md");
    expect(pathsOf(answer)).not.toContain("privacy.md");
    expect(pathsOf(answer)).toContain("1-projects/plan.md");
  });
});

describe("rows mode: a member's archive is judged by the rows, not by a stale mirror", () => {
  test("a note the rows hold back is absent, though the mirror still lists it", async () => {
    const f = await fixture();
    await setSource(f, "rows");
    await f.t.mutation(internal.functions.nodesAccess.setAccess, {
      workspaceId: f.ws,
      path: "1-projects/plan.md",
      base: "private",
      actor: { userId: f.ids.owner, role: "owner" },
    });
    // The premise: the tree's own list (`notePaths`) still names the note, because the mirror does.
    const listed = await f.bob.action(api.functions.files.notePaths, { workspaceId: f.ws });
    expect(listed.paths ?? []).toContain("1-projects/plan.md");
    const answer = await f.bob.action(api.functions.exportAccess.exportAccess, { workspaceId: f.ws, folder: "" });
    expect(answer.mode).toBe("rows");
    expect(pathsOf(answer)).not.toContain("1-projects/plan.md");
    expect(pathsOf(answer)).toContain("2-areas/mine.md");
  });

  test("a member is told how many grants a row has, never who was granted", async () => {
    const f = await fixture();
    await setSource(f, "rows");
    // A note bob can see (team), with one named grant on it.
    await f.t.mutation(internal.functions.nodesAccess.setAccess, {
      workspaceId: f.ws,
      path: "2-areas/mine.md",
      base: "team",
      grantees: [{ kind: "email", email: "carol@example.test", role: "view" }],
      actor: { userId: f.ids.owner, role: "owner" },
    });
    const answer = await f.bob.action(api.functions.exportAccess.exportAccess, { workspaceId: f.ws, folder: "" });
    if (answer.mode !== "rows") throw new Error("rows");
    expect(answer.access).toContain("- 2-areas/mine.md — team, plus 1 named person or group\n");
    expect(answer.access).not.toContain("carol");
    expect(answer.access).not.toContain("example.test");
    // A note bob cannot see is not in his list at all, grants and all.
    expect(answer.access).not.toContain("groupnote");
    expect(answer.access).not.toContain("acme-leads");
  });

  test("the owner is told the names", async () => {
    const f = await fixture();
    await setSource(f, "rows");
    await f.t.mutation(internal.functions.nodesAccess.setAccess, {
      workspaceId: f.ws,
      path: "2-areas/mine.md",
      base: "team",
      grantees: [{ kind: "email", email: "carol@example.test", role: "view" }],
      actor: { userId: f.ids.owner, role: "owner" },
    });
    const answer = await f.owner.action(api.functions.exportAccess.exportAccess, { workspaceId: f.ws, folder: "" });
    if (answer.mode !== "rows") throw new Error("rows");
    expect(answer.access).toContain("- 2-areas/mine.md — team, plus carol@example.test (view)\n");
  });

  test("a folder's archive carries that folder's notes and rows, and no other", async () => {
    const f = await fixture();
    await setSource(f, "rows");
    const answer = await f.bob.action(api.functions.exportAccess.exportAccess, { workspaceId: f.ws, folder: "1-projects" });
    if (answer.mode !== "rows") throw new Error("rows");
    for (const path of pathsOf(answer)) expect(path.startsWith("1-projects/")).toBe(true);
    for (const line of answer.access.split("\n").filter((text: string) => text.startsWith("- "))) {
      expect(line.startsWith("- 1-projects")).toBe(true);
    }
    // A member sees the team folder's notes, and not the private folder beneath it.
    expect(pathsOf(answer)).not.toContain("1-projects/secret/codes.md");
  });
});

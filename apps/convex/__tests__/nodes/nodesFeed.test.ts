/**
 * The device feed from the tree (`functions/nodesFeed.ts`, `lib/nodes/log.ts`):
 * the change log is written as the tree changes, a device catches up from it,
 * and nobody learns from it what they could not see.
 *
 * Sabotage:
 *  - drop the `changed` test in `applyRow` (`observe.ts`) and the re-sweep case logs;
 *  - drop the `audiences` check in `toldOf` and the deleted-private-note case fails;
 *  - report `canSee`-hidden present rows and the member catch-up case fails;
 *  - hand back the last scanned `seq` to a team reader and the cursor case fails;
 *  - drop `resolveFileAccess` from `head` and the stranger case fails;
 *  - drop the rules-version comparison and the rules-changed case fails;
 *  - drop the log purge (`nodesPurge.ts`) and the forget case fails.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { seqAt } from "../../functions/lib/nodes/log";

type T = ReturnType<typeof convexTest>;

const RULES = {
  etag: "privacy-1",
  invalid: false,
  folders: [
    { prefix: "1-projects/", visibility: "team" },
    { prefix: "1-projects/secret/", visibility: "private" },
  ],
  notes: [{ path: "2-areas/shared.md", visibility: "team" }],
};
const TOKEN = "nodes:privacy-1";

async function fixture() {
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
  await t.mutation(internal.functions.nodes.savePrivacy, { workspaceId: ids.ws, mirror: RULES, at: 1 });
  await observe(t, ids.ws, 10, ["privacy.md", "1-projects/plan.md", "1-projects/secret/codes.md", "2-areas/mine.md", "2-areas/shared.md"]);
  await t.mutation(internal.functions.nodes.begin, { workspaceId: ids.ws, at: 5 });
  await t.mutation(internal.functions.nodes.finish, { workspaceId: ids.ws, at: 20, files: 5 });
  await t.mutation(internal.functions.nodes.saveParity, {
    workspaceId: ids.ws,
    parity: { checkedAt: 30, clearances: 2, mismatches: 0, privacyMatches: true },
  });
  return { t, ...ids, owner: t.withIdentity({ subject: ids.ownerId }), member: t.withIdentity({ subject: ids.memberId }), stranger: t.withIdentity({ subject: ids.strangerId }) };
}

async function observe(t: T, workspaceId: Id<"workspaces">, at: number, paths: string[], gone: string[] = [], etag = "e") {
  await t.mutation(internal.functions.nodes.observe, {
    workspaceId,
    at,
    rows: paths.map((path) => ({ path, etag: `${etag}-${path}`, size: 1 })),
    gone,
    vanishedUnder: [],
  });
}

async function logRows(t: T) {
  return await t.run(async (ctx) => await ctx.db.query("nodeLog").collect());
}

/** A catch-up as the action asks it, from an hour ago, with the clock held well behind the rows. */
async function catchUp(
  t: T,
  ws: Id<"workspaces">,
  actorUserId: Id<"users">,
  options: { since?: number; privacy?: string; now?: number; limit?: number } = {},
) {
  const now = options.now ?? Date.now() - 10 * 60_000;
  return await t.query(internal.functions.nodesFeed.changes, {
    actorUserId,
    workspaceId: ws,
    since: options.since ?? seqAt(Date.now() - 60 * 60_000),
    privacy: options.privacy ?? TOKEN,
    now,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
}

describe("writing the log", () => {
  test("every new file, new version and departure is one row; re-seeing a file is none", async () => {
    const { t, ws } = await fixture();
    expect((await logRows(t)).map((row) => [row.path, row.gone]).sort()).toEqual(
      [
        ["1-projects/plan.md", false],
        ["1-projects/secret/codes.md", false],
        ["2-areas/mine.md", false],
        ["2-areas/shared.md", false],
        ["privacy.md", false],
      ].sort(),
    );
    await observe(t, ws, 40, ["1-projects/plan.md"]);
    expect(await logRows(t)).toHaveLength(5);
    await observe(t, ws, 50, ["1-projects/plan.md"], [], "v2");
    await observe(t, ws, 60, [], ["2-areas/mine.md"]);
    const rows = await logRows(t);
    expect(rows.slice(5).map((row) => [row.path, row.gone])).toEqual([
      ["1-projects/plan.md", false],
      ["2-areas/mine.md", true],
    ]);
  });

  test("seq rises in commit order and never falls below the clock", async () => {
    const { t, ws } = await fixture();
    const before = seqAt(Date.now());
    await observe(t, ws, 40, ["a.md", "b.md"]);
    const seqs = (await logRows(t)).map((row) => row.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[seqs.length - 1]).toBeGreaterThanOrEqual(before);
  });

  test("a departure records who could see it then, by the rules as they stood", async () => {
    const { t, ws } = await fixture();
    await observe(t, ws, 40, [], ["2-areas/mine.md", "2-areas/shared.md", "1-projects/plan.md"]);
    const gone = (await logRows(t)).filter((row) => row.gone);
    const audiences = Object.fromEntries(gone.map((row) => [row.path, row.audiences]));
    expect(audiences["2-areas/mine.md"]).toEqual(["private"]);
    expect(audiences["2-areas/shared.md"]).toEqual(["private", "team"]);
    expect(audiences["1-projects/plan.md"]).toEqual(["private", "team"]);
  });

  test("forgetting the tree forgets its log", async () => {
    const { t, ws } = await fixture();
    await t.mutation(internal.functions.nodesPurge.resetForStorage, { workspaceId: ws });
    expect(await logRows(t)).toEqual([]);
  });
});

describe("catching up", () => {
  test("a member hears of team changes and never of a private one", async () => {
    const { t, ws, memberId } = await fixture();
    const result = await catchUp(t, ws, memberId);
    expect(result?.full).toBe(false);
    expect(result?.entries.map((entry) => entry.path).sort()).toEqual(["1-projects/plan.md", "2-areas/shared.md"]);
    expect(result?.folders.map((folder) => folder.path).sort()).toEqual(["1-projects", "2-areas"]);
  });

  test("the owner hears of everything", async () => {
    const { t, ws, ownerId } = await fixture();
    const result = await catchUp(t, ws, ownerId);
    expect(result?.entries.map((entry) => entry.path)).toContain("1-projects/secret/codes.md");
  });

  test("a deleted private note is never named to a member; a deleted team note is", async () => {
    const { t, ws, memberId, ownerId } = await fixture();
    await observe(t, ws, 40, [], ["2-areas/mine.md", "1-projects/secret/codes.md", "1-projects/plan.md"]);
    const member = await catchUp(t, ws, memberId);
    expect(member?.gone).toEqual(["1-projects/plan.md"]);
    // Its folder emptied with it, and the member knew that folder; never `1-projects/secret`.
    expect(member?.goneFolders).toEqual(["1-projects"]);
    expect(member?.entries.map((entry) => entry.path)).toEqual(["2-areas/shared.md"]);
    const owner = await catchUp(t, ws, ownerId);
    expect(owner?.gone.sort()).toEqual(["1-projects/plan.md", "1-projects/secret/codes.md", "2-areas/mine.md"]);
    expect(owner?.goneFolders.sort()).toEqual(["1-projects", "1-projects/secret"]);
  });

  test("a member's cursor never names a change they could not see", async () => {
    const { t, ws, memberId } = await fixture();
    await observe(t, ws, 40, ["1-projects/later.md"]);
    await observe(t, ws, 50, ["1-projects/secret/later.md"]);
    const rows = await logRows(t);
    const teamSeq = rows.find((row) => row.path === "1-projects/later.md")?.seq;
    const result = await catchUp(t, ws, memberId);
    expect(result?.since).toBe(teamSeq);
    // Reading on from there tells them nothing more, and the cursor stays put.
    const next = await catchUp(t, ws, memberId, { since: result?.since });
    expect(next?.entries).toEqual([]);
    expect(next?.since).toBe(teamSeq);
  });

  test("a full page of other people's changes sends a member to walk", async () => {
    const { t, ws, memberId, ownerId } = await fixture();
    const since = Math.max(...(await logRows(t)).map((row) => row.seq));
    await observe(t, ws, 40, ["1-projects/secret/a.md", "1-projects/secret/b.md"]);
    expect((await catchUp(t, ws, memberId, { since, limit: 1 }))?.full).toBe(true);
    const owner = await catchUp(t, ws, ownerId, { since, limit: 1 });
    expect(owner?.full).toBe(false);
    expect(owner?.more).toBe(true);
  });

  test("a copy judged by other rules, or older than the log, walks", async () => {
    const { t, ws, memberId } = await fixture();
    expect((await catchUp(t, ws, memberId, { privacy: "nodes:privacy-0" }))?.full).toBe(true);
    expect((await catchUp(t, ws, memberId, { privacy: "privacy-1" }))?.full).toBe(true);
    expect((await catchUp(t, ws, memberId, { since: 0 }))?.full).toBe(true);
    await t.mutation(internal.functions.nodes.savePrivacy, { workspaceId: ws, mirror: { ...RULES, etag: "privacy-2" }, at: 60 });
    expect((await catchUp(t, ws, memberId))?.full).toBe(true);
    expect((await catchUp(t, ws, memberId, { privacy: "nodes:privacy-2" }))?.full).toBe(false);
  });

  test("not served: null, so the D1 log or a walk answers", async () => {
    const { t, ws, memberId } = await fixture();
    await t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: true, updatedAt: 1 });
    });
    expect(await catchUp(t, ws, memberId)).toBeNull();
    expect(await t.query(internal.functions.nodesFeed.walkStart, { workspaceId: ws, now: Date.now() })).toBeNull();
  });

  test("a stranger is refused", async () => {
    const { t, ws, strangerId } = await fixture();
    await expect(catchUp(t, ws, strangerId)).rejects.toThrow();
  });

  test("the action answers a cursor from this log with a walk once the tree stops serving", async () => {
    const { t, ws, member } = await fixture();
    await t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: true, updatedAt: 1 });
    });
    const result = await member.action(api.functions.treeChanges.syncTreeChanges, {
      workspaceId: ws,
      since: seqAt(Date.now()),
      privacy: TOKEN,
    });
    expect(result.full).toBe(true);
  });

  test("a walk starts its catch-up a little behind the clock, with the rules version", async () => {
    const { t, ws } = await fixture();
    const now = Date.now();
    expect(await t.query(internal.functions.nodesFeed.walkStart, { workspaceId: ws, now })).toEqual({
      since: seqAt(now - 60_000),
      privacy: TOKEN,
    });
  });
});

describe("the live head", () => {
  test("moves for a member only when a change they may see lands", async () => {
    const { t, ws, member, owner } = await fixture();
    const memberHead = async () => (await member.query(api.functions.nodesFeed.head, { workspaceId: ws }))?.token;
    const ownerHead = async () => (await owner.query(api.functions.nodesFeed.head, { workspaceId: ws }))?.token;
    const m0 = await memberHead();
    const o0 = await ownerHead();
    await observe(t, ws, 40, ["1-projects/secret/new.md"]);
    expect(await memberHead()).toBe(m0);
    expect(await ownerHead()).not.toBe(o0);
    await observe(t, ws, 50, ["1-projects/new.md"]);
    expect(await memberHead()).not.toBe(m0);
  });

  test("moves when the rules change, and is null while the tree does not serve", async () => {
    const { t, ws, member } = await fixture();
    const before = await member.query(api.functions.nodesFeed.head, { workspaceId: ws });
    await t.mutation(internal.functions.nodes.savePrivacy, { workspaceId: ws, mirror: { ...RULES, etag: "privacy-2" }, at: 60 });
    const after = await member.query(api.functions.nodesFeed.head, { workspaceId: ws });
    expect(after?.token).not.toBe(before?.token);
    await t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: true, updatedAt: 1 });
    });
    expect(await member.query(api.functions.nodesFeed.head, { workspaceId: ws })).toBeNull();
  });

  test("a stranger and a signed-out caller are refused", async () => {
    const { t, ws, stranger } = await fixture();
    await expect(stranger.query(api.functions.nodesFeed.head, { workspaceId: ws })).rejects.toThrow();
    await expect(t.query(api.functions.nodesFeed.head, { workspaceId: ws })).rejects.toThrow();
  });
});

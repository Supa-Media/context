/**
 * `POST /gateway/tree/facts` (`functions/lib/nodes/gatewayFacts.ts`): a
 * move's link candidates and the chaos score's extras, for the gateway.
 *
 * What is proved:
 *  - the workspace and the clearance come off the person's grant, and every
 *    path that comes back has passed `canSee` at it: a team reader is never
 *    told a private note points at what moved, or that a private note is long;
 *  - every refusal is the same bytes as a tree that does not serve;
 *  - facts not yet whole say so (`candidates: null`, `chaos: null`), and the
 *    gateway falls back;
 *  - today's score is kept only from an owner's private read;
 *  - a note's props (front matter, heading, first paragraph) come back only
 *    for notes the reader may see, and a note never read is absent;
 *  - the forwarding ledger (`ask: "forwarding"`, held in Convex since
 *    2026-10-14) names no path the reader may not see: an entry from such a
 *    path is absent, and one to such a path says only `to: null`.
 *
 * Sabotage (temporary local edits, reverted):
 *  - dropping the `visible` filter on candidates: the member case fails;
 *  - dropping the `private` check on `today`: the team-record case fails;
 *  - dropping the `visible` filter on props: "props are only for notes the
 *    reader may see" fails at member clearance;
 *  - answering every ledger entry whole: "the ledger names no path the
 *    reader may not see" fails at member clearance;
 *  - judging a folder entry by `canSee` rather than the folder rule: the
 *    same case fails (the rename of a private folder the team reaches
 *    through a shared note goes missing, as the tree would still show it);
 *  - dropping the seed's `visible` check: "a hidden seed answers what an
 *    absent one does" fails at member clearance;
 *  - a 200-row cap on each side whose overflow marks the answer incomplete:
 *    "hidden backlinkers never change a team reader's answer" fails;
 *  - marking every answer short while any move is queued: the same case
 *    fails on its private move.
 */

import { seedTreeRows } from "../fixtures.helpers";
import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { gatewayPost, responseFingerprint, seedStorageBinding } from "../fixtures.helpers";
import { registerClient, seedConnectedClient, token } from "../controlPlane/fixtures.helpers";
import { hashToken } from "../../functions/lib/crypto";
import { translateMirror } from "../seededRules.helpers";

type T = ReturnType<typeof convexTest>;

const OWNER = token("facts_owner");
const OWNER_TEAM = token("facts_owner_team");
const MEMBER = token("facts_member");
const CAPTURE = token("facts_capture");
const OTHER = token("facts_other");
const CLIENT = "mcp_client_facts";

// Rows are keyed by their path with no trailing slash, so a folder's rule names it the same way.
const RULES = {
  invalid: false,
  folders: [
    { prefix: "1-projects", visibility: "team" },
    { prefix: "1-projects/secret", visibility: "private" },
  ],
  notes: [{ path: "2-areas/shared.md", visibility: "team" }],
};

const PATHS = [
  "privacy.md",
  "index.md",
  "1-projects/plan.md",
  "1-projects/later.md",
  "1-projects/secret/codes.md",
  "2-areas/mine.md",
  "2-areas/shared.md",
];

/** Each path's bucket object at version `e-<path>`, the version the facts answer name. */
async function observe(t: T, workspaceId: Id<"workspaces">, paths: string[]) {
  await seedTreeRows(t, workspaceId, paths.map((path) => ({ path, etag: `e-${path}` })));
}

async function proved(t: T, workspaceId: Id<"workspaces">, paths: string[]) {
  await observe(t, workspaceId, paths);
  await translateMirror(t, workspaceId, RULES);
}

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const user = (email: string) => ctx.db.insert("users", { email, emailVerificationTime: now } as never);
    const ownerId = await user("owner@example.test");
    const memberId = await user("member@example.test");
    const outsiderId = await user("outsider@example.test");
    const workspace = (slug: string, createdBy: Id<"users">) =>
      ctx.db.insert("workspaces", {
        slug,
        displayName: slug,
        createdBy,
        kind: "shared",
        structureTemplate: "para",
        createdAt: now,
        updatedAt: now,
      });
    const ws = await workspace("acme", ownerId);
    const other = await workspace("other", outsiderId);
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: ownerId, role: "owner", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: memberId, role: "member", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: other, userId: outsiderId, role: "owner", joinedAt: now });
    return { ws, other, ownerId, memberId, outsiderId };
  });
  await proved(t, ids.ws, PATHS);
  await proved(t, ids.other, ["privacy.md", "1-projects/theirs.md"]);
  await registerClient(t, CLIENT);
  const grant = (accessToken: string, userId: Id<"users">, workspaceId: Id<"workspaces">, scopes: string[]) =>
    seedConnectedClient(t, { workspaceId, userId, clientId: CLIENT, accessToken, scopes });
  await grant(OWNER, ids.ownerId, ids.ws, ["context:read", "context:write", "context:private"]);
  await grant(OWNER_TEAM, ids.ownerId, ids.ws, ["context:read"]);
  await grant(MEMBER, ids.memberId, ids.ws, ["context:read", "context:write"]);
  await grant(CAPTURE, ids.memberId, ids.ws, ["context:capture"]);
  await grant(OTHER, ids.outsiderId, ids.other, ["context:read", "context:private"]);
  return { t, ...ids };
}

async function withFacts(t: T, workspaceId: Id<"workspaces">) {
  await t.run(async (ctx) => {
    await ctx.db.insert("nodeFactState", { workspaceId, ready: true, seq: Number.MAX_SAFE_INTEGER });
    const link = (source: string, kind: "path" | "name", target: string) => ctx.db.insert("nodeLinks", { workspaceId, source, kind, target });
    await link("1-projects/later.md", "path", "1-projects/plan.md");
    await link("1-projects/secret/codes.md", "name", "plan");
    await link("2-areas/mine.md", "path", "1-projects/plan.md");
    const long = JSON.stringify({ properties: {}, lines: 1_500 });
    for (const path of ["1-projects/later.md", "2-areas/mine.md"]) {
      const row = await (ctx.db as unknown as MutationCtx["db"])
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
        .unique();
      await ctx.db.patch(row!._id, { parsed: row!.etag, props: long, chaosNote: true });
    }
    await ctx.db.insert("nodeChaosDays", { workspaceId, day: new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10), all: 55, team: 33 });
  });
}

async function facts(t: T, body: Record<string, unknown>) {
  const response = await gatewayPost(t, "/gateway/tree/facts", body);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, any>;
}

const LINKS = { ask: "links", sources: ["1-projects/plan.md"], names: ["plan"] };
const NEIGHBORS = { ask: "neighbors", path: "1-projects/plan.md" };

async function addLinks(t: T, workspaceId: Id<"workspaces">, links: Array<[string, "path" | "name", string]>) {
  await t.run(async (ctx) => {
    for (const [source, kind, target] of links) await ctx.db.insert("nodeLinks", { workspaceId, source, kind, target });
  });
}

describe("POST /gateway/tree/facts", () => {
  test("a move's candidates are what the reader may see", async () => {
    const { t, ws } = await fixture();
    await withFacts(t, ws);
    const owner = await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ...LINKS });
    expect(owner.candidates.pointing.sort()).toEqual(["1-projects/later.md", "1-projects/secret/codes.md", "2-areas/mine.md"]);
    for (const reader of [MEMBER, OWNER_TEAM]) {
      const team = await facts(t, { accessToken: reader, expectedWorkspaceId: ws, ...LINKS });
      expect(team.candidates.pointing).toEqual(["1-projects/later.md"]);
    }
  });

  test("facts not yet whole say so", async () => {
    const { t, ws } = await fixture();
    expect(await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ...LINKS })).toEqual({ served: true, candidates: null });
    expect(await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ask: "chaos" })).toEqual({ served: true, chaos: null });
  });

  test("the chaos extras are what the reader may see, with their audience's week", async () => {
    const { t, ws } = await fixture();
    await withFacts(t, ws);
    const owner = await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ask: "chaos" });
    expect(owner.chaos.extras.map((extra: { path: string }) => extra.path).sort()).toEqual(["1-projects/later.md", "2-areas/mine.md"]);
    expect(owner.chaos.weekAgo).toBe(55);
    const member = await facts(t, { accessToken: MEMBER, expectedWorkspaceId: ws, ask: "chaos" });
    expect(member.chaos).toEqual({ extras: [{ path: "1-projects/later.md", lines: 1_500, exempt: false, review: false }], weekAgo: 33 });
  });

  test("only an owner's private read keeps today's score", async () => {
    const { t, ws } = await fixture();
    await withFacts(t, ws);
    const days = () => t.run(async (ctx) => (await ctx.db.query("nodeChaosDays").collect()).length);
    await facts(t, { accessToken: MEMBER, expectedWorkspaceId: ws, ask: "chaos", today: { all: 10, team: 5 } });
    await facts(t, { accessToken: OWNER_TEAM, expectedWorkspaceId: ws, ask: "chaos", today: { all: 10, team: 5 } });
    await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ask: "chaos", today: { all: 900, team: 5 } });
    expect(await days()).toBe(1);
    await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ask: "chaos", today: { all: 10, team: 5 } });
    expect(await days()).toBe(2);
    const now = Date.now();
    expect(await t.query(internal.functions.nodeChaos.history, { workspaceId: ws, daysAgo: 0, now })).toMatchObject({ then: { all: 10, team: 5 } });
  });

  test("every refusal is the same bytes as a tree that does not serve", async () => {
    const { t, ws, other } = await fixture();
    await withFacts(t, ws);
    const notServed = await responseFingerprint(await gatewayPost(t, "/gateway/tree/facts", { accessToken: OWNER, expectedWorkspaceId: "nope", ...LINKS }));
    const refusals: Record<string, unknown>[] = [
      {},
      { expectedWorkspaceId: ws, ...LINKS },
      { accessToken: OWNER, expectedWorkspaceId: ws },
      { accessToken: OWNER, expectedWorkspaceId: ws, ask: "everything" },
      { accessToken: token("facts_unknown"), expectedWorkspaceId: ws, ...LINKS },
      { accessToken: CAPTURE, expectedWorkspaceId: ws, ...LINKS },
      { accessToken: OTHER, expectedWorkspaceId: ws, ...LINKS },
      { accessToken: OWNER, expectedWorkspaceId: other, ...LINKS },
      { accessToken: OWNER, expectedWorkspaceId: ws, ask: "links", sources: "1-projects/plan.md", names: [] },
      { accessToken: OWNER, expectedWorkspaceId: ws, ask: "links", sources: ["x".repeat(2_000)], names: [] },
      { accessToken: OWNER, expectedWorkspaceId: ws, ask: "links", sources: Array.from({ length: 2_001 }, (_, n) => `${n}.md`), names: [] },
      { accessToken: OWNER, expectedWorkspaceId: ws, ask: "props", paths: "1-projects/plan.md" },
      { accessToken: OWNER, expectedWorkspaceId: ws, ask: "props", paths: Array.from({ length: 101 }, (_, n) => `${n}.md`) },
      { accessToken: CAPTURE, expectedWorkspaceId: ws, ask: "props", paths: ["1-projects/plan.md"] },
      { accessToken: CAPTURE, expectedWorkspaceId: ws, ask: "forwarding" },
      { accessToken: OTHER, expectedWorkspaceId: ws, ask: "forwarding" },
      { accessToken: OWNER, expectedWorkspaceId: other, ask: "forwarding" },
      { accessToken: OWNER, expectedWorkspaceId: ws, ask: "neighbors" },
      { accessToken: OWNER, expectedWorkspaceId: ws, ask: "neighbors", path: ["1-projects/plan.md"] },
      { accessToken: OWNER, expectedWorkspaceId: ws, ask: "neighbors", path: "x".repeat(2_000) },
      { accessToken: CAPTURE, expectedWorkspaceId: ws, ...NEIGHBORS },
      { accessToken: OTHER, expectedWorkspaceId: ws, ...NEIGHBORS },
    ];
    for (const body of refusals) {
      const response = await gatewayPost(t, "/gateway/tree/facts", body);
      expect(await responseFingerprint(response), JSON.stringify(body).slice(0, 60)).toBe(notServed);
    }
    expect(notServed).toContain('{"served":false}');
  });

  test("a tree not ready yet is not served to a reader the grant lets in", async () => {
    const { t, ws, ownerId } = await fixture();
    await seedStorageBinding(t as never, { workspaceId: ws, boundBy: ownerId, status: "connected" });
    await withFacts(t, ws);
    expect(await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ...LINKS })).toMatchObject({ served: true });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("nodeTrees").withIndex("by_workspace", (q) => q.eq("workspaceId", ws)).unique();
      if (row) await ctx.db.patch(row._id, { status: "filling", sweptAt: undefined });
    });
    expect(await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ...LINKS })).toEqual({ served: false });
  });

  test("props are only for notes the reader may see, and a note never read is absent", async () => {
    const { t, ws } = await fixture();
    await withFacts(t, ws);
    await t.run(async (ctx) => {
      const db = ctx.db as unknown as MutationCtx["db"];
      const rowOf = (path: string) =>
        db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", ws).eq("path", path)).unique();
      const secret = await rowOf("1-projects/secret/codes.md");
      await ctx.db.patch(secret!._id, { parsed: secret!.etag, props: JSON.stringify({ properties: { owner: "x" } }) });
      const plan = await rowOf("1-projects/plan.md");
      await ctx.db.patch(plan!._id, { parsed: plan!.etag, sealed: true });
    });
    const paths = ["1-projects/later.md", "1-projects/plan.md", "1-projects/secret/codes.md", "2-areas/mine.md", "2-areas/shared.md", "1-projects/nope.md"];
    const owner = await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ask: "props", paths });
    expect(owner.props.map((row: { path: string }) => row.path).sort()).toEqual([
      "1-projects/later.md",
      "1-projects/plan.md",
      "1-projects/secret/codes.md",
      "2-areas/mine.md",
    ]);
    expect(owner.props.find((row: { path: string }) => row.path === "1-projects/plan.md")).toEqual({
      path: "1-projects/plan.md",
      version: "e-1-projects/plan.md",
      sealed: true,
      props: null,
    });
    for (const reader of [MEMBER, OWNER_TEAM]) {
      const team = await facts(t, { accessToken: reader, expectedWorkspaceId: ws, ask: "props", paths });
      expect(team.props.map((row: { path: string }) => row.path).sort()).toEqual(["1-projects/later.md", "1-projects/plan.md"]);
      expect(team.props.find((row: { path: string }) => row.path === "1-projects/later.md").props).toBe(
        JSON.stringify({ properties: {}, lines: 1_500 }),
      );
    }
  });

  test("another workspace's links never answer", async () => {
    const { t, ws, other } = await fixture();
    await withFacts(t, ws);
    await t.run(async (ctx) => ctx.db.insert("nodeFactState", { workspaceId: other, ready: true, seq: Number.MAX_SAFE_INTEGER }));
    const theirs = await facts(t, { accessToken: OTHER, expectedWorkspaceId: other, ...LINKS });
    expect(theirs.candidates).toEqual({ pointing: [], unparsed: [] });
  });

  test("the ledger names no path the reader may not see", async () => {
    const { t, ws } = await fixture();
    const moves = [
      { from: "1-projects/secret", to: "1-projects/secret-renamed", kind: "folder" as const },
      { from: "1-projects/old.md", to: "1-projects/plan.md", kind: "note" as const },
      { from: "1-projects/was.md", to: "1-projects/secret/codes.md", kind: "note" as const },
      { from: "2-areas/old-mine.md", to: "1-projects/later.md", kind: "note" as const },
      { from: "1-projects/q3", to: "1-projects/q4", kind: "folder" as const },
      // A private folder the team still reaches, through the note shared out of it.
      { from: "2-areas", to: "1-projects/areas", kind: "folder" as const },
    ];
    await t.mutation(internal.functions.smallData.recordForwarding, { workspaceId: ws, moves, now: 1_000 });
    const owner = await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ask: "forwarding" });
    expect(owner.forwarding.map(({ from, to, kind }: Record<string, string>) => ({ from, to, kind }))).toEqual(moves);
    for (const reader of [MEMBER, OWNER_TEAM]) {
      const response = await gatewayPost(t, "/gateway/tree/facts", { accessToken: reader, expectedWorkspaceId: ws, ask: "forwarding" });
      const text = await response.text();
      expect(JSON.parse(text).forwarding.map(({ from, to }: Record<string, string>) => [from, to])).toEqual([
        ["1-projects/old.md", "1-projects/plan.md"],
        ["1-projects/was.md", null],
        ["1-projects/q3", "1-projects/q4"],
        ["2-areas", "1-projects/areas"],
      ]);
      for (const unseen of ["secret", "old-mine"]) expect(text).not.toContain(unseen);
    }
  });

  test("another workspace's ledger never answers", async () => {
    const { t, ws, other } = await fixture();
    await t.mutation(internal.functions.smallData.recordForwarding, {
      workspaceId: ws,
      moves: [{ from: "1-projects/a.md", to: "1-projects/b.md", kind: "note" }],
      now: 1_000,
    });
    expect(await facts(t, { accessToken: OTHER, expectedWorkspaceId: other, ask: "forwarding" })).toEqual({ served: true, forwarding: [] });
  });
  test("a note's backlinks are what the reader may see", async () => {
    const { t, ws } = await fixture();
    await withFacts(t, ws);
    const owner = await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ...NEIGHBORS });
    expect(owner.neighbors.backlinks).toEqual(["1-projects/later.md", "1-projects/secret/codes.md", "2-areas/mine.md"]);
    expect(owner.neighbors.links).toEqual([]);
    for (const reader of [MEMBER, OWNER_TEAM]) {
      const team = await facts(t, { accessToken: reader, expectedWorkspaceId: ws, ...NEIGHBORS });
      // plan.md's own text has not been read for links yet, so its answer may be short.
      expect(team.neighbors).toEqual({ links: [], backlinks: ["1-projects/later.md"], complete: false });
    }
  });

  test("a note's links resolve paths and bare names, and name only what the reader may see", async () => {
    const { t, ws } = await fixture();
    await withFacts(t, ws);
    await addLinks(t, ws, [
      ["1-projects/later.md", "name", "shared"],
      ["1-projects/later.md", "path", "1-projects/secret/codes.md"],
      ["1-projects/later.md", "path", "1-projects/missing.md"],
      ["1-projects/later.md", "name", "nobody"],
    ]);
    const later = { ask: "neighbors", path: "1-projects/later.md" };
    const owner = await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ...later });
    expect(owner.neighbors.links).toEqual(["1-projects/plan.md", "1-projects/secret/codes.md", "2-areas/shared.md"]);
    const member = await facts(t, { accessToken: MEMBER, expectedWorkspaceId: ws, ...later });
    expect(member.neighbors.links).toEqual(["1-projects/plan.md", "2-areas/shared.md"]);
  });

  test("a bare name beside the note wins, and a name two visible notes share names neither", async () => {
    const { t, ws } = await fixture();
    await withFacts(t, ws);
    await seedTreeRows(t, ws, [{ path: "1-projects/secret/plan.md", etag: "e-twin" }, { path: "2-areas/x/later.md", etag: "e-later2" }]);
    await addLinks(t, ws, [["2-areas/mine.md", "name", "later"]]);
    const owner = await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ...NEIGHBORS });
    // codes.md's [[plan]] now means the plan.md beside it.
    expect(owner.neighbors.backlinks).toEqual(["1-projects/later.md", "2-areas/mine.md"]);
    const mine = await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ask: "neighbors", path: "2-areas/mine.md" });
    // [[later]] matches two visible notes, so it names neither.
    expect(mine.neighbors.links).toEqual(["1-projects/plan.md"]);
  });

  test("hidden backlinkers never change a team reader's answer, however many", async () => {
    const { t, ws } = await fixture();
    await withFacts(t, ws);
    // The seed's own links read, so its answer is whole and anything that made it short would show.
    await t.run(async (ctx) => {
      const db = ctx.db as unknown as MutationCtx["db"];
      const plan = await db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", ws).eq("path", "1-projects/plan.md")).unique();
      await ctx.db.patch(plan!._id, { parsed: plan!.etag });
    });
    const ask = async () => responseFingerprint(await gatewayPost(t, "/gateway/tree/facts", { accessToken: MEMBER, expectedWorkspaceId: ws, ...NEIGHBORS }));
    const before = await ask();
    expect(before).toContain('"complete":true');
    await seedTreeRows(t, ws, Array.from({ length: 250 }, (_, n) => ({ path: `2-areas/hidden-${n}.md`, etag: `e-h${n}` })));
    await addLinks(t, ws, Array.from({ length: 250 }, (_, n): [string, "path", string] => [`2-areas/hidden-${n}.md`, "path", "1-projects/plan.md"]));
    expect(await ask()).toBe(before);
    // Nor does a move of a note they cannot see, though it links here.
    await t.run(async (ctx) =>
      ctx.db.insert("rowMoves", {
        workspaceId: ws,
        from: "1-projects/secret/codes.md",
        to: "1-projects/secret/old/codes.md",
        trash: false,
        state: "moving",
        scope: "private",
        grantedNames: [],
        privacyEtag: null,
        pass: 1,
        moved: 0,
        left: 1,
        now: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    expect(await ask()).toBe(before);
  });

  test("a note mid-move is named where the tree shows it, and the answer says it may be short", async () => {
    const { t, ws } = await fixture();
    await withFacts(t, ws);
    await t.run(async (ctx) =>
      ctx.db.insert("rowMoves", {
        workspaceId: ws,
        from: "1-projects/later.md",
        to: "1-projects/done/later.md",
        trash: false,
        state: "moving",
        scope: "private",
        grantedNames: [],
        privacyEtag: null,
        pass: 1,
        moved: 0,
        left: 1,
        now: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const owner = await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ...NEIGHBORS });
    expect(owner.neighbors.backlinks).toEqual(["1-projects/done/later.md", "1-projects/secret/codes.md", "2-areas/mine.md"]);
    expect(owner.neighbors.complete).toBe(false);
    const moved = await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ask: "neighbors", path: "1-projects/done/later.md" });
    expect(moved.neighbors.complete).toBe(false);
  });

  test("a percent-encoded path link names the note it spells", async () => {
    const { t, ws } = await fixture();
    await withFacts(t, ws);
    await seedTreeRows(t, ws, [{ path: "1-projects/road map.md", etag: "e-road" }]);
    await addLinks(t, ws, [["1-projects/later.md", "path", "1-projects/road%20map.md"]]);
    const later = await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ask: "neighbors", path: "1-projects/later.md" });
    expect(later.neighbors.links).toEqual(["1-projects/plan.md", "1-projects/road map.md"]);
  });

  test("a hidden seed answers what an absent one does", async () => {
    const { t, ws } = await fixture();
    await withFacts(t, ws);
    const ask = (path: string) => gatewayPost(t, "/gateway/tree/facts", { accessToken: MEMBER, expectedWorkspaceId: ws, ask: "neighbors", path });
    const hidden = await responseFingerprint(await ask("1-projects/secret/codes.md"));
    expect(hidden).toBe(await responseFingerprint(await ask("1-projects/nope.md")));
    expect(hidden).not.toContain("plan");
  });

  test("a note's neighbors before the facts are whole say so", async () => {
    const { t, ws } = await fixture();
    expect(await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ...NEIGHBORS })).toEqual({ served: true, neighbors: null });
  });
});

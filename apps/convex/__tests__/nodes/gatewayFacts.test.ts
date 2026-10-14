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
 *  - today's score is kept only from an owner's private read.
 *
 * Sabotage (temporary local edits, reverted):
 *  - dropping the `visible` filter on candidates: the member case fails;
 *  - dropping the `private` check on `today`: the team-record case fails.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { gatewayPost, responseFingerprint } from "../fixtures.helpers";
import { registerClient, seedConnectedClient, token } from "../controlPlane/fixtures.helpers";

type T = ReturnType<typeof convexTest>;

const OWNER = token("facts_owner");
const OWNER_TEAM = token("facts_owner_team");
const MEMBER = token("facts_member");
const CAPTURE = token("facts_capture");
const OTHER = token("facts_other");
const CLIENT = "mcp_client_facts";

const RULES = {
  etag: "privacy-1",
  invalid: false,
  folders: [
    { prefix: "1-projects/", visibility: "team" },
    { prefix: "1-projects/secret/", visibility: "private" },
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

async function observe(t: T, workspaceId: Id<"workspaces">, paths: string[]) {
  await t.mutation(internal.functions.nodes.observe, {
    workspaceId,
    at: 10,
    rows: paths.map((path) => ({ path, etag: `e-${path}`, size: path.length, uploaded: 1_000 })),
    gone: [],
    vanishedUnder: [],
  });
}

async function proved(t: T, workspaceId: Id<"workspaces">, paths: string[], mismatches = 0) {
  await observe(t, workspaceId, paths);
  await t.mutation(internal.functions.nodes.savePrivacy, { workspaceId, mirror: RULES, at: 10 });
  await t.mutation(internal.functions.nodes.begin, { workspaceId, at: 5 });
  await t.mutation(internal.functions.nodes.finish, { workspaceId, at: 20, files: paths.length });
  await t.mutation(internal.functions.nodes.saveParity, {
    workspaceId,
    parity: { checkedAt: 30, clearances: 2, mismatches, privacyMatches: true },
  });
}

async function fixture(options: { mismatches?: number } = {}) {
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
  await proved(t, ids.ws, PATHS, options.mismatches ?? 0);
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
    ];
    for (const body of refusals) {
      const response = await gatewayPost(t, "/gateway/tree/facts", body);
      expect(await responseFingerprint(response), JSON.stringify(body).slice(0, 60)).toBe(notServed);
    }
    expect(notServed).toContain('{"served":false}');
  });

  test("a first copy not finished is still loading for a reader the grant lets in; parity changes nothing", async () => {
    const { t, ws } = await fixture({ mismatches: 3 });
    await withFacts(t, ws);
    expect(await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ...LINKS })).toMatchObject({ served: true });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("nodeTrees").withIndex("by_workspace", (q) => q.eq("workspaceId", ws)).unique();
      if (row) await ctx.db.patch(row._id, { status: "filling", sweptAt: undefined });
    });
    expect(await facts(t, { accessToken: OWNER, expectedWorkspaceId: ws, ...LINKS })).toEqual({ served: false, loading: true });
  });

  test("another workspace's links never answer", async () => {
    const { t, ws, other } = await fixture();
    await withFacts(t, ws);
    await t.run(async (ctx) => ctx.db.insert("nodeFactState", { workspaceId: other, ready: true, seq: Number.MAX_SAFE_INTEGER }));
    const theirs = await facts(t, { accessToken: OTHER, expectedWorkspaceId: other, ...LINKS });
    expect(theirs.candidates).toEqual({ pointing: [], unparsed: [] });
  });
});

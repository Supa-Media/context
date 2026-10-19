/**
 * `POST /gateway/tree/manifest` (`functions/lib/nodes/gatewayManifest.ts`):
 * the gateway's listing tools read the Convex tree.
 *
 * What is proved:
 *  - the workspace and the clearance come off the person's grant, never off
 *    the request: an owner's private grant sees everything, a team member
 *    sees what `privacy.md` gives the team, and a token for one context
 *    reads nothing of another;
 *  - every refusal (no token, an unknown or revoked token, another context,
 *    a malformed field) is the same bytes, so the route is no oracle; only a
 *    reader the grant lets in is told the workspace's first copy is still
 *    loading, and parity and staff's Pause change nothing;
 *  - a folder narrows the answer to its subtree, and pages carry on by the
 *    last path returned.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `gatewayReadClearance` reading every grant as `private`: the member and
 *    owner-without-private cases fail;
 *  - dropping the `context:read` check: the capture-only case fails;
 *  - a token's expected workspace trusted outside the grant's set: the
 *    other-context refusals fail;
 *  - answering a walk whose rules do not parse (or that stopped short): the
 *    unparseable-rules case fails.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { gatewayPost, responseFingerprint, seedStorageBinding } from "../fixtures.helpers";
import { registerClient, seedConnectedClient, token } from "../controlPlane/fixtures.helpers";
import { gatewayReadClearance } from "../../functions/lib/nodes/gatewayManifest";

type T = ReturnType<typeof convexTest>;

const OWNER = token("tree_owner");
const OWNER_TEAM = token("tree_owner_team");
const MEMBER = token("tree_member");
const CAPTURE = token("tree_capture");
const OTHER = token("tree_other");
const CLIENT = "mcp_client_tree";

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

async function manifest(t: T, body: Record<string, unknown>) {
  const response = await gatewayPost(t, "/gateway/tree/manifest", body);
  expect(response.status).toBe(200);
  return (await response.json()) as { served: boolean; entries?: { path: string; size?: number; updatedAt?: number }[]; cursor?: string | null };
}

const paths = (answer: { entries?: { path: string }[] }) => answer.entries?.map((entry) => entry.path);

describe("gatewayReadClearance", () => {
  const ws = "ws_1" as Id<"workspaces">;
  test("private only for an owner whose grant asked for it", () => {
    const owner = [{ workspaceId: ws, role: "owner" }];
    expect(gatewayReadClearance({ scopes: ["context:read", "context:private"], workspaces: owner }, ws)).toEqual({ workspaceId: ws, scope: "private", names: [], audience: "member" });
    expect(gatewayReadClearance({ scopes: ["context:read"], workspaces: owner }, ws)).toEqual({ workspaceId: ws, scope: "team", names: [], audience: "member" });
    const editor = [{ workspaceId: ws, role: "editor" }];
    expect(gatewayReadClearance({ scopes: ["context:read", "context:private"], workspaces: editor }, ws)).toEqual({ workspaceId: ws, scope: "team", names: [], audience: "member" });
  });
  test("no read scope, or a context outside the grant's set, reads nothing", () => {
    const owner = [{ workspaceId: ws, role: "owner" }];
    expect(gatewayReadClearance({ scopes: ["context:capture"], workspaces: owner }, ws)).toBeNull();
    expect(gatewayReadClearance({ scopes: ["context:read"], workspaces: owner }, "ws_2")).toBeNull();
  });
});

describe("POST /gateway/tree/manifest", () => {
  test("the owner's private grant sees every file, with versions and dates", async () => {
    const { t, ws } = await fixture();
    const answer = await manifest(t, { accessToken: OWNER, expectedWorkspaceId: ws });
    expect(answer.served).toBe(true);
    expect(paths(answer)?.sort()).toEqual([...PATHS].sort());
    expect(answer.entries?.find((entry) => entry.path === "index.md")).toMatchObject({ size: "index.md".length, updatedAt: 1_000 });
    expect(answer.cursor).toBeNull();
  });

  test("a team reader sees what privacy.md gives the team, and never privacy.md", async () => {
    const { t, ws } = await fixture();
    const team = ["1-projects/later.md", "1-projects/plan.md", "2-areas/shared.md"];
    for (const accessToken of [MEMBER, OWNER_TEAM]) {
      const answer = await manifest(t, { accessToken, expectedWorkspaceId: ws });
      expect(paths(answer)?.sort()).toEqual(team);
    }
  });

  test("a folder narrows the answer to its subtree", async () => {
    const { t, ws } = await fixture();
    const answer = await manifest(t, { accessToken: OWNER, expectedWorkspaceId: ws, folder: "1-projects" });
    expect(paths(answer)?.sort()).toEqual(["1-projects/later.md", "1-projects/plan.md", "1-projects/secret/codes.md"]);
  });

  test("a page carries on after the cursor", async () => {
    const { t, ws } = await fixture();
    const answer = await manifest(t, { accessToken: OWNER, expectedWorkspaceId: ws, cursor: "1-projects/secret/codes.md" });
    expect(paths(answer)).toEqual(["2-areas/mine.md", "2-areas/shared.md", "index.md", "privacy.md"]);
  });

  test("every refusal is the same bytes as a tree that does not serve", async () => {
    const { t, ws, other } = await fixture();
    const notServed = await responseFingerprint(await gatewayPost(t, "/gateway/tree/manifest", { accessToken: OWNER, expectedWorkspaceId: "nope" }));
    const refusals: Record<string, unknown>[] = [
      {},
      { expectedWorkspaceId: ws },
      { accessToken: token("tree_unknown"), expectedWorkspaceId: ws },
      { accessToken: CAPTURE, expectedWorkspaceId: ws },
      { accessToken: OTHER, expectedWorkspaceId: ws },
      { accessToken: OWNER, expectedWorkspaceId: other },
      { accessToken: OWNER, expectedWorkspaceId: ws, folder: 42 },
      { accessToken: OWNER, expectedWorkspaceId: ws, cursor: "x".repeat(2_000) },
      { accessToken: OWNER, expectedWorkspaceId: ws, folder: "../2-areas" },
    ];
    for (const body of refusals) {
      const response = await gatewayPost(t, "/gateway/tree/manifest", body);
      expect(await responseFingerprint(response), JSON.stringify(body).slice(0, 60)).toBe(notServed);
    }
    expect(notServed).toContain('{"served":false}');
  });

  // Parity is an alarm for staff, and Pause stops copying only (decided by the owner, 2026-10-13).
  test("a tree whose check found differences is still served", async () => {
    const { t, ws } = await fixture({ mismatches: 2 });
    expect(await manifest(t, { accessToken: OWNER, expectedWorkspaceId: ws })).toMatchObject({ served: true });
  });

  test("a first copy not finished says so to a reader it would answer, and kicks the copy", async () => {
    const { t, ws, ownerId } = await fixture();
    // Loading means a bucket is bound and not yet copied; with none there is nothing to load.
    await seedStorageBinding(t as never, { workspaceId: ws, boundBy: ownerId, status: "connected" });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("nodeTrees").withIndex("by_workspace", (q) => q.eq("workspaceId", ws)).unique();
      if (row) await ctx.db.patch(row._id, { status: "filling", sweptAt: undefined, leaseAt: undefined });
    });
    expect(await manifest(t, { accessToken: OWNER, expectedWorkspaceId: ws })).toEqual({ served: false, loading: true });
    const sweeps = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) => (job.args[0] as { operation?: { kind?: string } })?.operation?.kind === "nodesSweep",
      ).length,
    );
    expect(sweeps).toBeGreaterThan(0);
    // A token that may not read it learns nothing of the sort.
    expect(await manifest(t, { accessToken: OTHER, expectedWorkspaceId: ws })).toEqual({ served: false });
  });

  test("rules that do not parse are not served: the gateway's own check fails closed on the bucket", async () => {
    const { t, ws } = await fixture();
    await t.mutation(internal.functions.nodes.savePrivacy, { workspaceId: ws, mirror: { ...RULES, invalid: true }, at: 40 });
    expect(await manifest(t, { accessToken: OWNER, expectedWorkspaceId: ws })).toEqual({ served: false });
  });

  test("staff's Pause changes nothing for a reader", async () => {
    const { t, ws } = await fixture();
    await t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: true, updatedAt: 1 });
    });
    expect(await manifest(t, { accessToken: OWNER, expectedWorkspaceId: ws })).toMatchObject({ served: true });
  });

  test("the gateway secret is still the first door", async () => {
    const { t, ws } = await fixture();
    const response = await gatewayPost(t, "/gateway/tree/manifest", { accessToken: OWNER, expectedWorkspaceId: ws }, { secret: "wrong" });
    expect(response.status).toBe(401);
  });
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "../functions/lib/crypto";
import { MAX_RELEASE_TRIES } from "../functions/browserProfiles";
import { addMember, asUser, createUser, createWorkspace, drainScheduled, gatewayPost, setupTest, type TestConvex } from "./fixtures.helpers";

/**
 * TEX'S SAVED BROWSER PROFILES (the owner, 2026-10-29): one Browserbase
 * Context per person's browser and per group chat's, made and released here.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `covered.kind` check removed from the route
 *     → "a person's browser is filed under their personal workspace only" fails
 *   `row.workspaceId === workspaceId` dropped from `liveProfile`
 *     → "one workspace's token never reaches another's profile" fails
 *   `releaseWorkspaceBrowserProfiles` call removed from the cascade
 *     → "deleting the account deletes the profile at Browserbase" fails
 *   `keepProfile` keeping both rows
 *     → "two first asks at once leave one profile" fails
 */

vi.setConfig({ testTimeout: 20_000 });

const MCP_CLIENT = "mcp_client_browser_profiles";
const OWNER = "a".repeat(64);
const GROUP = "b".repeat(64);
const CHAT = "c".repeat(64);

type Call = { method: string; url: string };
let calls: Call[] = [];
let made = 0;
let deleteStatus = 204;

beforeEach(() => {
  calls = [];
  made = 0;
  deleteStatus = 204;
  vi.stubEnv("BROWSERBASE_API_KEY", "bb_test_key");
  vi.stubEnv("BROWSERBASE_PROJECT_ID", "proj-test");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (url === "https://api.browserbase.com/v1/contexts" && method === "POST") {
      made += 1;
      return Response.json({ id: `ctx-0000000${made}` }, { status: 201 });
    }
    if (url.startsWith("https://api.browserbase.com/v1/contexts/") && method === "DELETE") return new Response(null, { status: deleteStatus });
    return new Response("{}", { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function grant(t: TestConvex, workspaceId: Id<"workspaces">, userId: Id<"users">) {
  const accessToken = `cat_browser_profile_${Math.random().toString(16).slice(2)}${"0".repeat(16)}`;
  const hashedAccessToken = await hashToken(accessToken);
  await t.run(async (ctx) => {
    const known = await ctx.db.query("oauthClients").withIndex("by_clientId", (q) => q.eq("clientId", MCP_CLIENT)).unique();
    if (known === null) {
      await ctx.db.insert("oauthClients", {
        clientId: MCP_CLIENT,
        clientName: "Browser profile test client",
        redirectUris: [],
        hashedClientSecret: null,
        tokenEndpointAuthMethod: "none",
        grantTypes: [],
        responseTypes: [],
        createdAt: Date.now(),
      });
    }
    await ctx.db.insert("oauthGrants", {
      workspaceId,
      userId,
      clientId: MCP_CLIENT,
      scopes: ["context:read", "context:write", "context:private"],
      hashedAccessToken,
      hashedRefreshToken: `refresh_${hashedAccessToken}`,
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
      status: "active",
      createdAt: Date.now(),
    });
  });
  return accessToken;
}

async function profile(t: TestConvex, body: Record<string, unknown>) {
  const response = await gatewayPost(t, "/gateway/browser-profile", body);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

const rows = (t: TestConvex) => t.run((ctx) => ctx.db.query("browserProfiles").collect());
const deletes = () => calls.filter((c) => c.method === "DELETE").map((c) => c.url.split("/").pop());

async function person(t: TestConvex, slug = "ada") {
  const userId = await createUser(t, `${slug}@example.invalid`);
  const workspaceId = await createWorkspace(t, userId, slug, { kind: "personal" });
  return { userId, workspaceId, accessToken: await grant(t, workspaceId, userId) };
}

describe("a person's browser profile", () => {
  test("is made once, then found again", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await person(t);
    expect(await profile(t, { accessToken, expectedWorkspaceId: workspaceId, owner: OWNER })).toEqual({ profileId: "ctx-00000001", created: true });
    expect(await profile(t, { accessToken, expectedWorkspaceId: workspaceId, owner: OWNER })).toEqual({ profileId: "ctx-00000001", created: false });
    expect(made).toBe(1);
    expect(calls[0]).toEqual({ method: "POST", url: "https://api.browserbase.com/v1/contexts" });
  });

  test("a person's browser is filed under their personal workspace only", async () => {
    const t = setupTest();
    const { userId, workspaceId, accessToken } = await person(t);
    const team = await createWorkspace(t, userId, "northwind", { kind: "shared" });
    expect(await profile(t, { accessToken, expectedWorkspaceId: team, owner: OWNER })).toEqual({ profileId: null });
    expect(await profile(t, { accessToken, expectedWorkspaceId: workspaceId, owner: GROUP, chat: CHAT })).toEqual({ profileId: null });
    expect(made).toBe(0);
  });

  test("one workspace's token never reaches another's profile", async () => {
    const t = setupTest();
    const ada = await person(t, "ada");
    const bob = await person(t, "bob");
    await profile(t, { accessToken: ada.accessToken, expectedWorkspaceId: ada.workspaceId, owner: OWNER });
    // Bob's token, naming Ada's workspace: not covered.
    expect(await profile(t, { accessToken: bob.accessToken, expectedWorkspaceId: ada.workspaceId, owner: OWNER })).toEqual({ profileId: null });
    // Bob's own workspace with Ada's tag: a new profile is made and released, never Ada's handed over.
    expect(await profile(t, { accessToken: bob.accessToken, expectedWorkspaceId: bob.workspaceId, owner: OWNER })).toEqual({ profileId: null });
    await drainScheduled(t);
    expect(deletes()).toEqual(["ctx-00000002"]);
    expect((await rows(t)).map((r) => r.profileId)).toEqual(["ctx-00000001"]);
  });

  test("makes nothing without a Browserbase key, so the browser runs on the jar", async () => {
    vi.stubEnv("BROWSERBASE_API_KEY", "");
    const t = setupTest();
    const { workspaceId, accessToken } = await person(t);
    expect(await profile(t, { accessToken, expectedWorkspaceId: workspaceId, owner: OWNER })).toEqual({ profileId: null });
    expect(calls).toEqual([]);
  });

  test("refuses a bad token and an owner that is not a tag", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await person(t);
    expect(await profile(t, { accessToken: "cat_nope", expectedWorkspaceId: workspaceId, owner: OWNER })).toEqual({ profileId: null });
    expect(await profile(t, { accessToken, expectedWorkspaceId: workspaceId, owner: "user_1" })).toEqual({ profileId: null });
    expect(made).toBe(0);
  });

  test("signing Tex out deletes the profile at Browserbase, and the next browser gets a new one", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await person(t);
    await profile(t, { accessToken, expectedWorkspaceId: workspaceId, owner: OWNER });
    expect(await profile(t, { accessToken, expectedWorkspaceId: workspaceId, owner: OWNER, forget: true })).toEqual({ forgotten: 1 });
    await drainScheduled(t);
    expect(deletes()).toEqual(["ctx-00000001"]);
    expect(await rows(t)).toEqual([]);
    expect(await profile(t, { accessToken, expectedWorkspaceId: workspaceId, owner: OWNER })).toEqual({ profileId: "ctx-00000002", created: true });
  });

  test("a release Browserbase refuses is retried, and the row kept as the handle", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await person(t);
    await profile(t, { accessToken, expectedWorkspaceId: workspaceId, owner: OWNER });
    deleteStatus = 500;
    vi.useFakeTimers();
    try {
      await profile(t, { accessToken, expectedWorkspaceId: workspaceId, owner: OWNER, forget: true });
      for (let i = 0; i < MAX_RELEASE_TRIES + 2; i += 1) {
        vi.advanceTimersByTime(7 * 60 * 60 * 1000);
        await t.finishInProgressScheduledFunctions();
      }
    } finally {
      vi.useRealTimers();
    }
    const [row] = await rows(t);
    expect(row).toMatchObject({ status: "releasing", failures: MAX_RELEASE_TRIES });
    expect(deletes().length).toBe(MAX_RELEASE_TRIES);
  });

  test("deleting the account deletes the profile at Browserbase", async () => {
    const t = setupTest();
    const { userId, workspaceId, accessToken } = await person(t);
    await profile(t, { accessToken, expectedWorkspaceId: workspaceId, owner: OWNER });
    await asUser(t, userId).mutation(api.functions.account.deleteAccount, {});
    await drainScheduled(t);
    expect(deletes()).toEqual(["ctx-00000001"]);
    expect(await rows(t)).toEqual([]);
  });

  test("two first asks at once leave one profile", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await person(t);
    const [one, two] = await Promise.all([
      profile(t, { accessToken, expectedWorkspaceId: workspaceId, owner: OWNER }),
      profile(t, { accessToken, expectedWorkspaceId: workspaceId, owner: OWNER }),
    ]);
    expect(one.profileId).toBe(two.profileId);
    await drainScheduled(t);
    expect((await rows(t)).map((r) => r.profileId)).toEqual([one.profileId]);
  });
});

describe("a group chat's browser profile", () => {
  async function group(t: TestConvex) {
    const owner = await createUser(t, "ada@example.invalid");
    const member = await createUser(t, "bob@example.invalid");
    const team = await createWorkspace(t, owner, "northwind", { kind: "shared" });
    await addMember(t, team, member, "member");
    return { owner, team, accessToken: await grant(t, team, member) };
  }

  test("is filed under the chat's shared workspace, and a member may use it", async () => {
    const t = setupTest();
    const { team, accessToken } = await group(t);
    expect(await profile(t, { accessToken, expectedWorkspaceId: team, owner: GROUP, chat: CHAT })).toEqual({ profileId: "ctx-00000001", created: true });
    expect(await profile(t, { accessToken, expectedWorkspaceId: team, owner: GROUP })).toEqual({ profileId: null });
  });

  test("the chat's people changing releases its old profile", async () => {
    const t = setupTest();
    const { team, accessToken } = await group(t);
    await profile(t, { accessToken, expectedWorkspaceId: team, owner: GROUP, chat: CHAT });
    expect(await profile(t, { accessToken, expectedWorkspaceId: team, owner: "d".repeat(64), chat: CHAT })).toEqual({ profileId: "ctx-00000002", created: true });
    await drainScheduled(t);
    expect(deletes()).toEqual(["ctx-00000001"]);
  });

  test("deleting the workspace deletes the chat's profile at Browserbase", async () => {
    const t = setupTest();
    const { owner, team, accessToken } = await group(t);
    await profile(t, { accessToken, expectedWorkspaceId: team, owner: GROUP, chat: CHAT });
    await asUser(t, owner).mutation(api.functions.account.deleteWorkspace, { workspaceId: team, confirmSlug: "northwind" });
    await drainScheduled(t);
    expect(deletes()).toEqual(["ctx-00000001"]);
    expect(await rows(t)).toEqual([]);
  });
});

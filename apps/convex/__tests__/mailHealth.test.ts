import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { hashToken } from "../functions/lib/crypto";
import { STALE_AFTER_MS, STORE_FULL_CODE, TELL_AGAIN_AFTER_MS, mailboxState } from "../functions/lib/mailHealth/model";
import {
  addMember,
  asUser,
  createUser,
  createWorkspace,
  gatewayPost,
  responseFingerprint,
  seedGoogleConnection,
  setupTest,
} from "./fixtures.helpers";

/**
 * WHETHER A PERSON'S MAILBOXES ARE WORKING, AND WHO IS TOLD.
 *
 * Through the real `/gateway/mail-health` and `/gateway/mail-health/raised`
 * routes, and the real `/agent-texts/heartbeats/due` and `/result` that carry
 * a check-in. Only the owner of a personal workspace reads its mailboxes; a
 * check-in tells them about one mailbox's state at most once a day, and only
 * once its text reached them.
 */
/*
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted (2026-10-20).
 *
 *   `mailboxState` ignoring `STALE_AFTER_MS` (stale never returned)
 *     → "a mailbox with no successful pass for six hours is stale" fails
 *   `mailboxState` reading `health: "error"` as `needs_reconnect`
 *     → "a rate-limited mailbox is recovering, and nobody is told" fails
 *   `clearOwner` without the `personalWorkspaceOf` check
 *     → "an owner's grant on a shared workspace reads nothing" fails
 *     (it is also what refuses a member: a role check beside it never failed
 *     a test on its own, so it was taken out rather than kept unchecked)
 *   `clearOwner` without the `context:private` check
 *     → "a grant without private scope, a dead token and a wrong workspace all get the same answer" fails
 *   `clearOwner` reading the grant's own workspace instead of the one asked about
 *     → "another tenant reads nothing of theirs" fails
 *   `recordHeartbeatResultHandler` turning raised into told on any outcome
 *     → "a check-in that stayed quiet has told them nothing" fails
 *   `raiseMailNoticesHandler` without the check-in client check
 *     → "only the check-in's own grant raises" fails
 */

vi.setConfig({ testTimeout: 20_000 });

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const PHONE = "+15555550100";
const MCP_CLIENT = "mcp_client_mail_health";
const OWNER_SCOPES = ["context:read", "context:write", "context:private"];
const HOUR = 60 * 60 * 1000;

type T = ReturnType<typeof setupTest>;
type Mailbox = { address: string; state: string; lastSyncedAt: number | null; tell: boolean };

afterEach(() => {
  vi.useRealTimers();
});

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
}

async function person(t: T, slug = "ada", options: { phone?: boolean } = {}) {
  const userId = await createUser(t, `${slug}@example.invalid`);
  const workspaceId = await createWorkspace(t, userId, slug, { kind: "personal" });
  if (options.phone === true) {
    const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone: PHONE });
    await agentPost(t, "/agent-texts/link", { phone: PHONE, code });
  }
  return { userId, workspaceId };
}

async function grant(t: T, workspaceId: Id<"workspaces">, userId: Id<"users">, scopes = OWNER_SCOPES) {
  const accessToken = `cat_mailhealth_${Math.random().toString(16).slice(2)}${"0".repeat(16)}`;
  const hashedAccessToken = await hashToken(accessToken);
  await t.run(async (ctx) => {
    const known = await ctx.db
      .query("oauthClients")
      .withIndex("by_clientId", (q) => q.eq("clientId", MCP_CLIENT))
      .unique();
    if (known === null) {
      await ctx.db.insert("oauthClients", {
        clientId: MCP_CLIENT,
        clientName: "Mail health test client",
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
      scopes,
      hashedAccessToken,
      hashedRefreshToken: `refresh_${hashedAccessToken}`,
      accessTokenExpiresAt: Date.now() + HOUR,
      status: "active",
      createdAt: Date.now(),
    });
  });
  return accessToken;
}

async function mailbox(
  t: T,
  workspaceId: Id<"workspaces">,
  boundBy: Id<"users">,
  address: string,
  patch: (row: Doc<"googleConnections">) => Partial<Doc<"googleConnections">> = () => ({}),
) {
  const id = await seedGoogleConnection(t, { workspaceId, boundBy, address });
  await t.run(async (ctx) => {
    const row = (await ctx.db.get(id))!;
    await ctx.db.patch(id, { gmail: { ...row.gmail!, lastSyncedAt: Date.now() - 60_000 }, ...patch(row) });
  });
  return id;
}

async function readHealth(t: T, accessToken: string, workspaceId: string) {
  const response = await gatewayPost(t, "/gateway/mail-health", { accessToken, expectedWorkspaceId: workspaceId });
  expect(response.status).toBe(200);
  return ((await response.json()) as { mailboxes: Mailbox[] | null }).mailboxes;
}

async function raise(t: T, accessToken: string, workspaceId: string, mailboxes: Array<{ address: string; state: string }>) {
  const response = await gatewayPost(t, "/gateway/mail-health/raised", { accessToken, expectedWorkspaceId: workspaceId, mailboxes });
  return ((await response.json()) as { raised: number }).raised;
}

async function checkIn(t: T, userId: Id<"users">) {
  // A text arms the row; the clock reaching a slot makes it due.
  await agentPost(t, "/agent-texts/session", { phone: PHONE });
  const beat = await t.run((ctx) =>
    ctx.db
      .query("texHeartbeats")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first(),
  );
  await t.run((ctx) => ctx.db.patch(beat!._id, { nextBeatAt: Date.now() - 1000, lastOutcome: undefined }));
  const { body } = await agentPost(t, "/agent-texts/heartbeats/due", {});
  const beats = body.heartbeats as Array<{ runId: string; accessToken: string; attention: boolean }>;
  expect(beats).toHaveLength(1);
  return beats[0]!;
}

async function result(t: T, runId: string, outcome: string) {
  return await agentPost(t, "/agent-texts/heartbeats/result", { runId, outcome });
}

describe("a mailbox's state", () => {
  const now = Date.UTC(2026, 9, 20, 12, 0);
  const base = {
    products: ["gmail"] as Array<"gmail">,
    health: "active" as const,
    createdAt: now - 30 * 24 * HOUR,
    gmail: { quotaBytes: 1_000, lastSyncedAt: now - 10 * 60_000 } as Doc<"googleConnections">["gmail"],
  };

  test("a mailbox that synced lately is ok", () => {
    expect(mailboxState(base, now)).toEqual({ state: "ok", lastSyncedAt: now - 10 * 60_000 });
  });

  test("a rate-limited mailbox is recovering, and nobody is told", () => {
    const limited = { ...base, health: "error" as const, gmail: { ...base.gmail!, lastFailureCode: "GMAIL_RATE_LIMITED", retryAt: now + 60_000 } };
    expect(mailboxState(limited, now)!.state).toBe("recovering");
  });

  test("a mailbox with no successful pass for six hours is stale, however it is failing", () => {
    const old = now - STALE_AFTER_MS - 60_000;
    expect(mailboxState({ ...base, gmail: { ...base.gmail!, lastSyncedAt: old } }, now)!.state).toBe("stale");
    expect(
      mailboxState({ ...base, health: "error" as const, gmail: { ...base.gmail!, lastSyncedAt: old, lastFailureCode: "GMAIL_RATE_LIMITED" } }, now)!.state,
    ).toBe("stale");
  });

  test("a mailbox Google wants signed in again needs reconnecting, before anything else", () => {
    const old = now - STALE_AFTER_MS - 60_000;
    expect(mailboxState({ ...base, health: "reconnect_required" as const, gmail: { ...base.gmail!, lastSyncedAt: old } }, now)!.state).toBe(
      "needs_reconnect",
    );
  });

  test("a mailbox at its storage ceiling is full, by the pass's code or by the count", () => {
    expect(mailboxState({ ...base, gmail: { ...base.gmail!, lastFailureCode: STORE_FULL_CODE } }, now)!.state).toBe("store_full");
    expect(mailboxState({ ...base, syncBytesWritten: 1_000 }, now)!.state).toBe("store_full");
  });

  test("a new mailbox that has not read mail yet is not stale; one connected hours ago is", () => {
    const fresh = { ...base, createdAt: now - HOUR, gmail: { ...base.gmail!, lastSyncedAt: undefined } };
    expect(mailboxState(fresh, now)).toEqual({ state: "ok", lastSyncedAt: null });
    expect(mailboxState({ ...fresh, createdAt: now - STALE_AFTER_MS - 1 }, now)!.state).toBe("stale");
  });

  test("a disconnected mailbox, or an account without Gmail, is not listed", () => {
    expect(mailboxState({ ...base, disconnectedAt: now - HOUR }, now)).toBeNull();
    expect(mailboxState({ ...base, products: [], gmail: undefined }, now)).toBeNull();
  });
});

describe("who reads a person's mailboxes", () => {
  test("the owner of the personal workspace: each mailbox, its state, when it last synced, and whether to tell", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    await mailbox(t, workspaceId, userId, "ada@example.invalid");
    await mailbox(t, workspaceId, userId, "ada.work@example.invalid", () => ({ health: "reconnect_required" }));
    await mailbox(t, workspaceId, userId, "old@example.invalid", () => ({ disconnectedAt: Date.now() }));
    const token = await grant(t, workspaceId, userId);
    const mailboxes = await readHealth(t, token, workspaceId);
    expect(mailboxes!.map(({ address, state, tell }) => ({ address, state, tell }))).toEqual([
      { address: "ada.work@example.invalid", state: "needs_reconnect", tell: true },
      { address: "ada@example.invalid", state: "ok", tell: false },
    ]);
    expect(typeof mailboxes![1]!.lastSyncedAt).toBe("number");
  });

  test("another tenant reads nothing of theirs, and is told only of its own", async () => {
    const t = setupTest();
    const ada = await person(t, "ada");
    const eve = await person(t, "eve");
    await mailbox(t, ada.workspaceId, ada.userId, "ada@example.invalid");
    await mailbox(t, eve.workspaceId, eve.userId, "eve@example.invalid");
    const eveToken = await grant(t, eve.workspaceId, eve.userId);
    expect(await readHealth(t, eveToken, ada.workspaceId)).toBeNull();
    expect((await readHealth(t, eveToken, eve.workspaceId))!.map((m) => m.address)).toEqual(["eve@example.invalid"]);
  });

  test("a member's grant on the owner's workspace reads nothing", async () => {
    const t = setupTest();
    const ada = await person(t, "ada");
    await mailbox(t, ada.workspaceId, ada.userId, "ada@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");
    await addMember(t, ada.workspaceId, bob, "member");
    const bobToken = await grant(t, ada.workspaceId, bob);
    expect(await readHealth(t, bobToken, ada.workspaceId)).toBeNull();
  });

  test("an owner's grant on a shared workspace reads nothing", async () => {
    const t = setupTest();
    const ada = await person(t, "ada");
    const shared = await createWorkspace(t, ada.userId, "team-ada", { kind: "shared" });
    await mailbox(t, shared, ada.userId, "team@example.invalid");
    expect(await readHealth(t, await grant(t, shared, ada.userId), shared)).toBeNull();
  });

  test("a grant without private scope, a dead token and a wrong workspace all get the same answer", async () => {
    const t = setupTest();
    const ada = await person(t, "ada");
    await mailbox(t, ada.workspaceId, ada.userId, "ada@example.invalid");
    const narrow = await grant(t, ada.workspaceId, ada.userId, ["context:read"]);
    const owner = await grant(t, ada.workspaceId, ada.userId);
    const other = await person(t, "eve");
    const answers = await Promise.all([
      gatewayPost(t, "/gateway/mail-health", { accessToken: narrow, expectedWorkspaceId: ada.workspaceId }),
      gatewayPost(t, "/gateway/mail-health", { accessToken: "cat_not_a_live_token_0000000000000000", expectedWorkspaceId: ada.workspaceId }),
      gatewayPost(t, "/gateway/mail-health", { accessToken: owner, expectedWorkspaceId: other.workspaceId }),
    ]);
    const prints = await Promise.all(answers.map(responseFingerprint));
    expect(new Set(prints).size).toBe(1);
    expect(prints[0]).toContain('"mailboxes":null');
  });

  test("without the gateway's secret, nothing", async () => {
    const t = setupTest();
    const ada = await person(t, "ada");
    const token = await grant(t, ada.workspaceId, ada.userId);
    const response = await gatewayPost(t, "/gateway/mail-health", { accessToken: token, expectedWorkspaceId: ada.workspaceId }, { secret: "wrong" });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("a check-in tells them once a day", () => {
  async function broken(t: T) {
    const ada = await person(t, "ada", { phone: true });
    const id = await mailbox(t, ada.workspaceId, ada.userId, "ada@example.invalid", () => ({ health: "reconnect_required" }));
    const owner = await grant(t, ada.workspaceId, ada.userId);
    return { ...ada, id, owner };
  }

  test("raised by a check-in that texted, it is not owed again that day", async () => {
    const t = setupTest();
    const ada = await broken(t);
    const beat = await checkIn(t, ada.userId);
    expect(await raise(t, beat.accessToken, ada.workspaceId, [{ address: "ada@example.invalid", state: "needs_reconnect" }])).toBe(1);
    // Raised is not told: still owed while the text has not gone.
    expect((await readHealth(t, ada.owner, ada.workspaceId))![0]!.tell).toBe(true);
    await result(t, beat.runId, "texted");
    const after = await readHealth(t, ada.owner, ada.workspaceId);
    expect(after![0]).toMatchObject({ state: "needs_reconnect", tell: false });
  });

  test("a check-in that stayed quiet has told them nothing", async () => {
    const t = setupTest();
    const ada = await broken(t);
    const beat = await checkIn(t, ada.userId);
    await raise(t, beat.accessToken, ada.workspaceId, [{ address: "ada@example.invalid", state: "needs_reconnect" }]);
    await result(t, beat.runId, "quiet");
    expect((await readHealth(t, ada.owner, ada.workspaceId))![0]!.tell).toBe(true);
    const row = await t.run((ctx) => ctx.db.query("texHeartbeats").first());
    expect(row!.mailRaising).toBeUndefined();
  });

  test("a day later, or in a new state, it is owed again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t = setupTest();
    const ada = await broken(t);
    const beat = await checkIn(t, ada.userId);
    await raise(t, beat.accessToken, ada.workspaceId, [{ address: "ada@example.invalid", state: "needs_reconnect" }]);
    await result(t, beat.runId, "texted");
    expect((await readHealth(t, ada.owner, ada.workspaceId))![0]!.tell).toBe(false);
    // Reconnected, then full: a new state is news.
    await t.run((ctx) => ctx.db.patch(ada.id, { health: "active", syncBytesWritten: 2_000_000_000 }));
    expect((await readHealth(t, ada.owner, ada.workspaceId))![0]).toMatchObject({ state: "store_full", tell: true });
    // Back to the old state, and a day on: owed again.
    await t.run((ctx) => ctx.db.patch(ada.id, { health: "reconnect_required", syncBytesWritten: 0 }));
    expect((await readHealth(t, ada.owner, ada.workspaceId))![0]!.tell).toBe(false);
    vi.setSystemTime(Date.now() + TELL_AGAIN_AFTER_MS + 60_000);
    const later = await grant(t, ada.workspaceId, ada.userId);
    expect((await readHealth(t, later, ada.workspaceId))![0]!.tell).toBe(true);
  });

  test("only the check-in's own grant raises, only while it runs, and only what is owed", async () => {
    const t = setupTest();
    const ada = await broken(t);
    await mailbox(t, ada.workspaceId, ada.userId, "fine@example.invalid");
    const named = [
      { address: "ada@example.invalid", state: "needs_reconnect" },
      { address: "fine@example.invalid", state: "ok" },
      { address: "ada@example.invalid", state: "stale" },
    ];
    // Not running yet, and the owner's ordinary agent: nothing.
    expect(await raise(t, ada.owner, ada.workspaceId, named)).toBe(0);
    const beat = await checkIn(t, ada.userId);
    expect(await raise(t, ada.owner, ada.workspaceId, named)).toBe(0);
    expect(await raise(t, beat.accessToken, ada.workspaceId, named)).toBe(1);
    await result(t, beat.runId, "texted");
    // The run is over: its grant raises nothing more.
    expect(await raise(t, beat.accessToken, ada.workspaceId, named)).toBe(0);
  });
});

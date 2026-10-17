import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "../functions/lib/crypto";
import { DREAMS_CLIENT_ID } from "../functions/lib/dreams/model";
import { DREAM_NOW_WINDOW_MS } from "../functions/lib/dreams/now";
import { TEXTS_CLIENT_ID } from "../functions/textLinks";
import { addMember, asUser, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";

/**
 * A DREAM NOW, ASKED FOR BY THE PERSON'S OWN AGENT.
 *
 * Through the real `/gateway/dreams/start` route, then the real
 * `/agent-texts/dreams/due` that hands it out. Owner-only on their personal
 * workspace, the same Premium gate as the dream's turn, never two at once,
 * at most once per window, audited with the acting client.
 */
/*
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `gate(...)` check removed from `requestDreamNowHandler`
 *     → "a workspace that is not Premium is told so, and nothing is armed" and
 *       "the built-in model switched off is unavailable" fail
 *   the phone-link check removed
 *     → "someone Tex does not text with is not dreamed about" fails
 *   window check removed
 *     → "a second ask inside the window is refused with when to ask again" fails
 *   `underWay` returning false
 *     → "never two at once: …" fails
 *   `personalWorkspaceOf` check removed
 *     → "an owner's grant on a shared workspace may not ask" fails
 *   `session.clientId === DREAMS_CLIENT_ID` check removed
 *     → "a dream's own grant cannot start the next dream" fails
 *   audit's `actorClientId` dropped
 *     → "a Premium owner's ask is armed now, audited…" and "Tex's own texting
 *       grant may ask" fail
 */

vi.setConfig({ testTimeout: 20_000 });

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const PHONE = "+15555550100";
const MCP_CLIENT = "mcp_client_dream_now";
const OWNER_SCOPES = ["context:read", "context:write", "context:private"];

type T = ReturnType<typeof setupTest>;
type Dream = { runId: string; accessToken: string; since: number | null };

afterEach(() => {
  vi.useRealTimers();
});

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify(body),
  });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function premium(t: T, workspaceId: Id<"workspaces">) {
  const now = Date.now();
  await t.run((ctx) =>
    ctx.db.insert("workspacePlans", {
      workspaceId,
      managedStorage: false,
      fastSearch: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }),
  );
}

/** A person with a linked phone and a personal workspace, Premium unless asked otherwise. */
async function person(t: T, slug = "ada", options: { premium?: boolean; phone?: boolean } = {}) {
  const userId = await createUser(t, `${slug}@example.invalid`);
  const workspaceId = await createWorkspace(t, userId, slug, { kind: "personal" });
  if (options.phone !== false) {
    const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone: PHONE });
    await agentPost(t, "/agent-texts/link", { phone: PHONE, code });
  }
  if (options.premium !== false) await premium(t, workspaceId);
  return { userId, workspaceId };
}

/** A live MCP grant with a known access token. */
async function grant(
  t: T,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
  clientId = MCP_CLIENT,
  scopes = OWNER_SCOPES,
) {
  const accessToken = `cat_dream_now_${Math.random().toString(16).slice(2)}${"0".repeat(16)}`;
  const hashedAccessToken = await hashToken(accessToken);
  await t.run(async (ctx) => {
    const known = await ctx.db
      .query("oauthClients")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .unique();
    if (known !== null) return;
    await ctx.db.insert("oauthClients", {
      clientId,
      clientName: "Dream now test client",
      redirectUris: [],
      hashedClientSecret: null,
      tokenEndpointAuthMethod: "none",
      grantTypes: [],
      responseTypes: [],
      createdAt: Date.now(),
    });
  });
  await t.run((ctx) =>
    ctx.db.insert("oauthGrants", {
      workspaceId,
      userId,
      clientId,
      scopes,
      hashedAccessToken,
      hashedRefreshToken: `refresh_${hashedAccessToken}`,
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
      status: "active",
      createdAt: Date.now(),
    }),
  );
  return accessToken;
}

async function ask(t: T, accessToken: string, expectedWorkspaceId: string) {
  const response = await gatewayPost(t, "/gateway/dreams/start", { accessToken, expectedWorkspaceId });
  expect(response.status).toBe(200);
  return ((await response.json()) as { dream: Record<string, unknown> | null }).dream;
}

async function due(t: T): Promise<Dream[]> {
  return (await agentPost(t, "/agent-texts/dreams/due", {})).dreams as Dream[];
}

async function row(t: T, userId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db
      .query("texDreams")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first(),
  );
}

async function requested(t: T, workspaceId: Id<"workspaces">) {
  const events = await t.run((ctx) =>
    ctx.db
      .query("auditEvents")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect(),
  );
  return events.filter((event) => event.action === "dream.requested");
}

describe("asking", () => {
  test("a Premium owner's ask is armed now, audited with the acting client, and handed out as a first dream", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    const token = await grant(t, workspaceId, userId);
    expect(await ask(t, token, workspaceId)).toEqual({ status: "started" });

    const armed = await row(t, userId);
    expect(armed!.nextDreamAt!).toBeLessThanOrEqual(Date.now());
    const audit = await requested(t, workspaceId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: userId, actorClientId: MCP_CLIENT });

    const dreams = await due(t);
    expect(dreams).toHaveLength(1);
    expect(dreams[0]!.since).toBeNull();
    const grants = await t.run((ctx) => ctx.db.query("oauthGrants").collect());
    expect(grants.find((g) => g.clientId === DREAMS_CLIENT_ID)).toMatchObject({ workspaceId, userId });
  });

  test("Tex's own texting grant may ask: onboarding is a text", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    const opened = await agentPost(t, "/agent-texts/session", { phone: PHONE });
    expect(await ask(t, opened.accessToken as string, workspaceId)).toEqual({ status: "started" });
    expect((await requested(t, workspaceId))[0]).toMatchObject({ actorUserId: userId, actorClientId: TEXTS_CLIENT_ID });
  });

  test("a founding account is Premium, so it may ask", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t, "fiona", { premium: false });
    await t.mutation(internal.functions.foundingPremium.catchUp, {});
    const token = await grant(t, workspaceId, userId);
    expect(await ask(t, token, workspaceId)).toEqual({ status: "started" });
  });
});

describe("the gate", () => {
  test("a workspace that is not Premium is told so, and nothing is armed", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t, "ada", { premium: false });
    const token = await grant(t, workspaceId, userId);
    expect(await ask(t, token, workspaceId)).toEqual({ status: "needs_premium" });
    expect(await row(t, userId)).toBeNull();
    expect(await requested(t, workspaceId)).toEqual([]);
  });

  test("the built-in model switched off is unavailable", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    await t.run((ctx) => ctx.db.insert("jevSwitches", { feature: "assistant", off: true, updatedAt: Date.now() }));
    const token = await grant(t, workspaceId, userId);
    expect(await ask(t, token, workspaceId)).toEqual({ status: "unavailable" });
    expect(await row(t, userId)).toBeNull();
  });

  test("someone Tex does not text with is not dreamed about", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t, "ada", { phone: false });
    const token = await grant(t, workspaceId, userId);
    expect(await ask(t, token, workspaceId)).toEqual({ status: "not_texting" });
    expect(await row(t, userId)).toBeNull();
  });
});

describe("how often", () => {
  test("never two at once: one due, or one handed out and not finished, is running", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    const token = await grant(t, workspaceId, userId);
    await ask(t, token, workspaceId);
    // Past the window, so only the dream under way can refuse.
    const pastWindow = async () => {
      const current = await row(t, userId);
      await t.run((ctx) => ctx.db.patch(current!._id, { askedAt: Date.now() - DREAM_NOW_WINDOW_MS - 1 }));
    };
    await pastWindow();
    expect(await ask(t, token, workspaceId)).toEqual({ status: "running" });
    expect(await due(t)).toHaveLength(1);
    await pastWindow();
    expect(await ask(t, token, workspaceId)).toEqual({ status: "running" });
    expect(await requested(t, workspaceId)).toHaveLength(1);
  });

  test("a second ask inside the window is refused with when to ask again, and allowed after it", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    const token = await grant(t, workspaceId, userId);
    await ask(t, token, workspaceId);
    const [dream] = await due(t);
    await agentPost(t, "/agent-texts/dreams/result", { runId: dream!.runId, outcome: "dreamed" });

    const askedAt = (await row(t, userId))!.askedAt!;
    expect(await ask(t, token, workspaceId)).toEqual({ status: "recent", retryAt: askedAt + DREAM_NOW_WINDOW_MS });
    expect((await row(t, userId))!.nextDreamAt).toBeNull();

    const current = await row(t, userId);
    await t.run((ctx) => ctx.db.patch(current!._id, { askedAt: Date.now() - DREAM_NOW_WINDOW_MS - 1 }));
    expect(await ask(t, token, workspaceId)).toEqual({ status: "started" });
    expect(await requested(t, workspaceId)).toHaveLength(2);
  });
});

describe("who may ask", () => {
  test("a member of someone's personal workspace may not, and learns only null", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    const guest = await createUser(t, "guest@example.invalid");
    await addMember(t, workspaceId, guest, "editor");
    const token = await grant(t, workspaceId, guest);
    expect(await ask(t, token, workspaceId)).toBeNull();
    expect(await row(t, userId)).toBeNull();
  });

  test("an owner's grant on a shared workspace may not ask", async () => {
    const t = setupTest();
    const { userId } = await person(t);
    const shared = await createWorkspace(t, userId, "ada-crew", { kind: "shared" });
    await premium(t, shared);
    const token = await grant(t, shared, userId);
    expect(await ask(t, token, shared)).toBeNull();
    expect(await row(t, userId)).toBeNull();
  });

  test("a read-only grant, or one without private reach, may not ask", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    for (const scopes of [["context:read"], ["context:read", "context:write"]]) {
      const token = await grant(t, workspaceId, userId, MCP_CLIENT, scopes);
      expect(await ask(t, token, workspaceId)).toBeNull();
    }
    expect(await row(t, userId)).toBeNull();
  });

  test("a dream's own grant cannot start the next dream", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    const token = await grant(t, workspaceId, userId, DREAMS_CLIENT_ID);
    expect(await ask(t, token, workspaceId)).toBeNull();
  });

  test("an unknown token, a missing field or another workspace's id is null", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    const other = await person(t, "bob", { phone: false });
    const token = await grant(t, workspaceId, userId);
    expect(await ask(t, `cat_${"9".repeat(40)}`, workspaceId)).toBeNull();
    expect(await ask(t, token, other.workspaceId)).toBeNull();
    const response = await gatewayPost(t, "/gateway/dreams/start", { accessToken: token });
    expect(await response.json()).toEqual({ dream: null });
  });

  test("without the gateway's secret nothing runs", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    const token = await grant(t, workspaceId, userId);
    const response = await gatewayPost(t, "/gateway/dreams/start", { accessToken: token, expectedWorkspaceId: workspaceId }, { secret: null });
    expect(response.status).toBe(401);
    expect(await row(t, userId)).toBeNull();
  });
});

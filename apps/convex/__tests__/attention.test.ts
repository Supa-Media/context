import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "../functions/lib/crypto";
import { HEARTBEAT_CLIENT_ID } from "../functions/lib/heartbeats/model";
import {
  ASK_SETTLE_MS,
  DAILY_EMERGENCIES,
  DAILY_PINGS,
  PING_SPACING_MS,
  isQuietHour,
  pingDueAt,
} from "../functions/lib/attention/model";
import { asUser, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";

/**
 * GETTING THE PERSON'S ATTENTION: WHO MAY ASK, HOW OFTEN, WHEN, AND HOW IT
 * REACHES THEM.
 *
 * Through the real `/gateway/attention/ask` route, then the real
 * `/agent-texts/heartbeats/due` and `/result` that deliver it on the person's
 * check-in row. Owner-only on their own personal workspace, a daily limit
 * for ordinary pings and another for emergencies, never at night but an
 * emergency, never moving the check-in's own slot.
 */
/*
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted (2026-10-17).
 *
 *   the `DAILY_PINGS` check removed from `requestAttentionHandler`
 *     → "ordinary pings stop at the day's limit; emergencies have their own" fails
 *   `personalWorkspaceOf` check removed
 *     → "an owner's grant on a shared workspace may not ask" fails
 *   `session.clientId === HEARTBEAT_CLIENT_ID` check removed
 *     → "the check-in's own grant cannot make pings" fails
 *   `pingDueAt` ignoring the night
 *     → "an ordinary ping asked at night waits for 8:00; an emergency does not" fails
 *   the claim moving `nextBeatAt` for an attention claim too
 *     → "a due ping is handed out on the check-in row, flagged, without moving the check-in" fails
 */

vi.setConfig({ testTimeout: 20_000 });

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const PHONE = "+15555550100";
const MCP_CLIENT = "mcp_client_attention";
const OWNER_SCOPES = ["context:read", "context:write", "context:private"];
const ZONE = "America/New_York";

type T = ReturnType<typeof setupTest>;
type Beat = { runId: string; accessToken: string; phones: string[]; attention: boolean };

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
  if (options.phone !== false) {
    const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone: PHONE });
    await agentPost(t, "/agent-texts/link", { phone: PHONE, code });
  }
  return { userId, workspaceId };
}

async function grant(t: T, workspaceId: Id<"workspaces">, userId: Id<"users">, clientId = MCP_CLIENT, scopes = OWNER_SCOPES) {
  const accessToken = `cat_attention_${Math.random().toString(16).slice(2)}${"0".repeat(16)}`;
  const hashedAccessToken = await hashToken(accessToken);
  await t.run(async (ctx) => {
    const known = await ctx.db
      .query("oauthClients")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .unique();
    if (known === null) {
      await ctx.db.insert("oauthClients", {
        clientId,
        clientName: "Attention test client",
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
      clientId,
      scopes,
      hashedAccessToken,
      hashedRefreshToken: `refresh_${hashedAccessToken}`,
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
      status: "active",
      createdAt: Date.now(),
    });
  });
  return accessToken;
}

async function ask(t: T, accessToken: string, workspaceId: string, urgency: string, deliver = true) {
  const response = await gatewayPost(t, "/gateway/attention/ask", { accessToken, expectedWorkspaceId: workspaceId, urgency, deliver });
  return { status: response.status, attention: ((await response.json()) as { attention?: Record<string, unknown> | null }).attention };
}

async function row(t: T, userId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db
      .query("texHeartbeats")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first(),
  );
}

async function makePingsDue(t: T, userId: Id<"users">) {
  const beat = await row(t, userId);
  await t.run((ctx) => ctx.db.patch(beat!._id, { attentionDueAt: Date.now() - 1000 }));
}

async function due(t: T): Promise<Beat[]> {
  const { status, body } = await agentPost(t, "/agent-texts/heartbeats/due", {});
  if (status !== 200) throw new Error(`due answered ${status}`);
  return body.heartbeats as Beat[];
}

async function audits(t: T, workspaceId: Id<"workspaces">, action: string) {
  const events = await t.run((ctx) =>
    ctx.db
      .query("auditEvents")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect(),
  );
  return events.filter((event) => event.action === action);
}

describe("when", () => {
  const noon = Date.UTC(2026, 9, 17, 16, 0); // 12:00 in New York
  const lateNight = Date.UTC(2026, 9, 18, 3, 30); // 23:30 in New York

  test("an ordinary ping by day goes in half a minute, spaced after the last one that reached them", () => {
    expect(isQuietHour(noon, ZONE)).toBe(false);
    expect(pingDueAt("asked", noon, ZONE, undefined)).toBe(noon + ASK_SETTLE_MS);
    expect(pingDueAt("fyi", noon, ZONE, noon - 60_000)).toBe(noon - 60_000 + PING_SPACING_MS);
    expect(pingDueAt("emergency", noon, ZONE, noon - 60_000)).toBe(noon + ASK_SETTLE_MS);
  });

  test("an ordinary ping asked at night waits for 8:00; an emergency does not", () => {
    expect(isQuietHour(lateNight, ZONE)).toBe(true);
    expect(pingDueAt("asked", lateNight, ZONE, undefined)).toBe(Date.UTC(2026, 9, 18, 12, 0)); // 08:00 EDT
    expect(pingDueAt("emergency", lateNight, ZONE, undefined)).toBe(lateNight + ASK_SETTLE_MS);
  });
});

describe("asking", () => {
  test("the owner's own agent may ask: counted, armed on their check-in row, audited with the acting client", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    const token = await grant(t, workspaceId, userId);
    const { status, attention } = await ask(t, token, workspaceId, "emergency");
    expect(status).toBe(200);
    expect(attention).toMatchObject({ status: "soon", timeZone: ZONE });
    expect(attention!.dueAt as number).toBeGreaterThanOrEqual(Date.now());
    const armed = await row(t, userId);
    expect(armed).toMatchObject({ emergencyCount: 1, attentionCount: 0, attentionDueAt: attention!.dueAt });
    expect(armed!.nextBeatAt).not.toBeNull();
    expect((await audits(t, workspaceId, "attention.requested"))[0]).toMatchObject({
      actorUserId: userId,
      actorClientId: MCP_CLIENT,
      details: { urgency: "emergency" },
    });
  });

  test("a ping the person's settings held is answered with their zone, and counts nowhere", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    const token = await grant(t, workspaceId, userId);
    expect((await ask(t, token, workspaceId, "fyi", false)).attention).toEqual({ status: "held", timeZone: ZONE });
    expect(await row(t, userId)).toBeNull();
    expect(await audits(t, workspaceId, "attention.held")).toHaveLength(1);
  });

  test("ordinary pings stop at the day's limit; emergencies have their own", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    const token = await grant(t, workspaceId, userId);
    for (let i = 0; i < DAILY_PINGS; i += 1) {
      expect((await ask(t, token, workspaceId, "asked")).attention!.status).toMatch(/^(soon|later)$/);
    }
    expect((await ask(t, token, workspaceId, "asked")).attention).toEqual({ status: "limit", timeZone: ZONE });
    for (let i = 0; i < DAILY_EMERGENCIES; i += 1) {
      expect((await ask(t, token, workspaceId, "emergency")).attention!.status).toBe("soon");
    }
    expect((await ask(t, token, workspaceId, "emergency")).attention).toEqual({ status: "limit", timeZone: ZONE });
    expect(await row(t, userId)).toMatchObject({ attentionCount: DAILY_PINGS, emergencyCount: DAILY_EMERGENCIES });
  });

  test("the counts start again on a new day in their zone", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    const token = await grant(t, workspaceId, userId);
    await ask(t, token, workspaceId, "asked");
    const beat = await row(t, userId);
    await t.run((ctx) => ctx.db.patch(beat!._id, { attentionDay: "2026-01-01", attentionCount: DAILY_PINGS }));
    expect((await ask(t, token, workspaceId, "asked")).attention!.status).not.toBe("limit");
    expect((await row(t, userId))!.attentionCount).toBe(1);
  });

  test("someone Tex does not text with is told so", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t, "ada", { phone: false });
    const token = await grant(t, workspaceId, userId);
    expect((await ask(t, token, workspaceId, "emergency")).attention).toEqual({ status: "not_texting" });
  });
});

describe("who may not ask", () => {
  test("an owner's grant on a shared workspace may not ask", async () => {
    const t = setupTest();
    const { userId } = await person(t);
    const shared = await createWorkspace(t, userId, "team-space", { kind: "shared" });
    const token = await grant(t, shared, userId);
    expect((await ask(t, token, shared, "emergency")).attention).toBeNull();
  });

  test("a read-only grant, a dead token, or another workspace's id may not ask", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    const readOnly = await grant(t, workspaceId, userId, "mcp_client_ro", ["context:read"]);
    expect((await ask(t, readOnly, workspaceId, "emergency")).attention).toBeNull();
    expect((await ask(t, "cat_nobody_000000000000000000000000", workspaceId, "emergency")).attention).toBeNull();
    const other = await person(t, "bob");
    const token = await grant(t, workspaceId, userId);
    expect((await ask(t, token, other.workspaceId, "emergency")).attention).toBeNull();
  });

  test("the check-in's own grant cannot make pings", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    const token = await grant(t, workspaceId, userId, HEARTBEAT_CLIENT_ID);
    expect((await ask(t, token, workspaceId, "emergency")).attention).toBeNull();
  });

  test("an urgency outside the list, or no deliver flag, is a bad request", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    const token = await grant(t, workspaceId, userId);
    expect((await ask(t, token, workspaceId, "whenever")).status).toBe(400);
    const response = await gatewayPost(t, "/gateway/attention/ask", { accessToken: token, expectedWorkspaceId: workspaceId, urgency: "asked" });
    expect(response.status).toBe(400);
  });
});

describe("delivery", () => {
  test("a due ping is handed out on the check-in row, flagged, without moving the check-in", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    const token = await grant(t, workspaceId, userId);
    await ask(t, token, workspaceId, "emergency");
    expect(await due(t)).toEqual([]); // half a minute to settle
    await makePingsDue(t, userId);
    // The check-in is due too: the pings go first, and the look keeps its turn.
    const slot = Date.now() - 500;
    const armed = await row(t, userId);
    await t.run((ctx) => ctx.db.patch(armed!._id, { nextBeatAt: slot }));
    const beats = await due(t);
    expect(beats).toHaveLength(1);
    expect(beats[0]).toMatchObject({ attention: true, phones: [PHONE] });
    const claimed = await row(t, userId);
    expect(claimed).toMatchObject({ runKind: "attention", attentionDueAt: null, nextBeatAt: slot });
    expect(await audits(t, workspaceId, "attention.run")).toHaveLength(1);

    expect((await agentPost(t, "/agent-texts/heartbeats/result", { runId: beats[0]!.runId, outcome: "texted" })).body).toEqual({ status: "recorded" });
    const after = await row(t, userId);
    expect(after!.attentionTextedAt!).toBeGreaterThan(0);
    expect(after).toMatchObject({ nextBeatAt: slot, attentionDueAt: null });
    expect(after!.lastTextedAt).toBeUndefined();
    expect(after!.lastOutcome).toBeUndefined();
    expect(after!.runKind).toBeUndefined();

    const [look] = await due(t);
    expect(look).toMatchObject({ attention: false });
    expect((await row(t, userId))!.nextBeatAt!).toBeGreaterThan(Date.now());
  });

  test("a failed delivery is tried again a few times, then given up", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    const token = await grant(t, workspaceId, userId);
    await ask(t, token, workspaceId, "emergency");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await makePingsDue(t, userId);
      const [beat] = await due(t);
      expect(beat!.attention).toBe(true);
      await agentPost(t, "/agent-texts/heartbeats/result", { runId: beat!.runId, outcome: "failed" });
      const after = await row(t, userId);
      expect(after!.attentionTries).toBe(attempt);
      if (attempt < 3) expect(after!.attentionDueAt!).toBeGreaterThan(Date.now());
      else expect(after!.attentionDueAt).toBeNull();
    }
  });

  test("a ping for someone who has since unlinked is never sent", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    const token = await grant(t, workspaceId, userId);
    await ask(t, token, workspaceId, "emergency");
    await makePingsDue(t, userId);
    await t.run(async (ctx) => {
      for (const link of await ctx.db.query("phoneLinks").collect()) await ctx.db.delete(link._id);
    });
    expect(await due(t)).toEqual([]);
    expect((await row(t, userId))!.attentionDueAt).toBeNull();
  });
});

import { afterEach, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createUser, createWorkspace, gatewayPost, setupTest, asUser, type TestConvex } from "./fixtures.helpers";
import { JEV_FEATURES } from "../functions/lib/jev/features";
import { utcDay } from "../functions/lib/jev/meter";
import { MEETING_FEATURE } from "../functions/meetingSummary";
import { CONSOLE_CLIENT_ID } from "../functions/agentGrant";

/**
 * MEETING SUMMARIES: THE GATE AND THE METER.
 *
 * "Same for all" (decided by the owner, 2026-10-09): free and Premium workspaces
 * both get summaries; only the daily ceiling differs. Every path is driven
 * through the real `/gateway/meeting-summary` routes with a real grant.
 */

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const PHONE = "+15555550102";
const HAIKU = "anthropic/claude-haiku-5-5";

type T = TestConvex;

afterEach(() => {
  delete process.env.JEV_DISABLED;
});

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify(body),
  });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function owner(t: T, { paying = true, slug = "mira" } = {}) {
  const userId = await createUser(t, `${slug}@example.invalid`);
  const workspaceId = await createWorkspace(t, userId, slug, { kind: "personal" });
  if (paying) {
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("workspacePlans", { workspaceId, managedStorage: false, fastSearch: true, status: "active", createdAt: now, updatedAt: now }),
    );
  }
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone: PHONE });
  await agentPost(t, "/agent-texts/link", { phone: PHONE, code });
  const opened = await agentPost(t, "/agent-texts/session", { phone: PHONE });
  return { userId, workspaceId, accessToken: opened.accessToken as string };
}

async function start(t: T, accessToken: string, expectedWorkspaceId: string | null = null) {
  const response = await gatewayPost(t, "/gateway/meeting-summary", { accessToken, expectedWorkspaceId });
  return (JSON.parse(await response.text()) as { verdict: unknown }).verdict;
}

async function record(t: T, accessToken: string, body: Record<string, unknown>) {
  const response = await gatewayPost(t, "/gateway/meeting-summary/usage", { accessToken, expectedWorkspaceId: null, ...body });
  return (JSON.parse(await response.text()) as { recorded: boolean }).recorded;
}

async function usage(t: T, workspaceId: Id<"workspaces">) {
  return await t.run((ctx) =>
    ctx.db
      .query("jevUsage")
      .withIndex("by_day_feature_workspace", (q) =>
        q.eq("day", utcDay(Date.now())).eq("feature", MEETING_FEATURE).eq("workspaceId", workspaceId),
      )
      .unique(),
  );
}

async function modelRows(t: T, workspaceId: Id<"workspaces">) {
  return await t.run((ctx) =>
    ctx.db
      .query("aiModelUsage")
      .filter((q) => q.and(q.eq(q.field("workspaceId"), workspaceId), q.eq(q.field("feature"), MEETING_FEATURE)))
      .collect(),
  );
}

describe("who may use it", () => {
  test("the feature is registered for everyone, with a cap for each plan", () => {
    expect(MEETING_FEATURE).toBe("meetingSummary");
    expect(JEV_FEATURES.meetingSummary).toMatchObject({ plan: "everyone", dailyCallsPerWorkspace: 50, dailyCallsFree: 10 });
  });

  test("a free workspace may summarise ten meetings a day, then is capped, and says it is not paying", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await owner(t, { paying: false });
    for (let n = 1; n <= 10; n++) {
      expect(await start(t, accessToken)).toEqual({ allowed: true, remaining: 10 - n, paying: false });
    }
    expect(await start(t, accessToken)).toEqual({ allowed: false, reason: "daily_cap", paying: false });
    expect(await usage(t, workspaceId)).toMatchObject({ calls: 10, refused: 1 });
  });

  test("a paying workspace may summarise fifty meetings a day, then is capped, and says it is paying", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await owner(t, { paying: true });
    await t.run((ctx) =>
      ctx.db.insert("jevUsage", {
        day: utcDay(Date.now()), feature: MEETING_FEATURE, workspaceId,
        calls: 49, failed: 0, refused: 0, questions: 0, tokens: 0, costMicroUsd: 0, ms: 0, updatedAt: Date.now(),
      }),
    );
    expect(await start(t, accessToken)).toEqual({ allowed: true, remaining: 0, paying: true });
    expect(await start(t, accessToken)).toEqual({ allowed: false, reason: "daily_cap", paying: true });
  });

  test("the switch turns it off for everyone", async () => {
    const t = setupTest();
    const { accessToken } = await owner(t, { paying: true });
    await t.run((ctx) => ctx.db.insert("jevSwitches", { feature: MEETING_FEATURE, off: true, updatedAt: Date.now() }));
    expect(await start(t, accessToken)).toEqual({ allowed: false, reason: "switched_off", paying: true });
  });

  test("JEV_DISABLED stops it, and the refusal is counted", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await owner(t, { paying: false });
    process.env.JEV_DISABLED = "meetingSummary";
    expect(await start(t, accessToken)).toEqual({ allowed: false, reason: "disabled", paying: false });
    expect(await usage(t, workspaceId)).toMatchObject({ calls: 0, refused: 1 });
  });

  test("an unknown token is null", async () => {
    const t = setupTest();
    await owner(t);
    expect(await start(t, "cat_not-a-real-token")).toBeNull();
  });

  test("an expected workspace the grant does not reach is null", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await owner(t);
    expect(await start(t, accessToken, String(workspaceId))).toEqual({ allowed: true, remaining: 49, paying: true });
    const other = await createUser(t, "bo@example.invalid");
    const otherWorkspace = await createWorkspace(t, other, "bo-studio", { kind: "shared" });
    expect(await start(t, accessToken, String(otherWorkspace))).toBeNull();
  });

  test("any live grant may start one, the console's included, whatever its client", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await owner(t, { paying: false });
    await t.run(async (ctx) => {
      // The console's client row, as registered, then the texting grant moved onto it.
      const client = (await ctx.db.query("oauthClients").collect())[0]!;
      const { _id, _creationTime, ...fields } = client;
      await ctx.db.insert("oauthClients", { ...fields, clientId: CONSOLE_CLIENT_ID });
      for (const grant of await ctx.db.query("oauthGrants").collect()) {
        await ctx.db.patch(grant._id, { clientId: CONSOLE_CLIENT_ID });
      }
    });
    expect(await start(t, accessToken)).toEqual({ allowed: true, remaining: 9, paying: false });
    expect((await usage(t, workspaceId))?.calls).toBe(1);
  });

  test("the route needs the gateway's secret", async () => {
    const t = setupTest();
    const { accessToken } = await owner(t);
    const response = await t.fetch("/gateway/meeting-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
      body: JSON.stringify({ accessToken, expectedWorkspaceId: null }),
    });
    expect(response.status).toBe(401);
  });
});

describe("the meter", () => {
  test("input tokens at Haiku's rate land in both tables", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await owner(t);
    await start(t, accessToken);
    expect(await record(t, accessToken, { model: HAIKU, inputTokens: 1_000_000, outputTokens: 0, failed: false, ms: 900 })).toBe(true);
    const row = await usage(t, workspaceId);
    expect(row).toMatchObject({ calls: 1, tokens: 1_000_000, costMicroUsd: 100_000 });
    const rows = await modelRows(t, workspaceId);
    expect(rows.map((r) => r.model)).toEqual([HAIKU]);
    expect(rows[0]).toMatchObject({ calls: 1, inputTokens: 1_000_000, costMicroUsd: 100_000 });
  });

  test("a report that names no model is priced and recorded as Haiku", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await owner(t);
    await start(t, accessToken);
    expect(await record(t, accessToken, { inputTokens: 1_000_000, outputTokens: 0, failed: false, ms: 10 })).toBe(true);
    expect((await usage(t, workspaceId))?.costMicroUsd).toBe(100_000);
    expect(await modelRows(t, workspaceId)).toEqual([expect.objectContaining({ model: HAIKU, costMicroUsd: 100_000 })]);
  });

  test("the cost in both tables agrees, cache reads and writes included", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await owner(t);
    await start(t, accessToken);
    await record(t, accessToken, {
      model: HAIKU, inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 200_000, failed: false, ms: 1,
    });
    const row = await usage(t, workspaceId);
    expect(row?.costMicroUsd).toBe(100_000 + 50_000 + 10_000 + 25_000);
    const rows = await modelRows(t, workspaceId);
    expect(rows.reduce((sum, r) => sum + r.costMicroUsd, 0)).toBe(row?.costMicroUsd);
  });

  test("a failed meeting moves its call to failed, so the cap still counts it once", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await owner(t, { paying: false });
    await start(t, accessToken);
    expect(await record(t, accessToken, { model: HAIKU, inputTokens: 10, outputTokens: 0, failed: true, ms: 5 })).toBe(true);
    const row = await usage(t, workspaceId);
    expect(row).toMatchObject({ calls: 0, failed: 1 });
    expect((row?.calls ?? 0) + (row?.failed ?? 0)).toBe(1);
    expect(await modelRows(t, workspaceId)).toEqual([expect.objectContaining({ calls: 0, costMicroUsd: 1 })]);
  });

  test("an unknown token records nothing", async () => {
    const t = setupTest();
    const { workspaceId } = await owner(t);
    expect(await record(t, "cat_not-a-real-token", { inputTokens: 5, outputTokens: 5, failed: false, ms: 1 })).toBe(false);
    expect(await usage(t, workspaceId)).toBeNull();
  });
});

describe("the other features keep their plan", () => {
  test("a Premium feature still refuses a free workspace with not_premium", async () => {
    const t = setupTest();
    const { workspaceId } = await owner(t, { paying: false });
    expect(await t.query(internal.functions.jev.gate, { feature: "organizer", workspaceId })).toEqual({ allowed: false, reason: "not_premium" });
    expect(await t.query(internal.functions.jev.gate, { feature: "assistant", workspaceId })).toEqual({ allowed: false, reason: "not_premium" });
  });

  test("the meeting feature gives a free workspace its free cap, not not_premium", async () => {
    const t = setupTest();
    const { workspaceId } = await owner(t, { paying: false });
    expect(await t.query(internal.functions.jev.gate, { feature: MEETING_FEATURE, workspaceId })).toEqual({ allowed: true, remaining: 10 });
  });
});

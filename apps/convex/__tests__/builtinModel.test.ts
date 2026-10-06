import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";
import { asUser } from "./fixtures.helpers";
import { JEV_FEATURES } from "../functions/lib/jev/features";
import { utcDay } from "../functions/lib/jev/meter";
import { BUILTIN_FEATURE } from "../functions/builtinModel";

/**
 * THE BUILT-IN MODEL'S GATE AND METER.
 *
 * "Premium, capped" (decided by the owner, 2026-10-06): a texting grant with no
 * model account of its own may spend ours only on a paying workspace, only up to
 * the daily cap, and only while the switch is on. Every path is driven through
 * the real `/gateway/builtin-model` route with a real texting grant.
 */

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const PHONE = "+15555550100";

type T = ReturnType<typeof setupTest>;

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify(body),
  });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function texter(t: T, { paying = true, slug = "ada" } = {}) {
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

async function ask(t: T, accessToken: string, expectedWorkspaceId: string | null = null) {
  const response = await gatewayPost(t, "/gateway/builtin-model", { accessToken, expectedWorkspaceId });
  return (JSON.parse(await response.text()) as { verdict: unknown }).verdict;
}

async function report(t: T, accessToken: string, body: Record<string, unknown>) {
  const response = await gatewayPost(t, "/gateway/builtin-model/usage", { accessToken, expectedWorkspaceId: null, ...body });
  return (JSON.parse(await response.text()) as { recorded: boolean }).recorded;
}

async function usage(t: T, workspaceId: Id<"workspaces">) {
  return await t.run((ctx) =>
    ctx.db
      .query("jevUsage")
      .withIndex("by_day_feature_workspace", (q) =>
        q.eq("day", utcDay(Date.now())).eq("feature", BUILTIN_FEATURE).eq("workspaceId", workspaceId),
      )
      .unique(),
  );
}

describe("who may use it", () => {
  test("a Premium texter may, and the turn is counted before anything is spent", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t);
    const cap = JEV_FEATURES.assistant.dailyCallsPerWorkspace;
    expect(await ask(t, accessToken)).toEqual({ allowed: true, remaining: cap - 1 });
    expect((await usage(t, workspaceId))?.calls).toBe(1);
  });

  test("a free texter is refused, and the refusal is counted", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t, { paying: false });
    expect(await ask(t, accessToken)).toEqual({ allowed: false, reason: "not_premium" });
    expect((await usage(t, workspaceId))?.refused).toBe(1);
    expect((await usage(t, workspaceId))?.calls).toBe(0);
  });

  test("a grant for any other client is refused, whatever its plan", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t);
    await t.run(async (ctx) => {
      // A second, ordinary client: the same row under another id.
      const client = (await ctx.db.query("oauthClients").collect())[0]!;
      const { _id, _creationTime, ...fields } = client;
      await ctx.db.insert("oauthClients", { ...fields, clientId: "some_mcp_client" });
      const grants = await ctx.db.query("oauthGrants").collect();
      for (const grant of grants) await ctx.db.patch(grant._id, { clientId: "some_mcp_client" });
    });
    expect(await ask(t, accessToken)).toEqual({ allowed: false, reason: "not_texts" });
    expect(await usage(t, workspaceId)).toBeNull();
  });

  test("an unknown token, a malformed body and someone else's workspace are all null", async () => {
    const t = setupTest();
    const { accessToken } = await texter(t);
    const other = await createUser(t, "bo@example.invalid");
    const otherWorkspace = await createWorkspace(t, other, "bo-studio", { kind: "shared" });
    expect(await ask(t, "cat_not-a-real-token")).toBeNull();
    expect(await ask(t, accessToken, otherWorkspace)).toBeNull();
    const malformed = await gatewayPost(t, "/gateway/builtin-model", { accessToken: 42 });
    expect(JSON.parse(await malformed.text())).toEqual({ verdict: null });
  });

  test("the switch turns it off for everyone", async () => {
    const t = setupTest();
    const { accessToken } = await texter(t);
    await t.run((ctx) => ctx.db.insert("jevSwitches", { feature: BUILTIN_FEATURE, off: true, updatedAt: Date.now() }));
    expect(await ask(t, accessToken)).toEqual({ allowed: false, reason: "switched_off" });
  });

  test("the daily cap stops it", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t);
    const cap = JEV_FEATURES.assistant.dailyCallsPerWorkspace;
    await t.run(async (ctx) => {
      const day = utcDay(Date.now());
      await ctx.db.insert("jevUsage", {
        day, feature: BUILTIN_FEATURE, workspaceId,
        calls: cap - 1, failed: 0, refused: 0, questions: 0, tokens: 0, costMicroUsd: 0, ms: 0, updatedAt: Date.now(),
      });
    });
    expect(await ask(t, accessToken)).toEqual({ allowed: true, remaining: 0 });
    expect(await ask(t, accessToken)).toEqual({ allowed: false, reason: "daily_cap" });
  });

  test("the route needs the gateway's secret", async () => {
    const t = setupTest();
    const { accessToken } = await texter(t);
    const response = await t.fetch("/gateway/builtin-model", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
      body: JSON.stringify({ accessToken, expectedWorkspaceId: null }),
    });
    expect(response.status).toBe(401);
  });
});

describe("the meter", () => {
  test("a finished turn's tokens are priced from the model's own counts", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t);
    await ask(t, accessToken);
    expect(await report(t, accessToken, { inputTokens: 1_000_000, outputTokens: 100_000, ms: 900 })).toBe(true);
    const row = await usage(t, workspaceId);
    expect(row?.tokens).toBe(1_100_000);
    // GLM-4.7 Flash: $0.06 in, $0.40 out per million.
    expect(row?.costMicroUsd).toBe(60_000 + 40_000);
    expect(row?.calls).toBe(1);
  });

  test("tokens read by the decision model are priced at its own rate", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t);
    await ask(t, accessToken);
    expect(await report(t, accessToken, { inputTokens: 0, outputTokens: 0, decisionTokens: 1_000_000, ms: 5 })).toBe(true);
    const row = await usage(t, workspaceId);
    expect(row?.tokens).toBe(1_000_000);
    // Clef: $0.24 per million read, not GLM's $0.06.
    expect(row?.costMicroUsd).toBe(240_000);
  });

  test("a failed turn still counts once against the cap", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t);
    await ask(t, accessToken);
    await report(t, accessToken, { inputTokens: 10, outputTokens: 0, failed: true, ms: 5 });
    const row = await usage(t, workspaceId);
    expect((row?.calls ?? 0) + (row?.failed ?? 0)).toBe(1);
    expect(row?.failed).toBe(1);
  });

  test("absurd counts are clamped rather than billed", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t);
    await report(t, accessToken, { inputTokens: 1e15, outputTokens: -5, decisionTokens: 1e15, ms: Number.NaN });
    expect((await usage(t, workspaceId))?.tokens).toBe(4_000_000);
  });

  test("an unknown token records nothing", async () => {
    const t = setupTest();
    const { workspaceId } = await texter(t);
    expect(await report(t, "cat_not-a-real-token", { inputTokens: 5, outputTokens: 5 })).toBe(false);
    expect(await usage(t, workspaceId)).toBeNull();
  });
});

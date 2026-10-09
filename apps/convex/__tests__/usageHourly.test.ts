/**
 * PREMIUM USAGE ANALYTICS: `usageHourly`, `recordHourly`, and the token totals
 * the admin dashboard sees (`docs/decisions/observability/token-usage.md`).
 *
 * Still counters, never content: the hour comes from the clock, the metric,
 * method and model shape from closed lists, and nothing is written for a
 * workspace that is not paying.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  createUser,
  createWorkspace,
  gatewayPost,
  setupTest,
  TEST_GATEWAY_SECRET,
  type TestConvex,
} from "./fixtures.helpers";
import {
  clientFamily,
  HOURLY_RETENTION_DAYS,
  MAX_MODELS_PER_WORKSPACE_DAY,
  MAX_TOKEN_EVENT_COUNT,
  normalizeModel,
} from "../functions/lib/usage";

const AT = Date.parse("2026-10-08T14:30:00.000Z");

async function workspace(t: TestConvex, slug: string, paying: boolean) {
  const owner = await createUser(t, `${slug}@example.com`);
  const workspaceId = await createWorkspace(t, owner, `tu-${slug}`);
  if (paying) {
    await t.run(async (ctx) => {
      await ctx.db.insert("workspacePlans", {
        workspaceId,
        managedStorage: false,
        fastSearch: true,
        status: "active",
        createdAt: AT,
        updatedAt: AT,
      });
    });
  }
  return { owner, workspaceId };
}

async function client(t: TestConvex, clientId: string, clientName: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert("oauthClients", {
      clientId,
      clientName,
      redirectUris: ["https://client.example/cb"],
      hashedClientSecret: null,
      tokenEndpointAuthMethod: "none",
      createdAt: AT,
    } as never);
  });
}

const hourly = (t: TestConvex) =>
  t.run(async (ctx) => await ctx.db.query("usageHourly").collect());
const daily = (t: TestConvex) =>
  t.run(async (ctx) => await ctx.db.query("usageDaily").collect());

function event(
  workspaceId: Id<"workspaces">,
  overrides: Partial<{ metric: string; clientId: string; model: string; method: string; count: number; userId: Id<"users"> }> = {},
) {
  return {
    metric: "mcp.response_tokens",
    workspaceId,
    clientId: "client-claude",
    method: "exact",
    count: 120,
    ...overrides,
  };
}

describe("normalizers", () => {
  test("model shapes are closed; free text is other; absent is unknown", () => {
    expect(normalizeModel("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(normalizeModel("anthropic/claude-haiku-5-5")).toBe("anthropic/claude-haiku-5-5");
    expect(normalizeModel("GPT-5")).toBe("gpt-5");
    expect(normalizeModel("@cf/zai-org/glm-4.7-flash")).toBe("@cf/zai-org/glm-4.7-flash");
    expect(normalizeModel("my secret project notes")).toBe("other");
    expect(normalizeModel("claude-" + "a".repeat(200))).toBe("other");
    expect(normalizeModel(undefined)).toBe("unknown");
    expect(normalizeModel("")).toBe("unknown");
  });

  test("client families", () => {
    expect(clientFamily("Claude Code")).toBe("claude");
    expect(clientFamily("ChatGPT")).toBe("chatgpt");
    expect(clientFamily("OpenAI Codex")).toBe("codex");
    expect(clientFamily("Gemini CLI")).toBe("gemini");
    expect(clientFamily("Cursor")).toBe("other");
    expect(clientFamily(undefined)).toBe("other");
  });
});

describe("recordHourly", () => {
  test("a paying workspace gets an hourly row and a family total", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await workspace(t, "paid", true);
    await client(t, "client-claude", "Claude Code");

    const result = await t.mutation(internal.functions.usage.recordHourly, {
      events: [event(workspaceId, { userId: owner, model: "claude-opus-5-5" })],
      at: AT,
    });
    expect(result).toEqual({ applied: 1 });

    const rows = await hourly(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: "2026-10-08",
      hour: 14,
      workspaceId,
      userId: owner,
      clientId: "client-claude",
      model: "claude-opus-5-5",
      metric: "mcp.response_tokens",
      method: "exact",
      count: 120,
    });
    // No field anything else could travel in.
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["_creationTime", "_id", "clientId", "count", "day", "hour", "method", "metric", "model", "userId", "workspaceId"].sort(),
    );

    const totals = await daily(t);
    expect(totals).toHaveLength(1);
    expect(totals[0]).toMatchObject({ metric: "mcp.response_tokens.claude", count: 120 });
    expect(totals[0].workspaceId).toBeUndefined();
  });

  test("a free workspace writes nothing", async () => {
    const t = setupTest();
    const { workspaceId } = await workspace(t, "free", false);
    const result = await t.mutation(internal.functions.usage.recordHourly, {
      events: [event(workspaceId)],
      at: AT,
    });
    expect(result).toEqual({ applied: 0 });
    expect(await hourly(t)).toHaveLength(0);
    expect(await daily(t)).toHaveLength(0);
  });

  test("a lapsed plan writes nothing", async () => {
    const t = setupTest();
    const { workspaceId } = await workspace(t, "lapsed", true);
    await t.run(async (ctx) => {
      const plan = await ctx.db.query("workspacePlans").first();
      await ctx.db.patch(plan!._id, { status: "canceled" });
    });
    await t.mutation(internal.functions.usage.recordHourly, { events: [event(workspaceId)], at: AT });
    expect(await hourly(t)).toHaveLength(0);
  });

  test("repeat reports increment one row; concurrent reports lose nothing", async () => {
    const t = setupTest();
    const { workspaceId } = await workspace(t, "inc", true);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        t.mutation(internal.functions.usage.recordHourly, {
          events: [event(workspaceId, { count: 10 })],
          at: AT,
        }),
      ),
    );
    const rows = await hourly(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(80);
  });

  test("unknown metric, unknown method, zero and negative counts are dropped", async () => {
    const t = setupTest();
    const { workspaceId } = await workspace(t, "drop", true);
    const result = await t.mutation(internal.functions.usage.recordHourly, {
      events: [
        event(workspaceId, { metric: "note.title:secret" }),
        event(workspaceId, { method: "guess" }),
        event(workspaceId, { count: 0 }),
        event(workspaceId, { count: -5 }),
        event(workspaceId, { count: Number.NaN }),
        event(workspaceId, { clientId: "" }),
      ],
      at: AT,
    });
    expect(result).toEqual({ applied: 0 });
    expect(await hourly(t)).toHaveLength(0);
  });

  test("token counts are capped by their own limit, far above the 1,000 event cap", async () => {
    const t = setupTest();
    const { workspaceId } = await workspace(t, "cap", true);
    await t.mutation(internal.functions.usage.recordHourly, {
      events: [
        event(workspaceId, { count: 50_000 }),
        event(workspaceId, { metric: "mcp.request_tokens", count: Number.MAX_SAFE_INTEGER }),
      ],
      at: AT,
    });
    const rows = await hourly(t);
    const byMetric = Object.fromEntries(rows.map((row) => [row.metric, row.count]));
    expect(byMetric["mcp.response_tokens"]).toBe(50_000);
    expect(byMetric["mcp.request_tokens"]).toBe(MAX_TOKEN_EVENT_COUNT);
  });

  test("a workspace cannot mint unbounded model rows in a day", async () => {
    const t = setupTest();
    const { workspaceId } = await workspace(t, "models", true);
    for (let i = 0; i < MAX_MODELS_PER_WORKSPACE_DAY + 5; i += 1) {
      await t.mutation(internal.functions.usage.recordHourly, {
        events: [event(workspaceId, { model: `claude-junk-${i}` })],
        at: AT,
      });
    }
    const models = new Set((await hourly(t)).map((row) => row.model));
    expect(models.size).toBe(MAX_MODELS_PER_WORKSPACE_DAY + 1);
    expect(models.has("other")).toBe(true);
  });

  test("each workspace is gated and attributed on its own", async () => {
    const t = setupTest();
    const paid = await workspace(t, "mine", true);
    const free = await workspace(t, "theirs", false);
    await t.mutation(internal.functions.usage.recordHourly, {
      events: [event(paid.workspaceId), event(free.workspaceId)],
      at: AT,
    });
    const rows = await hourly(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBe(paid.workspaceId);
  });

  test("non-token metrics do not touch the family totals", async () => {
    const t = setupTest();
    const { workspaceId } = await workspace(t, "counts", true);
    await t.mutation(internal.functions.usage.recordHourly, {
      events: [
        event(workspaceId, { metric: "mcp.calls", method: "count", count: 1 }),
        event(workspaceId, { metric: "note.write", method: "count", count: 1 }),
      ],
      at: AT,
    });
    expect(await hourly(t)).toHaveLength(2);
    expect(await daily(t)).toHaveLength(0);
  });
});

describe("retention and deletion", () => {
  test("rows past retention are pruned; recent ones stay", async () => {
    const t = setupTest();
    const { workspaceId } = await workspace(t, "prune", true);
    const old = AT - (HOURLY_RETENTION_DAYS + 1) * 86_400_000;
    await t.mutation(internal.functions.usage.recordHourly, { events: [event(workspaceId)], at: old });
    await t.mutation(internal.functions.usage.recordHourly, { events: [event(workspaceId)], at: AT });
    const result = await t.mutation(internal.functions.usage.pruneHourly, { at: AT });
    expect(result).toEqual({ deleted: 1 });
    const rows = await hourly(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].day).toBe("2026-10-08");
  });

  test("purging a workspace removes only its rows", async () => {
    const t = setupTest();
    const a = await workspace(t, "gone", true);
    const b = await workspace(t, "kept", true);
    await t.mutation(internal.functions.usage.recordHourly, {
      events: [event(a.workspaceId), event(b.workspaceId)],
      at: AT,
    });
    await t.mutation(internal.functions.usage.purgeWorkspaceHourly, { workspaceId: a.workspaceId });
    const rows = await hourly(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBe(b.workspaceId);
  });
});

describe("the gateway route", () => {
  test("hourly events ride the existing route; old-shape bodies still work", async () => {
    const t = setupTest();
    process.env.GATEWAY_SECRET = TEST_GATEWAY_SECRET;
    const { workspaceId } = await workspace(t, "route", true);

    const legacy = await gatewayPost(t, "/gateway/usage", {
      events: [{ metric: "mcp.tool_call", workspaceId }],
    });
    expect(await legacy.json()).toEqual({ applied: 1 });

    const both = await gatewayPost(t, "/gateway/usage", {
      events: [{ metric: "mcp.tool_call", workspaceId }],
      hourly: [event(workspaceId), { metric: "mcp.calls" }, "junk", null],
    });
    expect(both.status).toBe(200);
    expect(await both.json()).toEqual({ applied: 2 });
    expect(await hourly(t)).toHaveLength(1);
  });

  test("a malformed workspace id in hourly is answered 200", async () => {
    const t = setupTest();
    process.env.GATEWAY_SECRET = TEST_GATEWAY_SECRET;
    const response = await gatewayPost(t, "/gateway/usage", {
      hourly: [{ ...event("not-an-id" as Id<"workspaces">) }],
    });
    expect(response.status).toBe(200);
    expect(await hourly(t)).toHaveLength(0);
  });
});

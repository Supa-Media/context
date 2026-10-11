/**
 * `aiModelUsage`: the same spend as `jevUsage`, split by the model that spent it.
 *
 * The one rule these tests hold: for a report that names a well-formed model,
 * the cost written to `aiModelUsage` sums exactly to the cost added to
 * `jevUsage` for that same report. A malformed model name writes no row, so
 * its writing cost stays in `jevUsage` only (the AI costs tab shows it as
 * unrecorded), and the built-in turn is still priced as GLM, as before.
 */
import { afterEach, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type JevCtx, withJev } from "../functions/lib/jev/client";
import { JEV_FEATURES } from "../functions/lib/jev/features";
import { addModelUsage, costMicroUsd, estimateTokens, utcDay, writingCostMicroUsd } from "../functions/lib/jev/meter";
import { CLEF_MODEL, GEMMA_MODEL, GLM_MODEL } from "../functions/lib/jev/models";
import type { JevTransport } from "../functions/lib/jev/worker";
import { BUILTIN_FEATURE } from "../functions/builtinModel";
import { createUser, createWorkspace, asUser, gatewayPost, setupTest, type TestConvex } from "./fixtures.helpers";

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const PHONE = "+15555550101";
const HAIKU = "anthropic/claude-haiku-5-5";

async function agentPost(t: TestConvex, path: string, body: unknown) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify(body),
  });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function texter(t: TestConvex, { paying = true, slug = "grace" } = {}) {
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

async function ask(t: TestConvex, accessToken: string) {
  const response = await gatewayPost(t, "/gateway/builtin-model", { accessToken, expectedWorkspaceId: null });
  return (JSON.parse(await response.text()) as { verdict: unknown }).verdict;
}

async function report(t: TestConvex, accessToken: string, body: Record<string, unknown>) {
  const response = await gatewayPost(t, "/gateway/builtin-model/usage", { accessToken, expectedWorkspaceId: null, ...body });
  return (JSON.parse(await response.text()) as { recorded: boolean }).recorded;
}

async function jevCost(t: TestConvex, feature: string, workspaceId: Id<"workspaces">) {
  const row = await t.run((ctx) =>
    ctx.db
      .query("jevUsage")
      .withIndex("by_day_feature_workspace", (q) => q.eq("day", utcDay(Date.now())).eq("feature", feature).eq("workspaceId", workspaceId))
      .unique(),
  );
  return row;
}

/** Today's model rows for one workspace, keyed by model; a model appears once per feature, so features are summed out. */
async function modelRows(t: TestConvex, workspaceId: Id<"workspaces">) {
  const rows = await t.run((ctx) =>
    ctx.db
      .query("aiModelUsage")
      .withIndex("by_workspace_day", (q) => q.eq("workspaceId", workspaceId).eq("day", utcDay(Date.now())))
      .collect(),
  );
  return rows;
}

function rowFor(rows: Awaited<ReturnType<typeof modelRows>>, model: string, feature: string = BUILTIN_FEATURE) {
  return rows.find((row) => row.model === model && row.feature === feature);
}

function sumCost(rows: Awaited<ReturnType<typeof modelRows>>) {
  return rows.reduce((total, row) => total + row.costMicroUsd, 0);
}

afterEach(() => {
  delete process.env.JEV_USD_PER_MTOK;
});

describe("a built-in turn names its model", () => {
  test("a Haiku turn writes one row with its tokens, and its cost is the jevUsage cost", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t);
    await ask(t, accessToken);
    expect(
      await report(t, accessToken, {
        model: HAIKU,
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 200_000,
        ms: 900,
      }),
    ).toBe(true);
    const rows = await modelRows(t, workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: utcDay(Date.now()),
      feature: BUILTIN_FEATURE,
      model: HAIKU,
      workspaceId,
      calls: 1,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 200_000,
    });
    // $0.10 in, $0.50 out, $0.01 cache read, $0.125 cache write, per million.
    expect(rows[0]!.costMicroUsd).toBe(100_000 + 50_000 + 10_000 + 25_000);
    expect(sumCost(rows)).toBe((await jevCost(t, BUILTIN_FEATURE, workspaceId))!.costMicroUsd);
  });

  test("tokens read by the decision model add a Clef row at Clef's rate, with no call counted", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t);
    await ask(t, accessToken);
    await report(t, accessToken, { model: HAIKU, inputTokens: 1_000_000, outputTokens: 0, decisionTokens: 1_000_000, ms: 5 });
    const rows = await modelRows(t, workspaceId);
    expect(rowFor(rows, CLEF_MODEL)).toMatchObject({ calls: 0, inputTokens: 1_000_000, outputTokens: 0, costMicroUsd: 240_000 });
    expect(rowFor(rows, HAIKU)).toMatchObject({ calls: 1, costMicroUsd: 100_000 });
    expect(sumCost(rows)).toBe((await jevCost(t, BUILTIN_FEATURE, workspaceId))!.costMicroUsd);
  });

  test("a missing model is GLM's row", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t);
    await ask(t, accessToken);
    await report(t, accessToken, { inputTokens: 1_000_000, outputTokens: 100_000, ms: 5 });
    const rows = await modelRows(t, workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: GLM_MODEL, calls: 1, inputTokens: 1_000_000, outputTokens: 100_000, costMicroUsd: 100_000 });
  });

  test("a malformed model writes no row, and jevUsage is priced as GLM, as before", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t);
    await ask(t, accessToken);
    await report(t, accessToken, { model: "bad model name; drop", inputTokens: 1_000_000, outputTokens: 0, ms: 5 });
    await report(t, accessToken, { model: 42, inputTokens: 1_000_000, outputTokens: 0, ms: 5 });
    expect(await modelRows(t, workspaceId)).toEqual([]);
    expect((await jevCost(t, BUILTIN_FEATURE, workspaceId))!.costMicroUsd).toBe(120_000);
  });

  test("two turns on the same day sum into one row", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t);
    await ask(t, accessToken);
    await ask(t, accessToken);
    await report(t, accessToken, { model: HAIKU, inputTokens: 1_000_000, outputTokens: 0, ms: 5 });
    await report(t, accessToken, { model: HAIKU, inputTokens: 500_000, outputTokens: 100_000, ms: 5 });
    const rows = await modelRows(t, workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ calls: 2, inputTokens: 1_500_000, outputTokens: 100_000, costMicroUsd: 150_000 + 50_000 });
    expect(sumCost(rows)).toBe((await jevCost(t, BUILTIN_FEATURE, workspaceId))!.costMicroUsd);
  });

  test("a failed turn writes its tokens with no call, so the cap still counts it once in jevUsage", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t);
    await ask(t, accessToken);
    await report(t, accessToken, { model: HAIKU, inputTokens: 1_000_000, outputTokens: 0, failed: true, ms: 5 });
    const rows = await modelRows(t, workspaceId);
    expect(rows[0]).toMatchObject({ calls: 0, inputTokens: 1_000_000, costMicroUsd: 100_000 });
    expect(sumCost(rows)).toBe((await jevCost(t, BUILTIN_FEATURE, workspaceId))!.costMicroUsd);
  });

  test("a refused turn writes nothing to aiModelUsage", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t, { paying: false });
    expect(await ask(t, accessToken)).toEqual({ allowed: false, reason: "not_premium" });
    expect(await modelRows(t, workspaceId)).toEqual([]);
  });
});

describe("a Jev answer names its models", () => {
  const REQUEST = { state: "Shipped the fix on Tuesday.", questions: { shipped: { type: "noul", instructions: "Did it ship?", criteria: { true: "yes", false: "no" } } } };
  const WRITE = { instructions: "What changed?", text: "Dana left on Friday.", schema: { type: "object" } };
  const WRITTEN = { output: { changes: [] }, usage: { input: 1_000_000, output: 100_000 } };

  function fakeTransport(answer: Record<string, unknown> | null = { shipped: { type: "noul", noul: 0.9 } }, written: typeof WRITTEN | null = WRITTEN) {
    const sent: { model?: string }[] = [];
    const transport: JevTransport = {
      async send(request) {
        sent.push(request as { model?: string });
        return answer;
      },
      async write(request) {
        sent.push(request as { model?: string });
        return written;
      },
    };
    return { transport, sent };
  }

  function jevCtx(t: TestConvex): JevCtx {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runQuery: ((ref: any, args: any) => t.query(ref, args)) as JevCtx["runQuery"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runMutation: ((ref: any, args: any) => t.mutation(ref, args)) as JevCtx["runMutation"],
    };
  }

  async function payingWorkspace(t: TestConvex) {
    const owner = await createUser(t, "jev-owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "jev-studio", { kind: "shared" });
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("workspacePlans", { workspaceId, managedStorage: false, fastSearch: true, status: "active", createdAt: now, updatedAt: now }),
    );
    return workspaceId;
  }

  test("a decide and a write produce a Clef row and a GLM row whose costs sum to the jevUsage cost", async () => {
    const t = setupTest();
    const workspaceId = await payingWorkspace(t);
    const { transport } = fakeTransport();
    await withJev(jevCtx(t), { feature: "organizer", workspaceId, transport }, async (jev) => {
      expect(await jev!.decide(REQUEST)).not.toBeNull();
      expect(await jev!.write(WRITE)).toEqual(WRITTEN);
    });
    const decideTokens = estimateTokens(REQUEST.state.length + JSON.stringify(REQUEST.questions).length);
    const rows = await modelRows(t, workspaceId);
    expect(rowFor(rows, CLEF_MODEL, "organizer")).toMatchObject({ calls: 1, inputTokens: decideTokens, outputTokens: 0, costMicroUsd: costMicroUsd(decideTokens) });
    expect(rowFor(rows, GLM_MODEL, "organizer")).toMatchObject({ calls: 1, inputTokens: 1_000_000, outputTokens: 100_000, costMicroUsd: 100_000 });
    expect(rows).toHaveLength(2);
    expect(sumCost(rows)).toBe((await jevCost(t, "organizer", workspaceId))!.costMicroUsd);
  });

  test("a gemma write is counted under gemma's model id", async () => {
    const t = setupTest();
    const workspaceId = await payingWorkspace(t);
    const { transport, sent } = fakeTransport();
    await withJev(jevCtx(t), { feature: "organizer", workspaceId, transport }, async (jev) => {
      await jev!.write({ ...WRITE, model: "gemma" });
    });
    expect(sent[0]).toMatchObject({ model: "gemma" });
    const rows = await modelRows(t, workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: GEMMA_MODEL, calls: 1, costMicroUsd: writingCostMicroUsd(WRITTEN.usage) });
    expect(sumCost(rows)).toBe((await jevCost(t, "organizer", workspaceId))!.costMicroUsd);
  });

  test("failed answers add no model rows", async () => {
    const t = setupTest();
    const workspaceId = await payingWorkspace(t);
    const { transport } = fakeTransport(null, null);
    await withJev(jevCtx(t), { feature: "organizer", workspaceId, transport }, async (jev) => {
      expect(await jev!.decide(REQUEST)).toBeNull();
      expect(await jev!.write(WRITE)).toBeNull();
    });
    expect(await modelRows(t, workspaceId)).toEqual([]);
    expect(await jevCost(t, "organizer", workspaceId)).toMatchObject({ calls: 0, failed: 2 });
  });

  test("a refused gate writes nothing to aiModelUsage", async () => {
    const t = setupTest();
    const workspaceId = await payingWorkspace(t);
    await t.run((ctx) => ctx.db.insert("jevSwitches", { feature: "organizer", off: true, updatedAt: Date.now() }));
    const { transport, sent } = fakeTransport();
    await withJev(jevCtx(t), { feature: "organizer", workspaceId, transport }, async (jev) => {
      expect(jev).toBeNull();
    });
    expect(sent).toHaveLength(0);
    expect(await modelRows(t, workspaceId)).toEqual([]);
  });

  test("the recordUsage mutation writes the models it is given, after the usage", async () => {
    const t = setupTest();
    const workspaceId = await payingWorkspace(t);
    await t.mutation(internal.functions.jev.recordUsage, {
      feature: "organizer",
      workspaceId,
      calls: 1,
      failed: 0,
      refused: 0,
      questions: 1,
      tokens: 1_000_000,
      ms: 5,
      models: [{ model: CLEF_MODEL, calls: 1, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, costMicroUsd: 240_000 }],
    });
    const rows = await modelRows(t, workspaceId);
    expect(rows).toEqual([expect.objectContaining({ model: CLEF_MODEL, calls: 1, costMicroUsd: 240_000 })]);
    expect((await jevCost(t, "organizer", workspaceId))!.costMicroUsd).toBe(240_000);
  });
});

describe("addModelUsage", () => {
  test("ignores a malformed model name and writes nothing for an all-zero usage", async () => {
    const t = setupTest();
    const owner = await createUser(t, "model-owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "model-studio", { kind: "shared" });
    const now = Date.now();
    const zero = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costMicroUsd: 0 };
    const one = { ...zero, calls: 1, input: 10, costMicroUsd: 2 };
    await t.run(async (ctx) => {
      await addModelUsage(ctx, "organizer", workspaceId, "bad model", one, now);
      await addModelUsage(ctx, "organizer", workspaceId, "", one, now);
      await addModelUsage(ctx, "organizer", workspaceId, "a".repeat(129), one, now);
      await addModelUsage(ctx, "organizer", workspaceId, CLEF_MODEL, zero, now);
    });
    expect(await modelRows(t, workspaceId)).toEqual([]);
  });

  test("a model name of exactly 128 characters is accepted", async () => {
    const t = setupTest();
    const owner = await createUser(t, "long-owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "long-studio", { kind: "shared" });
    const name = "a".repeat(128);
    await t.run((ctx) => addModelUsage(ctx, "organizer", workspaceId, name, { calls: 1, input: 1, output: 0, cacheRead: 0, cacheWrite: 0, costMicroUsd: 1 }, Date.now()));
    expect(await modelRows(t, workspaceId)).toHaveLength(1);
  });
});

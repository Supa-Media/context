import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asUser, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";
import { AGENT_TURN_RETENTION_MS } from "../functions/agentTurns";

/**
 * THE AGENT'S TURN LOG.
 *
 * "See how much time and what tool calls are being made" (the owner,
 * 2026-10-07): every finished `/agent` turn is reported through the real
 * `/gateway/agent-turn` route with a real texting grant. What matters most is
 * what the row cannot hold: names, outcomes and numbers, never text.
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

async function texter(t: T, slug = "ada") {
  const userId = await createUser(t, `${slug}@example.invalid`);
  const workspaceId = await createWorkspace(t, userId, slug, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone: PHONE });
  await agentPost(t, "/agent-texts/link", { phone: PHONE, code });
  const opened = await agentPost(t, "/agent-texts/session", { phone: PHONE });
  return { workspaceId, accessToken: opened.accessToken as string };
}

const TURN = {
  provider: "builtin",
  model: "@cf/zai-org/glm-4.7-flash",
  outcome: "answered",
  ms: 9_400,
  modelMs: 8_100,
  toolMs: 900,
  rounds: 2,
  inputTokens: 5_200,
  outputTokens: 180,
  trace: [
    { kind: "model", ok: true, ms: 4_000 },
    { kind: "tool", tool: "search_notes", ok: true, ms: 900 },
    { kind: "model", ok: true, ms: 4_100 },
  ],
};

async function report(t: T, accessToken: string, body: Record<string, unknown> = {}, secret?: string | null) {
  const response = await gatewayPost(
    t,
    "/gateway/agent-turn",
    { accessToken, expectedWorkspaceId: null, ...TURN, ...body },
    secret === undefined ? {} : { secret },
  );
  if (response.status !== 200) return { status: response.status, recorded: false };
  return { status: 200, ...(JSON.parse(await response.text()) as { recorded: boolean }) };
}

async function turns(t: T, workspaceId?: Id<"workspaces">) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("agentTurns").collect();
    return workspaceId === undefined ? rows : rows.filter((row) => row.workspaceId === workspaceId);
  });
}

describe("the turn log", () => {
  test("a finished turn is kept with its timings and tool calls, against the grant's own workspace", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t);
    expect((await report(t, accessToken)).recorded).toBe(true);
    const [row] = await turns(t, workspaceId);
    expect(row).toMatchObject({
      client: "texts",
      provider: "builtin",
      outcome: "answered",
      ms: 9_400,
      rounds: 2,
      trace: TURN.trace,
    });
  });

  test("a turn keeps where it came from and what each model spent, priced at its own list price", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t);
    const usage = [
      { model: "anthropic/claude-opus-5-5", input: 1_000, output: 200, cacheRead: 10_000, cacheWrite: 1_000 },
      { model: "anthropic/claude-haiku-5-5", input: 2_000, output: 100, cacheRead: 20_000, cacheWrite: 0 },
    ];
    expect((await report(t, accessToken, { kind: "group", usage })).recorded).toBe(true);
    const [row] = await turns(t, workspaceId);
    // Opus: 1,000 x $4 + 200 x $20 + 10,000 x $0.20 + 1,000 x $5 per million = 15,000 micro-dollars.
    // Haiku: 2,000 x $0.10 + 100 x $0.50 + 20,000 x $0.01 = 450.
    expect(row.models).toEqual([
      { model: "anthropic/claude-opus-5-5", inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 10_000, cacheWriteTokens: 1_000, costMicroUsd: 15_000 },
      { model: "anthropic/claude-haiku-5-5", inputTokens: 2_000, outputTokens: 100, cacheReadTokens: 20_000, cacheWriteTokens: 0, costMicroUsd: 450 },
    ]);
    expect(row).toMatchObject({ kind: "group", cacheReadTokens: 30_000, cacheWriteTokens: 1_000, costMicroUsd: 15_450 });
  });

  test("a turn without each model's counts is priced from its own counts, and an unknown kind is not kept", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t);
    expect((await report(t, accessToken, { kind: "everything" })).recorded).toBe(true);
    const [row] = await turns(t, workspaceId);
    expect(row.kind).toBeUndefined();
    // GLM: 5,200 x $0.06 + 180 x $0.40 per million = 384.
    expect(row.costMicroUsd).toBe(384);
    expect(row.models).toBeUndefined();
  });

  test("a sentence where a model name goes in the usage list is refused, and so is a list longer than a turn can run", async () => {
    const t = setupTest();
    const { accessToken } = await texter(t);
    const part = { model: "anthropic/claude-haiku-5-5", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    expect((await report(t, accessToken, { usage: [{ ...part, model: "a model\nwith a sentence" }] })).recorded).toBe(false);
    expect((await report(t, accessToken, { usage: [part, part, part, part, part] })).recorded).toBe(false);
    expect(await turns(t)).toHaveLength(0);
  });

  test("the row has nowhere to put text: no question, answer or tool argument is stored", async () => {
    const t = setupTest();
    const { accessToken } = await texter(t);
    await report(t, accessToken, { question: "SECRET-QUESTION", answer: "SECRET-ANSWER" });
    const [row] = await turns(t);
    expect(JSON.stringify(row)).not.toContain("SECRET");
  });

  test("a sentence where a tool name goes is refused, and nothing is kept", async () => {
    const t = setupTest();
    const { accessToken } = await texter(t);
    for (const tool of ["read my brother's note", "READ_NOTE", "x".repeat(65), ""]) {
      const trace = [{ kind: "tool", tool, ok: true, ms: 1 }];
      expect((await report(t, accessToken, { trace })).recorded).toBe(false);
    }
    expect((await report(t, accessToken, { trace: [{ kind: "model", tool: "read_note", ok: true, ms: 1 }] })).recorded).toBe(false);
    expect((await report(t, accessToken, { model: "a model\nwith a sentence" })).recorded).toBe(false);
    expect(await turns(t)).toHaveLength(0);
  });

  test("a router's pick, a fallback, a retried round and one cut off at the output cap are kept with their status, and a provider's words are not", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t);
    const trace = [
      { kind: "router", tier: "think", model: "anthropic/claude-opus-5-5", ok: true, ms: 40, confidence: 0.8 },
      { kind: "model", ok: true, ms: 900, retried: true, status: 529 },
      { kind: "fallback", model: "@cf/zai-org/glm-4.7-flash", ok: true, ms: 2_000, status: 529 },
      { kind: "model", ok: true, ms: 1_200 },
      { kind: "model", ok: true, ms: 3_000, cut: true },
      { kind: "tool", tool: "write_note", ok: false, ms: 5, held: true },
    ];
    expect((await report(t, accessToken, { trace })).recorded).toBe(true);
    const [row] = await turns(t, workspaceId);
    expect(row.trace).toEqual(trace);
    for (const bad of [
      { kind: "router", model: "anthropic/claude-opus-5-5", ok: true, ms: 1 },
      { kind: "router", tier: "think", model: "a model\nwith a sentence", ok: true, ms: 1 },
      { kind: "router", tier: "main", model: "anthropic/claude-haiku-5-5", ok: true, ms: 1, confidence: 7 },
      { kind: "fallback", ok: true, ms: 1 },
      { kind: "fallback", model: "@cf/x", tool: "read_note", ok: true, ms: 1 },
    ]) {
      expect((await report(t, accessToken, { trace: [bad] })).recorded).toBe(false);
    }
    // A field the log does not know is dropped on the way in, never stored.
    expect((await report(t, accessToken, { trace: [{ kind: "fallback", model: "@cf/x", ok: true, ms: 1, reason: "SECRET-REASON" }] })).recorded).toBe(true);
    expect(JSON.stringify(await turns(t, workspaceId))).not.toContain("SECRET-REASON");
  });

  test("each model round keeps the model that ran it, so a planned turn shows its Opus and Haiku rounds", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await texter(t);
    const trace = [
      { kind: "router", tier: "think", model: "anthropic/claude-opus-5-5", ok: true, ms: 40 },
      { kind: "model", model: "anthropic/claude-opus-5-5", ok: true, ms: 3_000 },
      { kind: "tool", tool: "browse", ok: true, ms: 900 },
      { kind: "model", model: "anthropic/claude-haiku-5-5", ok: true, ms: 800 },
    ];
    expect((await report(t, accessToken, { trace })).recorded).toBe(true);
    const [row] = await turns(t, workspaceId);
    expect(row.trace).toEqual(trace);
    const bad = [{ kind: "model", model: "a model\nwith a sentence", ok: true, ms: 1 }];
    expect((await report(t, accessToken, { trace: bad })).recorded).toBe(false);
  });

  test("an unknown token, the wrong workspace, or a missing gateway secret records nothing", async () => {
    const t = setupTest();
    const { accessToken } = await texter(t);
    expect((await report(t, "not-a-token")).recorded).toBe(false);
    const otherUser = await createUser(t, "bo@example.invalid");
    const other = await createWorkspace(t, otherUser, "bo", { kind: "personal" });
    expect((await report(t, accessToken, { expectedWorkspaceId: other })).recorded).toBe(false);
    expect((await report(t, accessToken, {}, null)).status).not.toBe(200);
    expect(await turns(t)).toHaveLength(0);
  });

  test("turns older than the retention are swept, newer ones stay", async () => {
    const t = setupTest();
    const { accessToken } = await texter(t);
    await report(t, accessToken);
    await report(t, accessToken);
    const [old] = await turns(t);
    await t.run((ctx) => ctx.db.patch(old._id, { at: Date.now() - AGENT_TURN_RETENTION_MS - 1 }));
    await t.mutation(internal.functions.agentTurns.purgeOldAgentTurns, {});
    const left = await turns(t);
    expect(left).toHaveLength(1);
    expect(left[0]._id).not.toBe(old._id);
  });
});

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

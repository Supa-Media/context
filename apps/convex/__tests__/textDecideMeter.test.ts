/**
 * DECIDE'S CAP AND USAGE WHEN THE GATEWAY ASKS CLEF ITSELF (`functions/lib/gatewayRoutes/textDecideMeter.ts`,
 * `functions/lib/jev/elsewhere.ts`; Dev2's pick 2026-11-05: decide moves into the gateway and keeps both).
 *
 * Through the real routes and `jev.gate` / `jev.recordUsage`.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the gate route registered without `agentWorkerRoute`                  "refuses without the secret" failed
 *   the usage row's tokens left at 0 (not estimated from chars)          "writes the row withJev would" failed
 *   the gate ignoring the daily cap (always ok)                          "switched off and capped" failed
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { estimateTokens } from "../functions/lib/jev/meter";
import { addMember, asUser, createUser, createWorkspace, setupTest, TEST_GATEWAY_SECRET } from "./fixtures.helpers";

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "8F2C3D1A-A5B7-4E9F-8C1D-2A3B4C5D6E7F";
const ADA = "+15555550100";
const BO = "+15555550111";

type T = ReturnType<typeof setupTest>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function agentPost(t: T, path: string, body: unknown, secret: string | null = AGENT_SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  const response = await t.fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, text, json: (text ? JSON.parse(text) : null) as Record<string, unknown> | null };
}

async function texter(t: T, name: string, phone: string) {
  const userId = await createUser(t, `${name}@example.invalid`);
  const workspaceId = await createWorkspace(t, userId, name, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
  expect((await agentPost(t, "/agent-texts/link", { phone, code })).json?.status).toBe("linked");
  return { userId, workspaceId };
}

async function boundGroup(t: T) {
  const ada = await texter(t, "ada", ADA);
  const bo = await texter(t, "bo", BO);
  const studio = await createWorkspace(t, bo.userId, "studio", { kind: "shared" });
  await addMember(t, studio, ada.userId, "editor");
  expect((await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender: ADA, participants: [ADA, BO, LINE], mint: true })).json?.status).toBe("ready");
  return { ada, bo };
}

const direct = { chat: ADA, sender: ADA, style: "direct" };
const group = { chat: GROUP, line: LINE, style: "followAlong" };
const report = { calls: 2, failed: 1, refused: 0, questions: 14, chars: 9_000, ms: 900 };

describe("decide's gate and usage, for a gateway decide", () => {
  test("refuses without the agent worker's own secret", async () => {
    const t = setupTest();
    for (const path of ["/agent-texts/decide/gate", "/agent-texts/decide/usage"]) {
      for (const secret of [null, "wrong", TEST_GATEWAY_SECRET]) expect((await agentPost(t, path, { ...direct, ...report }, secret)).status).toBe(401);
    }
  });

  test("a linked 1:1 chat may decide; an unknown one is unavailable and writes nothing", async () => {
    const t = setupTest();
    await texter(t, "ada", ADA);
    const gate = (await agentPost(t, "/agent-texts/decide/gate", direct)).json;
    expect(gate).toMatchObject({ ok: true });
    expect(gate?.remaining).toBeGreaterThan(0);
    expect(JSON.stringify(gate)).not.toContain("workspace");
    expect((await agentPost(t, "/agent-texts/decide/gate", { ...direct, chat: BO, sender: BO })).json).toEqual({ ok: false, reason: "unavailable", cause: "no_group" });
    expect((await agentPost(t, "/agent-texts/decide/usage", { ...direct, chat: BO, sender: BO, ...report })).json).toEqual({ ok: false });
    expect(await t.run((ctx) => ctx.db.query("jevUsage").collect())).toEqual([]);
  });

  test("writes the row withJev would: the chat's workspace, its counts, tokens from the characters read, one Clef row", async () => {
    const t = setupTest();
    const { ada } = await boundGroup(t);
    expect((await agentPost(t, "/agent-texts/decide/usage", { ...group, ...report })).json).toEqual({ ok: true });
    const [row] = await t.run((ctx) => ctx.db.query("jevUsage").collect());
    expect(row).toMatchObject({ feature: "textDecide", workspaceId: ada.workspaceId, calls: 2, failed: 1, questions: 14, tokens: estimateTokens(9_000) });
    const models = await t.run((ctx) => ctx.db.query("aiModelUsage").collect());
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ calls: 2, inputTokens: estimateTokens(9_000) });
    expect(models[0]!.costMicroUsd).toBeGreaterThan(0);
  });

  test("switched off and capped refuse at the gate, as decide's own route does", async () => {
    const t = setupTest();
    const { ada } = await boundGroup(t);
    await t.run((ctx) => ctx.db.insert("jevSwitches", { feature: "textDecide", off: true, updatedAt: Date.now() }));
    expect((await agentPost(t, "/agent-texts/decide/gate", group)).json).toEqual({ ok: false, reason: "off", cause: "switched_off" });
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("jevSwitches").collect()) await ctx.db.delete(row._id);
    });
    await agentPost(t, "/agent-texts/decide/usage", { ...group, ...report, calls: 1, failed: 0 });
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("jevUsage").collect();
      expect(row?.workspaceId).toBe(ada.workspaceId);
      await ctx.db.patch(row!._id, { calls: 2000 });
    });
    expect((await agentPost(t, "/agent-texts/decide/gate", group)).json).toEqual({ ok: false, reason: "capped", cause: "daily_cap" });
  });

  test("refuses a report that does not hold together", async () => {
    const t = setupTest();
    await texter(t, "ada", ADA);
    for (const bad of [{ calls: -1 }, { calls: 1.5 }, { chars: "9" }, { ms: undefined }, { style: "loud" }, { sender: undefined }]) {
      expect((await agentPost(t, "/agent-texts/decide/usage", { ...direct, ...report, ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
  });
});

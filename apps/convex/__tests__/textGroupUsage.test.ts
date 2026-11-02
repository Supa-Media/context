import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, createUser, createWorkspace, setupTest } from "./fixtures.helpers";
import { hashToken } from "../functions/lib/crypto";

/**
 * WHO A GROUP CHAT'S TURNS ARE CHARGED TO, AND WHO SPENT WHAT.
 *
 * The chat's sponsor is the person who brought Tex in (`functions/textGroups.ts`, set once). Every turn in the chat is
 * metered to the sponsor's personal workspace, whoever tagged Tex, and each finished turn's cost is also recorded
 * against the tagger in `textGroupUsage` (`functions/lib/textGroupUsage.ts`). These tests spend the grant on the real
 * `/agent-texts/group` route, then meter the turn through the built-in model's own entry points.
 */

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "9A1B2C3D-4E5F-4A6B-8C7D-0E1F2A3B4C5D";
const ADA = "+15555550100";
const BO = "+15555550111";
const CY = "+15555550122";

type T = ReturnType<typeof setupTest>;

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
}

/** A person with a personal workspace and a phone linked by code. */
async function texter(t: T, name: string, phone: string) {
  const userId = await createUser(t, `${name}@example.invalid`);
  const workspaceId = await createWorkspace(t, userId, name, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
  const linked = await agentPost(t, "/agent-texts/link", { phone, code });
  expect(linked.body.status).toBe("linked");
  return { userId, workspaceId };
}

async function turn(t: T, sender: string, participants: string[]) {
  const answer = await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants, mint: true });
  return answer.body;
}

/** Ada, Bo and Cy, all linked, with one shared workspace Bo owns and the others are in. */
async function crew(t: T) {
  const ada = await texter(t, "ada", ADA);
  const bo = await texter(t, "bo", BO);
  const cy = await texter(t, "cy", CY);
  const studio = await createWorkspace(t, bo.userId, "studio", { kind: "shared" });
  await addMember(t, studio, ada.userId, "editor");
  await addMember(t, studio, cy.userId, "member");
  return { ada, bo, cy, studio };
}

async function theChat(t: T) {
  return await t.run(async (ctx) => await ctx.db.query("textGroups").first());
}

/** One finished turn, reported as the gateway reports it: counts only. */
async function finish(t: T, accessToken: string, inputTokens: number, outputTokens: number) {
  return await t.mutation(internal.functions.builtinModel.recordBuiltinUsage, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: null,
    inputTokens,
    outputTokens,
    failed: false,
    ms: 1,
  });
}

describe("the sponsor", () => {
  test("is the first tagger, set once, and a later tagger does not overwrite it", async () => {
    const t = setupTest();
    const { ada } = await crew(t);
    await turn(t, ADA, [ADA, BO, CY, LINE]);
    expect((await theChat(t))?.sponsorId).toBe(ada.userId);
    await turn(t, BO, [ADA, BO, CY, LINE]);
    expect((await theChat(t))?.sponsorId).toBe(ada.userId);
  });
});

describe("what a turn is charged to", () => {
  test("a second person's turn is metered to the sponsor's personal workspace", async () => {
    const t = setupTest();
    const { ada, bo } = await crew(t);
    await turn(t, ADA, [ADA, BO, CY, LINE]);
    const second = await turn(t, BO, [ADA, BO, CY, LINE]);
    await t.mutation(internal.functions.builtinModel.startBuiltinTurn, {
      hashedAccessToken: await hashToken(second.accessToken as string),
      expectedWorkspaceId: null,
    });
    const usage = await t.run(async (ctx) => await ctx.db.query("jevUsage" as never).collect());
    const charged = new Set((usage as Array<{ workspaceId: string }>).map((row) => row.workspaceId));
    expect([...charged]).toEqual([ada.workspaceId]);
    expect(charged.has(String(bo.workspaceId))).toBe(false);
  });
});

describe("per-person usage in a group chat", () => {
  test("usage rows add up per person, and the percents sum to about 100", async () => {
    const t = setupTest();
    const { ada, bo } = await crew(t);
    const adaTurn = await turn(t, ADA, [ADA, BO, CY, LINE]);
    const boTurn = await turn(t, BO, [ADA, BO, CY, LINE]);
    // Ada asks twice, Bo once and with a longer answer.
    expect(await finish(t, adaTurn.accessToken as string, 1000, 200)).toBe(true);
    expect(await finish(t, adaTurn.accessToken as string, 1000, 200)).toBe(true);
    expect(await finish(t, boTurn.accessToken as string, 4000, 1000)).toBe(true);

    const chat = await theChat(t);
    const shares = await t.query(internal.functions.textGroupUsage.shares, { groupId: chat!._id as Id<"textGroups"> });
    expect(shares.map((row) => row.who)).toEqual([`user:${bo.userId}`, `user:${ada.userId}`]);
    const [boRow, adaRow] = shares;
    expect(adaRow.turns).toBe(2);
    expect(boRow.turns).toBe(1);
    expect(adaRow.cost).toBeGreaterThan(0);
    expect(boRow.cost).toBeGreaterThanOrEqual(adaRow.cost);
    expect(boRow.percent + adaRow.percent).toBeCloseTo(100, 6);
  });

  test("an unknown or dead grant records nothing", async () => {
    const t = setupTest();
    await crew(t);
    const first = await turn(t, ADA, [ADA, BO, CY, LINE]);
    // A second turn from the same tagger replaces the first token, so the first is dead now.
    await turn(t, ADA, [ADA, BO, CY, LINE]);
    expect(await finish(t, first.accessToken as string, 1000, 200)).toBe(false);
    expect(await finish(t, "not-a-grant-anybody-minted", 1000, 200)).toBe(false);
    const chat = await theChat(t);
    expect(await t.query(internal.functions.textGroupUsage.shares, { groupId: chat!._id as Id<"textGroups"> })).toEqual([]);
    const rows = await t.run(async (ctx) => await ctx.db.query("textGroupUsage").collect());
    expect(rows).toEqual([]);
  });
});

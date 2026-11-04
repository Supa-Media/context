/**
 * HOW TEX TALKS (`functions/texStyle.ts`, `lib/texInstructions.ts`, Dev2,
 * 2026-11-01; `docs/decisions/texting-assistant/custom-instructions.md`):
 * a person's own instructions and a group chat's, and two switches.
 *
 *  1. A quick pick writes its line and replaces only its own family's line;
 *     a text past its limit, or a pick nobody made, is refused whole.
 *  2. The app reads and writes only the caller's row; the Worker's routes need
 *     its own secret and a closed set.
 *  3. A group uses only its own instructions, with who set them; a person's
 *     reach their 1:1 session only. "Tex, undo" puts the text before back once.
 *  4. Every old dial becomes its line, and mute and style become `speaksUp`.
 *  5. "Tex, stop" is off, "be quiet" is quiet, "start" puts back the level;
 *     off answers nothing but those, and its grant stops resolving.
 *
 * ## Sabotage record
 *
 *   a pick that keeps its family's other line        1 failed (a pick replaces only its own family)
 *   the ready answer leaving out the chat's own text 2 failed (a group uses only its own; the migration)
 *   `speaksUpOf` ignoring the old mute               1 failed (an unmigrated mute still stops Tex)
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { deletePersonalRows } from "../functions/lib/account/personalRows";
import { applyInstructionsChange, linesFromStyle, MAX_INSTRUCTIONS, QUICK_PICKS } from "../functions/lib/texInstructions";
import { addMember, asUser, createUser, createWorkspace, setupTest, TEST_GATEWAY_SECRET } from "./fixtures.helpers";

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "8F2C3D1A-A5B7-4E9F-8C1D-2A3B4C5D6E7F";
const ADA = "+15555550100";
const BO = "+15555550111";
const line = (id: string) => QUICK_PICKS.find((pick) => pick.id === id)!.line;

type T = ReturnType<typeof setupTest>;

async function agentPost(t: T, path: string, body: unknown, secret: string | null = AGENT_SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  const response = await t.fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, json: JSON.parse((await response.text()) || "null") as Record<string, unknown> };
}

async function texter(t: T, name: string, phone: string) {
  const userId = await createUser(t, `${name}@example.invalid`);
  const workspaceId = await createWorkspace(t, userId, name, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
  expect((await agentPost(t, "/agent-texts/link", { phone, code })).json.status).toBe("linked");
  return { userId, workspaceId };
}

/** Ada and Bo share @studio, so the chat answers. */
async function chat(t: T) {
  const ada = await texter(t, "ada", ADA);
  const bo = await texter(t, "bo", BO);
  const studio = await createWorkspace(t, bo.userId, "studio", { kind: "shared" });
  await addMember(t, studio, ada.userId, "editor");
  return { ada, bo };
}

const tag = (t: T, extra: Record<string, unknown> = {}) => agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender: ADA, participants: [ADA, BO, LINE], mint: true, ...extra });
const said = (t: T, command: Record<string, unknown>) => tag(t, { mint: false, command });
const groupRow = async (t: T) => (await t.run((ctx) => ctx.db.query("textGroups").collect()))[0]!;

describe("quick picks edit the text", () => {
  test("a pick replaces only its own family, and a person's own lines stay", () => {
    const own = "Call me Captain.";
    const less = applyInstructionsChange({ instructions: `${own}\n${line("emoji_less")}\n${line("short")}` }, { pick: "emoji_none" });
    expect(less).toEqual({ instructions: `${own}\n${line("short")}\n${line("emoji_none")}`, instructionsBefore: `${own}\n${line("emoji_less")}\n${line("short")}` });
    expect(applyInstructionsChange({}, { pick: "sarcastic" })).toEqual({ refused: "bad_request" });
    expect(applyInstructionsChange({}, { replace: "x".repeat(MAX_INSTRUCTIONS + 1) })).toEqual({ refused: "too_long" });
    expect(applyInstructionsChange({}, { undo: true })).toEqual({ refused: "nothing_to_undo" });
    expect(applyInstructionsChange({ instructions: "a", instructionsBefore: "" }, { undo: true })).toEqual({});
    // A remove that finds nothing changes nothing, and the last real change stays the one to undo.
    expect(applyInstructionsChange({ instructions: "a", instructionsBefore: "b" }, { remove: "c" })).toEqual({ instructions: "a", instructionsBefore: "b" });
  });

  test("every old dial becomes its line", () => {
    expect(linesFromStyle({ tone: "efficient", warmth: "less", enthusiasm: "more", emoji: "less", length: "detailed", bubbles: "one", humor: 0 })).toBe(
      [line("efficient"), line("warmth_less"), line("enthusiasm_more"), line("emoji_none"), line("detailed"), line("one_bubble"), line("humor_none")].join("\n"),
    );
    expect(linesFromStyle({ emoji: "more", humor: 40 })).toBe([line("emoji_more"), line("humor_less")].join("\n"));
    expect(linesFromStyle({ tone: "default", warmth: "default", humor: 80, bubbles: "multiple" })).toBe("");
    expect(linesFromStyle({ humor: 90 })).toBe(line("humor_more"));
  });
});

describe("a person's own instructions", () => {
  test("the app reads and writes only the caller's row", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    const bo = await createUser(t, "bo@example.invalid");
    expect(await t.query(api.functions.texStyle.myTexStyle, {})).toBeNull();
    expect(await asUser(t, ada).query(api.functions.texStyle.myTexStyle, {})).toMatchObject({ picks: expect.arrayContaining([{ id: "emoji_none", label: "No emoji" }]) });
    expect(await asUser(t, ada).mutation(api.functions.texStyle.setMyTexStyle, { change: { replace: "Answer in French." } })).toEqual({ instructions: "Answer in French." });
    expect(await asUser(t, ada).mutation(api.functions.texStyle.setMyTexStyle, { change: { pick: "candid" }, updates: "planOnly" })).toEqual({ instructions: `Answer in French.\n${line("candid")}`, updates: "planOnly" });
    expect(await asUser(t, ada).query(api.functions.texStyle.myTexStyle, {})).toMatchObject({ instructions: `Answer in French.\n${line("candid")}`, updates: "planOnly" });
    expect(await asUser(t, bo).query(api.functions.texStyle.myTexStyle, {})).not.toHaveProperty("instructions");
    // A first change that sets nothing still makes a row of only what is set.
    expect(await asUser(t, bo).mutation(api.functions.texStyle.setMyTexStyle, { change: { clear: true } })).toEqual({});
    expect(await asUser(t, ada).mutation(api.functions.texStyle.setMyTexStyle, { change: { pick: "loud" } })).toEqual({ refused: "bad_request" });
    await expect(t.mutation(api.functions.texStyle.setMyTexStyle, { change: { replace: "x" } })).rejects.toThrow();
  });

  test("set by text, handed to the 1:1 session, undone once, and gone with the account", async () => {
    const t = setupTest();
    const ada = await texter(t, "ada", ADA);
    expect((await agentPost(t, "/agent-texts/style", { phone: ADA, pick: "short" }, TEST_GATEWAY_SECRET)).status).toBe(401);
    expect((await agentPost(t, "/agent-texts/style", { phone: ADA, pick: "loud" })).status).toBe(400);
    // The Worker names a pick by id: a line of its own is the model's tool's, never this route's.
    expect((await agentPost(t, "/agent-texts/style", { phone: ADA, add: "Be rude." })).status).toBe(400);
    expect((await agentPost(t, "/agent-texts/style", { phone: BO, pick: "short" })).json).toEqual({ ok: false });
    expect((await agentPost(t, "/agent-texts/style", { phone: ADA, pick: "short", updates: "off" })).json).toEqual({ ok: true, instructions: line("short"), updates: "off" });
    expect((await agentPost(t, "/agent-texts/style", { phone: ADA, pick: "emoji_none" })).json).toEqual({ ok: true, instructions: `${line("short")}\n${line("emoji_none")}`, updates: "off" });
    const session = await agentPost(t, "/agent-texts/session", { phone: ADA });
    expect(session.json).toMatchObject({ instructions: `${line("short")}\n${line("emoji_none")}`, updates: "off" });
    expect((await agentPost(t, "/agent-texts/style", { phone: ADA, undo: true })).json).toEqual({ ok: true, instructions: line("short"), updates: "off" });
    expect((await agentPost(t, "/agent-texts/style", { phone: ADA, undo: true })).json).toEqual({ ok: false, refused: "nothing_to_undo" });
    expect((await agentPost(t, "/agent-texts/style", { phone: ADA, updates: "normal" })).json).toEqual({ ok: true, instructions: line("short") });
    await t.run((ctx) => deletePersonalRows(ctx, ada.userId));
    expect(await t.run((ctx) => ctx.db.query("texStylePreferences").collect())).toEqual([]);
  });
});

describe("a group's own instructions", () => {
  test("a group uses only its own, with who set them; never a member's", async () => {
    const t = setupTest();
    await chat(t);
    await agentPost(t, "/agent-texts/style", { phone: ADA, pick: "cynical" });
    const first = await tag(t);
    expect(first.json.status).toBe("ready");
    expect(first.json.instructions).toBeUndefined();
    expect((await agentPost(t, "/agent-texts/group/style", { line: LINE, groupId: "OTHER", pick: "short", setBy: "ada" })).json).toEqual({ ok: false });
    expect((await agentPost(t, "/agent-texts/group/style", { line: LINE, groupId: GROUP, pick: "louder", setBy: "ada" })).status).toBe(400);
    expect((await agentPost(t, "/agent-texts/group/style", { line: LINE, groupId: GROUP, pick: "short", setBy: ADA })).json).toEqual({ ok: true, instructions: line("short") });
    const row = await groupRow(t);
    expect(row.instructionsSetBy).toMatch(/^[0-9a-f]{64}$/);
    expect((await tag(t)).json).toMatchObject({ instructions: line("short") });
    expect((await tag(t)).json.instructions).not.toContain(line("cynical"));
    // Anyone here may put it back.
    expect((await agentPost(t, "/agent-texts/group/style", { line: LINE, groupId: GROUP, undo: true, setBy: "bo" })).json).toEqual({ ok: true });
    expect((await tag(t)).json.instructions).toBeUndefined();
  });
});

describe("when Tex speaks up", () => {
  test("stop is off, be quiet is quiet, start puts the level back; off answers nothing else", async () => {
    const t = setupTest();
    await chat(t);
    await tag(t);
    expect((await said(t, { kind: "speaks_up", level: "helpful" })).json).toEqual({ status: "speaks_up", level: "helpful", by: "ada" });
    expect((await said(t, { kind: "stop" })).json).toEqual({ status: "stopped" });
    expect(await groupRow(t)).toMatchObject({ speaksUp: "off", speaksUpBefore: "helpful", speaksUpSetBy: "ada" });
    expect((await tag(t)).json).toEqual({ status: "muted" });
    expect((await said(t, { kind: "start" })).json).toEqual({ status: "started" });
    expect((await tag(t)).json).toMatchObject({ status: "ready", engagement: "helpful", engagementChosen: true });
    expect((await said(t, { kind: "speaks_up", level: "quiet" })).json).toMatchObject({ status: "speaks_up", level: "quiet" });
    expect((await tag(t)).json).toMatchObject({ engagement: "quiet" });
  });

  test("an unmigrated mute still stops Tex, and the migration makes it off", async () => {
    const t = setupTest();
    await chat(t);
    await tag(t);
    const row = await groupRow(t);
    await t.run((ctx) => ctx.db.patch(row._id, { mutedAt: 1, engagement: "attentive", texStyle: { emoji: "less", bubbles: "one" }, texStyleSetBy: "bo" }));
    expect((await tag(t)).json).toEqual({ status: "muted" });
    expect(await t.mutation(internal.functions.texSettingsMigration.moveToInstructions, { dryRun: true })).toEqual({ people: 0, peopleMoved: 0, groups: 1, groupsMoved: 1 });
    expect((await groupRow(t)).speaksUp).toBeUndefined();
    await t.mutation(internal.functions.texSettingsMigration.moveToInstructions, { dryRun: false });
    expect(await groupRow(t)).toMatchObject({ speaksUp: "off", speaksUpBefore: "attentive", instructions: `${line("emoji_none")}\n${line("one_bubble")}`, instructionsSetBy: "bo", updates: "off", mutedAt: 1 });
    expect((await said(t, { kind: "start" })).json).toEqual({ status: "started" });
    expect((await tag(t)).json).toMatchObject({ engagement: "attentive", instructions: `${line("emoji_none")}\n${line("one_bubble")}`, updates: "off" });
    // Run again, it changes nothing it already wrote.
    expect(await t.mutation(internal.functions.texSettingsMigration.moveToInstructions, { dryRun: true })).toMatchObject({ groupsMoved: 0 });
  });

  test("a person's dials move too", async () => {
    const t = setupTest();
    const ada = await texter(t, "ada", ADA);
    await t.run((ctx) => ctx.db.insert("texStylePreferences", { userId: ada.userId, texStyle: { tone: "nerdy", humor: 100 }, updatedAt: 1 }));
    expect(await t.mutation(internal.functions.texSettingsMigration.moveToInstructions, { dryRun: false })).toEqual({ people: 1, peopleMoved: 1, groups: 0, groupsMoved: 0 });
    expect((await agentPost(t, "/agent-texts/session", { phone: ADA })).json).toMatchObject({ instructions: `${line("nerdy")}\n${line("humor_more")}` });
  });
});

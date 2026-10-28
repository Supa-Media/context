/**
 * HOW TEX TALKS (`functions/texStyle.ts`, Dev2, 2026-10-28): a person's own
 * style and a group chat's.
 *
 *  1. Only the caller's own row from the app; a signed-out caller gets nothing.
 *  2. Closed sets at every door: an unknown setting, a value off its set, or a
 *     humor that isn't a whole ten from 0 to 100 is refused whole.
 *  3. The Worker's routes need its own secret.
 *  4. A group keeps its own style, who set it, and hands it to the Worker on
 *     ready; a person's style reaches their 1:1 session only, never the group.
 *  5. Only changes are kept; a setting put back to its default is dropped.
 *  6. Leaves with the account.
 *
 * ## Sabotage record
 *
 *   `readTexStyle` accepting any humor number from 0 up        4 failed (closed sets, the app's write, and both routes)
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { deletePersonalRows } from "../functions/lib/account/personalRows";
import { mergeTexStyle, readTexStyle } from "../functions/lib/texStyle";
import { addMember, asUser, createUser, createWorkspace, setupTest, TEST_GATEWAY_SECRET } from "./fixtures.helpers";

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "8F2C3D1A-A5B7-4E9F-8C1D-2A3B4C5D6E7F";
const ADA = "+15555550100";
const BO = "+15555550111";

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

describe("closed sets", () => {
  test("a style is refused whole when anything is off its set", () => {
    expect(readTexStyle({ tone: "efficient", humor: 60, emoji: "less", bubbles: "one", length: "short" })).toEqual({ tone: "efficient", humor: 60, emoji: "less", bubbles: "one", length: "short" });
    for (const bad of [{ humor: 55 }, { humor: 110 }, { humor: -10 }, { humor: "60" }, { tone: "sarcastic" }, { warmth: "max" }, { colour: "red" }, null, [], "efficient"]) {
      expect(readTexStyle(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  test("only changes are kept", () => {
    expect(mergeTexStyle({ tone: "quirky", humor: 40 }, { tone: "default", humor: 75, emoji: "more", bubbles: "multiple" })).toEqual({ emoji: "more" });
  });
});

describe("a person's own style", () => {
  test("the app reads and writes only the caller's row", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    const bo = await createUser(t, "bo@example.invalid");
    expect(await t.query(api.functions.texStyle.myTexStyle, {})).toBeNull();
    expect(await asUser(t, ada).query(api.functions.texStyle.myTexStyle, {})).toEqual({});
    await asUser(t, ada).mutation(api.functions.texStyle.setMyTexStyle, { texStyle: { tone: "candid", humor: 30 } });
    expect(await asUser(t, ada).query(api.functions.texStyle.myTexStyle, {})).toEqual({ tone: "candid", humor: 30 });
    expect(await asUser(t, bo).query(api.functions.texStyle.myTexStyle, {})).toEqual({});
    await expect(asUser(t, ada).mutation(api.functions.texStyle.setMyTexStyle, { texStyle: { humor: 33 } })).rejects.toThrow();
    await expect(t.mutation(api.functions.texStyle.setMyTexStyle, { texStyle: { tone: "candid" } })).rejects.toThrow();
  });

  test("set by text, handed to the 1:1 session, and gone with the account", async () => {
    const t = setupTest();
    const ada = await texter(t, "ada", ADA);
    const refused = await agentPost(t, "/agent-texts/style", { phone: ADA, style: { humor: 60 } }, TEST_GATEWAY_SECRET);
    expect(refused.status).toBe(401);
    expect((await agentPost(t, "/agent-texts/style", { phone: ADA, style: { humor: 61 } })).status).toBe(400);
    expect((await agentPost(t, "/agent-texts/style", { phone: BO, style: { humor: 60 } })).json).toEqual({ ok: false });
    expect((await agentPost(t, "/agent-texts/style", { phone: ADA, style: { humor: 60, emoji: "less" } })).json).toEqual({ ok: true, style: { humor: 60, emoji: "less" } });
    const session = await agentPost(t, "/agent-texts/session", { phone: ADA });
    expect(session.json.texStyle).toEqual({ humor: 60, emoji: "less" });
    await t.run((ctx) => deletePersonalRows(ctx, ada.userId));
    expect(await t.run((ctx) => ctx.db.query("texStylePreferences").collect())).toEqual([]);
  });
});

describe("a group's style", () => {
  test("a group uses only its own, with who set it", async () => {
    const t = setupTest();
    const ada = await texter(t, "ada", ADA);
    const bo = await texter(t, "bo", BO);
    const studio = await createWorkspace(t, bo.userId, "studio", { kind: "shared" });
    await addMember(t, studio, ada.userId, "editor");
    await agentPost(t, "/agent-texts/style", { phone: ADA, style: { tone: "cynical" } });
    const tag = () => agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender: ADA, participants: [ADA, BO, LINE], mint: true });
    const first = await tag();
    expect(first.json.status).toBe("ready");
    expect(first.json.texStyle).toBeUndefined();
    expect((await agentPost(t, "/agent-texts/group/style", { line: LINE, groupId: "OTHER", style: { humor: 60 }, setBy: "@ada" })).json).toEqual({ ok: false });
    expect((await agentPost(t, "/agent-texts/group/style", { line: LINE, groupId: GROUP, style: { humor: 65 }, setBy: "@ada" })).status).toBe(400);
    expect((await agentPost(t, "/agent-texts/group/style", { line: LINE, groupId: GROUP, style: { humor: 60 }, setBy: ADA })).json).toEqual({ ok: true, style: { humor: 60 } });
    const row = (await t.run((ctx) => ctx.db.query("textGroups").collect()))[0]!;
    expect(row.texStyleSetBy).toMatch(/^[0-9a-f]{64}$/);
    expect((await tag()).json.texStyle).toEqual({ humor: 60 });
  });
});

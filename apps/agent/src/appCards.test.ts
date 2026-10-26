import { describe, expect, it } from "vitest";

import { appCardConfig, noteCard } from "./appCards";
import { lineFor } from "./line";
import { sendblueChatId } from "./sendblue";
import type { Fetch } from "./clients";

const LINE = "+18135550100";
const PHONE = "+14155550123";
const KEYS = { keyId: "k", secret: "s" };
const CONFIG = { extensionBundleId: "lc.context.mobile.messages", teamId: "T".repeat(10) };
const LINK = "https://context.lc/note/@dev2/1-projects/tex/launch-plan.md";

type Call = { path: string; body: Record<string, unknown> };
function fake(calls: Call[], cardStatus = 202): Fetch {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ path: new URL(url).pathname, body });
    return new Response('{"status":"QUEUED","message_handle":"mh_1"}', { status: body.app_card ? cardStatus : 200 });
  }) as unknown as Fetch;
}

describe("note cards", () => {
  it("are off unless switched on with a well-formed extension and team", () => {
    expect(appCardConfig({})).toBeNull();
    expect(appCardConfig({ APP_CARDS: "off", APP_CARD_EXTENSION_ID: CONFIG.extensionBundleId, APPLE_TEAM_ID: CONFIG.teamId })).toBeNull();
    expect(appCardConfig({ APP_CARDS: "on", APP_CARD_EXTENSION_ID: CONFIG.extensionBundleId })).toBeNull();
    expect(appCardConfig({ APP_CARDS: "on", APP_CARD_EXTENSION_ID: "not a bundle", APPLE_TEAM_ID: CONFIG.teamId })).toBeNull();
    expect(appCardConfig({ APP_CARDS: "on", APP_CARD_EXTENSION_ID: CONFIG.extensionBundleId, APPLE_TEAM_ID: "short" })).toBeNull();
    expect(appCardConfig({ APP_CARDS: "on", APP_CARD_EXTENSION_ID: CONFIG.extensionBundleId, APPLE_TEAM_ID: CONFIG.teamId, APP_STORE_ID: "123" })).toEqual({ ...CONFIG, appStoreId: 123 });
  });

  it("name the note and where it lives, and carry its link", () => {
    const card = noteCard(LINK, CONFIG);
    expect(card).toMatchObject({ appName: "Context", url: LINK, interactive: false, ...CONFIG });
    expect(card?.layout).toMatchObject({ caption: "Launch plan", subcaption: "@dev2 · 1-projects/tex" });
    expect(noteCard("https://context.lc/note/@dev2/todo.md", CONFIG)?.layout.subcaption).toBe("@dev2");
    expect(noteCard("https://context.lc/note/@dev2/areas/Dentist%20visits.md", CONFIG)?.layout.caption).toBe("Dentist visits");
  });

  it("are only for a text that is nothing but a note link", () => {
    expect(noteCard(`Here it is ${LINK}`, CONFIG)).toBeNull();
    expect(noteCard("https://example.com/note/@dev2/plan.md", CONFIG)).toBeNull();
    expect(noteCard("https://context.lc.evil.com/note/@dev2/plan.md", CONFIG)).toBeNull();
    expect(noteCard("https://context.lc/note/@dev2/folder/", CONFIG)).toBeNull();
    expect(noteCard("https://context.lc/note/@dev2/%E0%A4%A.md", CONFIG)).toBeNull();
    expect(noteCard("https://context.lc/texts", CONFIG)).toBeNull();
  });
});

describe("the Sendblue line with cards on", () => {
  const chatId = sendblueChatId(LINE, PHONE);

  it("sends a note link as a card, threaded like any text", async () => {
    const calls: Call[] = [];
    const line = lineFor({ fetch: fake(calls), linqApiKey: "", sendblue: KEYS, appCard: CONFIG }, chatId);
    expect(await line.sendText(chatId, LINK, "k", "mh_0")).toBe("mh_1");
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ number: PHONE, from_number: LINE, reply_to: { message_handle: "mh_0" }, app_card: { url: LINK } });
    expect(calls[0].body.content).toBeUndefined();
  });

  it("sends the plain link where the line refuses cards, and words as words", async () => {
    const calls: Call[] = [];
    const line = lineFor({ fetch: fake(calls, 403), linqApiKey: "", sendblue: KEYS, appCard: CONFIG }, chatId);
    await line.sendText(chatId, LINK, "k");
    expect(calls.map((call) => Boolean(call.body.app_card))).toEqual([true, false]);
    expect(calls[1].body.content).toBe(LINK);
    calls.length = 0;
    await line.sendText(chatId, "Saved it.", "k");
    expect(calls.map((call) => call.body.content)).toEqual(["Saved it."]);
  });

  it("sends the link itself while cards are off", async () => {
    const calls: Call[] = [];
    const line = lineFor({ fetch: fake(calls), linqApiKey: "", sendblue: KEYS, appCard: null }, chatId);
    await line.sendText(chatId, LINK, "k");
    expect(calls.map((call) => call.body.content)).toEqual([LINK]);
  });
});

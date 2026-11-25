/**
 * SEARCH THIS CHAT'S OWN HISTORY (`packages/tex/gateway/agent/chatSearch.js`; Dev2, 2026-11-25: Tex could read its
 * chat's last days and open a day by date, but could not find a line by what was said).
 *
 * Sabotage record (2026-11-25), each applied, this file run, named test failing, reverted:
 *  1. `chatSearchOn` always true → "off on main, on where a draft's front door lists chatSearch" fails.
 *  2. the `history: true` route dropped from `sixTools.js` → "search { args: { history: true } } reaches search_chat" fails.
 *  3. `who` filter ignored → "who narrows to one speaker" fails.
 *  4. reading `ledger.read(other chat)` → "never another chat's texts" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { chatSearchOn, chatSearchTool, CHAT_SEARCH_MODULE, readsChatSearch, SEARCH_CHAT } from "../../../packages/tex/gateway/agent/chatSearch.js";
import { sixToolsOver } from "../../../packages/tex/gateway/agent/sixTools.js";
import { eventEntry } from "../../../packages/tex/gateway/agent/ledger.js";
import { texLedger } from "../../../packages/tex/gateway/texStore/ledger.js";
import { midnightOf, weekTurn } from "../../../packages/tex/gateway/agent/weekHistory.js";
import { TEX_CONFIG, texStep, withDraft } from "../../../packages/tex/gateway/agent/texConfig.js";
import { durableSql } from "./texStoreFixture.mjs";

const ZONE = "America/New_York";
const ME = "me-chat";
const OTHER = "other-chat";
let n = 0;
const said = (chat, at, who, text) => {
  n += 1;
  const from = who === "tex" ? { kind: "tex" } : { kind: "person", name: who, who: `h-${who}` };
  return eventEntry({ id: `${at}-${String(n).padStart(6, "0")}`, at, chat, from, kind: "text", text, ...(who === "tex" ? { delivered: true } : {}) });
};
const at = (day, hour) => midnightOf(day, ZONE) + hour * 3600e3;
const text = (result) => result.content[0].text;

async function ledger() {
  const l = texLedger(durableSql());
  await l.append(ME, [
    said(ME, at("2026-09-02", 9), "seyi", "my flight to Atlanta lands at 4pm on the 26th"),
    said(ME, at("2026-09-02", 9.1), "tex", "Got it, I'll remember the Atlanta flight"),
    said(ME, at("2026-10-15", 12), "seyi", "the venue was Puttery, loved it"),
    said(ME, at("2026-11-20", 18), "seyi", "remind me about the tripleseat invoice"),
  ]);
  await l.append(OTHER, [said(OTHER, at("2026-10-01", 9), "eve", "secret atlanta plan")]);
  return l;
}

test("off on main, on where a draft's front door lists chatSearch", () => {
  assert.equal(readsChatSearch(texStep("fd")), false, "ships on the shelf: main's front door does not list it");
  assert.equal(chatSearchOn({}), false);
  const on = withDraft(TEX_CONFIG, { nodes: [{ id: "fd", ctx: [...texStep("fd").ctx, CHAT_SEARCH_MODULE] }] });
  assert.equal(readsChatSearch(texStep("fd", on)), true);
  assert.equal(readsChatSearch(null), false);
});

test("finds a line months back by its words, with day, time, who and the day: fetch that opens it", async () => {
  const tool = chatSearchTool({ ledger: await ledger(), chat: ME, timeZone: ZONE, log: () => {} });
  assert.equal(tool.tool.name, SEARCH_CHAT);
  const found = text(await tool.call({ words: "atlanta flight" }));
  assert.match(found, /Wed, Sep 2, 2026 9:00 AM · @seyi: my flight to Atlanta lands at 4pm/);
  assert.match(found, /fetch \{"id": "day:2026-09-02"\}/);
  assert.match(found, /You: Got it, I'll remember the Atlanta flight/);
});

test("never another chat's texts", async () => {
  const found = text(await chatSearchTool({ ledger: await ledger(), chat: ME, timeZone: ZONE, log: () => {} }).call({ words: "atlanta" }));
  assert.doesNotMatch(found, /secret/);
});

test("whole words only, and says plainly when nothing holds them", async () => {
  const tool = chatSearchTool({ ledger: await ledger(), chat: ME, timeZone: ZONE, log: () => {} });
  assert.doesNotMatch(text(await tool.call({ words: "trip" })), /tripleseat/);
  assert.match(text(await tool.call({ words: "trip" })), /No text in this chat holds "trip"/);
  assert.equal((await tool.call({ words: " " })).isError, true);
});

test("who narrows to one speaker; since and until to days", async () => {
  const tool = chatSearchTool({ ledger: await ledger(), chat: ME, timeZone: ZONE, log: () => {} });
  const mine = text(await tool.call({ words: "atlanta", who: "you" }));
  assert.match(mine, /You: Got it/);
  assert.doesNotMatch(mine, /@seyi/);
  assert.match(text(await tool.call({ words: "puttery", since: "2026-10-01", until: "2026-10-31" })), /Puttery/);
  assert.match(text(await tool.call({ words: "atlanta", since: "2026-10-01" })), /No text in this chat since 2026-10-01/);
  assert.match(text(await tool.call({ words: "puttery", until: "2026-10-14" })), /No text/);
});

test("weekTurn hands it beside read_day, on the same chat", async () => {
  const built = await weekTurn({ ledger: await ledger(), chat: ME, now: at("2026-11-25", 6), timeZone: ZONE, log: () => {} });
  assert.equal(built.search_chat.tool.name, SEARCH_CHAT);
  assert.match(text(await built.search_chat.call({ words: "puttery" })), /Puttery/);
});

test("search { args: { history: true } } reaches search_chat, with who, since and until", () => {
  const notes = { name: "search_notes", description: "Search.", inputSchema: { type: "object" } };
  const local = chatSearchTool({ ledger: null, chat: ME, timeZone: ZONE, log: () => {} }).tool;
  const six = sixToolsOver([notes, local]);
  assert.match(six.tools.find((t) => t.name === "search").description, /history: true/);
  assert.deepEqual(six.resolve("search", { query: "atlanta flight", args: { history: true, who: "seyi", since: "2026-09-01", until: "2026-09-30" } }), { name: "search_chat", args: { words: "atlanta flight", who: "seyi", since: "2026-09-01", until: "2026-09-30" } });
  // Without the tool, nothing routes there and the search doesn't mention it.
  const bare = sixToolsOver([notes]);
  assert.doesNotMatch(bare.tools.find((t) => t.name === "search").description, /history: true/);
  assert.notEqual(bare.resolve("search", { query: "atlanta", args: { history: true } }).name, "search_chat");
});

test("the fixed tool list shows it only when the turn holds it, so main's cached bytes don't change", async () => {
  const { fixedCarriers } = await import("../../../packages/tex/gateway/agent/sixToolsFixed.js");
  const local = chatSearchTool({ ledger: null, chat: ME, timeZone: ZONE, log: () => {} }).tool;
  for (const kind of ["one", "group"]) {
    const off = sixToolsOver([], null, { shown: fixedCarriers(kind) });
    assert.doesNotMatch(off.tools.find((t) => t.name === "search").description, /history: true/, kind);
    const on = sixToolsOver([local], null, { shown: fixedCarriers(kind, { chatSearch: local }) });
    assert.match(on.tools.find((t) => t.name === "search").description, /history: true/, kind);
    assert.equal(on.resolve("search", { query: "x", args: { history: true } }).name, "search_chat", kind);
  }
});

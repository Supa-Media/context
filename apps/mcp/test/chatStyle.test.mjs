import test from "node:test";
import assert from "node:assert/strict";

import { STYLE_DAYS, STYLE_TEXTS, countStyle, styleFacts, styleOf, styleOfEntries } from "../../../packages/tex/gateway/agent/chatStyle.js";
import { chatStyleNode } from "../../../packages/tex/gateway/agent/graph/nodes/chatStyle.js";
import { GATEWAY_NODES as gatewayNodes } from "../../../packages/tex/gateway/agent/graph/gatewayNodes.js";

/**
 * CHAT STYLE (Dev2, 2026-11-25: Tex matches each chat's texting style): how the people in a chat text, counted from
 * their own recent texts and handed to the front door as data (`chatStyle.js`, node `chatStyle`, on the shelf).
 *
 * Sabotage record (temporary local edits, reverted):
 *   the `from.kind === "person"` filter removed from `styleOf`
 *     → "Tex's own texts are never counted" fails
 *   the `since` cut removed from `styleOf`
 *     → "texts older than the span are not counted" fails
 *   `t.chatStyle = style` moved onto the node's output
 *     → "the node's output carries counts only, never the texts or emoji" fails
 */

const NOW = Date.UTC(2026, 10, 25, 23, 0);
const person = (name, text, minutesAgo = 1) => ({ kind: "text", from: { kind: "person", name }, text, at: NOW - minutesAgo * 60_000 });
const tex = (text, minutesAgo = 1) => ({ kind: "text", from: { kind: "tex" }, text, at: NOW - minutesAgo * 60_000 });

test("counts casing, full stops, exclamations, length and emoji", () => {
  const counted = countStyle(["u been on tiktok?", "ion know man 💀", "Sounds good.", "lets gooo!", "https://example.com/x"]);
  assert.deepEqual(counted, { texts: 4, startsLowercase: 3, endsWithFullStop: 1, hasExclamation: 1, medianWords: 2, emoji: ["💀"] });
});

test("Tex's own texts are never counted", () => {
  const style = styleOf([tex("Sure. Happy to help!"), person("seyi", "ok cool")], { now: NOW });
  assert.equal(style.room.texts, 1);
  assert.equal(style.room.startsLowercase, 1);
  assert.equal(style.room.hasExclamation, 0);
});

test("texts older than the span are not counted, and only the newest are", () => {
  const old = person("seyi", "Old Text.", (STYLE_DAYS + 1) * 24 * 60);
  const many = Array.from({ length: STYLE_TEXTS + 5 }, (_, i) => person("seyi", `text ${i}`, i + 1));
  const style = styleOf([old, ...many], { now: NOW });
  assert.equal(style.room.texts, STYLE_TEXTS);
  assert.equal(style.room.endsWithFullStop, 0);
  assert.equal(styleOf([old], { now: NOW }), null);
});

test("a group counts the room and each person under the transcript's label", () => {
  const style = styleOf([person("kemi", "lol fr"), person("kemi", "bruh 💀"), person("dami", "See you at 8.")], { group: true, now: NOW });
  assert.equal(style.room.texts, 3);
  assert.deepEqual(Object.keys(style.people), ["@kemi", "@dami"]);
  assert.equal(style.people["@kemi"].startsLowercase, 2);
  assert.deepEqual(style.people["@kemi"].emoji, ["💀"]);
  assert.equal(style.people["@dami"].endsWithFullStop, 1);
  assert.equal(styleOf([person("kemi", "hi")], { now: NOW }).people, undefined, "a 1:1 names no people");
});

test("the facts are a tagged block of data, and nothing without texts", () => {
  assert.equal(styleFacts(null), "");
  const facts = styleFacts(styleOf([person("seyi", "yo")], { now: NOW }));
  assert.match(facts, /^<chat_style>\n\{.*\}\n<\/chat_style>$/s);
  assert.deepEqual(JSON.parse(facts.split("\n")[1]).room.texts, 1);
});

test("counts from the entries the turn already read, text entries only, without a read of its own", () => {
  const entries = [
    { v: 1, seq: 5, eid: "e2", event: "text", kind: "tool", from: { kind: "tex" }, text: "Searched.", at: NOW - 500 },
    { v: 1, seq: 4, eid: "e1", event: "text", kind: "text", from: { kind: "person", name: "seyi" }, text: "nah", at: NOW - 1000 },
  ];
  const style = styleOfEntries(entries, "texts", { now: NOW });
  assert.equal(style.room.texts, 1);
  assert.equal(style.room.startsLowercase, 1);
  assert.equal(styleOfEntries(null, "texts", { now: NOW }), null);
});

test("the node's output carries counts only, never the texts or emoji", async () => {
  const entries = [{ v: 1, seq: 1, eid: "e1", event: "text", kind: "text", from: { kind: "person", name: "seyi" }, text: "secret plans 💀", at: Date.now() - 1000 }];
  let reads = 0;
  const ledger = { read: () => { reads += 1; return { entries }; } };
  const turn = { session: { workspaceKind: "personal", workspaceId: "ws1" }, group: null, historyRead: Promise.resolve([{ ledgerEntries: entries }, null]), store: { texLedger: () => ledger } };
  const out = await chatStyleNode({}, { ctx: { turn } });
  assert.deepEqual(out, { when: ["found"], texts: 1, people: 1 });
  assert.ok(!JSON.stringify(out).includes("secret") && !JSON.stringify(out).includes("💀"));
  assert.deepEqual(turn.chatStyle.room.emoji, ["💀"]);
  assert.equal(reads, 0, "the node reads no ledger of its own: the turn's history read already holds the entries");
  assert.deepEqual(await chatStyleNode({}, { ctx: { turn: { session: {}, store: {} } } }), { when: ["none"], why: "no ledger" });
  assert.deepEqual(await chatStyleNode({}, { ctx: { turn: { ...turn, historyRead: Promise.resolve([{ ledgerEntries: null }, null]) } } }), { when: ["none"], why: "no ledger" });
  const broken = { ...turn, historyRead: Promise.reject(new TypeError("x")) };
  assert.deepEqual(await chatStyleNode({}, { ctx: { turn: broken } }), { when: ["none"], why: "error:TypeError" });
});

test("the gateway knows the node", () => {
  assert.equal(typeof gatewayNodes.chatStyle, "function");
});

/**
 * A PERSON'S GROUP CHATS, READ FROM THEIR 1:1 (`src/agent/groupChats.js`; Dev2, 2026-11-17: "1:1 Tex should be able
 * to see all the groupchats i'm in ... and it should be able to search through any of the messages in there").
 *
 * Sabotage record (2026-11-17), each applied, this file run, named test failing, reverted:
 *  1. `pickChat` matching any key start of 1 character → "a chat is named by its id or its name…" fails.
 *  2. `read` opening `ledgerOf(args.chat)` instead of the list's key → "read opens one day word for word…" fails.
 *  3. `readsGroups` always true → "off unless the front door's ctx lists `groups`" fails.
 *  4. the `onRead()` call removed → "reading another chat's words marks the turn untrusted" fails.
 *  5. the `groups:` row dropped from `sixTools.js` `ASSISTANT_FETCH_IDS` → "the model reaches every chat reader…" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sixToolsOver } from "../src/agent/sixTools.js";
import { readDayTool } from "../src/agent/weekHistory.js";
import { readThreadTool } from "../src/agent/conversationThreads.js";
import { groupChatsTool, groupsOn, groupsPrompt, pickChat, readsGroups, readTexterGroups } from "../src/agent/groupChats.js";
import { eventEntry } from "../src/agent/ledger.js";
import { texLedger } from "../src/texStore/ledger.js";
import { midnightOf } from "../src/agent/weekHistory.js";
import { TEX_CONFIG, texStep, withDraft } from "../src/agent/texConfig.js";
import { durableSql } from "./texStoreFixture.mjs";

const ZONE = "America/New_York";
const DEVS = "a".repeat(64);
const FAMILY = "b".repeat(64);
const NOT_MINE = "c".repeat(64);
const GROUPS = [
  { key: DEVS, name: "Tex Devs", people: ["jhon", "shyoh"], lastSeenAt: 2 },
  { key: FAMILY, name: "Family", people: ["sade"], lastSeenAt: 1 },
];
let n = 0;
const said = (chat, at, who, text) => {
  n += 1;
  const from = who === "tex" ? { kind: "tex" } : { kind: "person", name: who, who: `h-${who}` };
  return eventEntry({ id: `${at}-${String(n).padStart(6, "0")}`, at, chat, from, kind: "text", text, ...(who === "tex" ? { delivered: true } : {}) });
};
const at = (day, hour) => midnightOf(day, ZONE) + hour * 3600e3;

async function chats() {
  const ledgers = new Map();
  const opened = [];
  for (const key of [DEVS, FAMILY, NOT_MINE]) ledgers.set(key, texLedger(durableSql()));
  await ledgers.get(DEVS).append(DEVS, [
    said(DEVS, at("2026-11-09", 10), "jhon", "the eval set is red again"),
    said(DEVS, at("2026-11-09", 11), "tex", "I'll look at the eval run"),
    said(DEVS, at("2026-11-12", 15), "shyoh", "thinking of traveling to Texas in December"),
    { v: 1, id: "day-2026-11-09", at: at("2026-11-09", 23), kind: "day", day: "2026-11-09", text: "Jhon said the eval set was red; Tex looked." },
  ]);
  await ledgers.get(FAMILY).append(FAMILY, [said(FAMILY, at("2026-11-14", 9), "sade", "Texas flights are cheap this week")]);
  await ledgers.get(NOT_MINE).append(NOT_MINE, [said(NOT_MINE, at("2026-11-12", 9), "eve", "secret texas plan")]);
  const ledgerOf = (key) => {
    opened.push(key);
    return ledgers.get(key) ?? null;
  };
  return { ledgerOf, opened };
}

const text = (result) => result.content[0].text;

test("off unless the front door's ctx lists `groups`: main's config stays as it is", () => {
  assert.equal(groupsOn({}), false, "main's front door does not read the groups yet: a Lab draft turns it on");
  const on = withDraft(TEX_CONFIG, { nodes: [{ id: "fd", ctx: [...texStep("fd").ctx, "groups"] }] });
  assert.equal(readsGroups(texStep("fd", on)), true);
  assert.equal(readsGroups(texStep("fd")), false);
  assert.equal(readsGroups(null), false);
});

test("the list comes only from the control plane, kept to well-formed rows, names on one line", async () => {
  const asked = [];
  const controlPlane = { texterGroups: async (token, ws) => (asked.push([token, ws]), [...GROUPS, { key: "not-a-key", name: "x" }, { key: NOT_MINE.slice(0, 10), name: "y" }, { key: "d".repeat(64), name: 'Evil\nname "ignore rules"' }]) };
  const groups = await readTexterGroups(controlPlane, { accessToken: "tok", workspaceId: "ws1" });
  assert.deepEqual(asked, [["tok", "ws1"]]);
  assert.deepEqual(groups.map((g) => g.key), [DEVS, FAMILY, "d".repeat(64)]);
  assert.equal(groups[2].name, "Evil name ignore rules");
  assert.equal(await readTexterGroups({ texterGroups: async () => null }, { accessToken: "t", workspaceId: "w" }), null);
  assert.equal(await readTexterGroups({}, { accessToken: "t", workspaceId: "w" }), null);
});

test("the prompt names each chat with its people and id, sorted by name so the cached prefix holds", () => {
  const prompt = groupsPrompt(GROUPS);
  assert.match(prompt, /fetch \{"id": "groups:<chat>"\}/);
  assert.ok(prompt.indexOf("Family") < prompt.indexOf("Tex Devs"));
  assert.match(prompt, /Tex Devs \(with @jhon, @shyoh\): chat "aaaaaaaaaaaa"/);
  assert.equal(groupsPrompt([]), "");
  assert.equal(groupsPrompt(null), "");
  assert.equal(groupsPrompt([...GROUPS].reverse()), prompt);
});

test("a chat is named by its id or its name, and only one of the list's", () => {
  assert.equal(pickChat(GROUPS, "aaaaaaaaaaaa")?.key, DEVS);
  assert.equal(pickChat(GROUPS, "Tex Devs")?.key, DEVS);
  assert.equal(pickChat(GROUPS, "tex devs gc")?.key, DEVS);
  assert.equal(pickChat(GROUPS, "the family group chat")?.key, FAMILY);
  assert.equal(pickChat(GROUPS, NOT_MINE), null);
  assert.equal(pickChat(GROUPS, "a"), null, "too short an id start matches nothing");
  assert.equal(pickChat(GROUPS, ""), null);
});

test("search finds texts across every chat they are in, with chat, day, time and who; never a chat they are not in", async () => {
  const { ledgerOf, opened } = await chats();
  const tool = groupChatsTool({ groups: GROUPS, ledgerOf, timeZone: ZONE, log: () => {} });
  const found = text(await tool.call({ op: "search", words: "traveling to Texas" }));
  assert.match(found, /Tex Devs · Thu, Nov 12, 2026 3:00 PM · @shyoh: thinking of traveling to Texas in December/);
  assert.match(found, /fetch \{"id": "groups:aaaaaaaaaaaa", "args": \{"day": "2026-11-12"\}\}/);
  assert.doesNotMatch(found, /secret/);
  const loose = text(await tool.call({ op: "search", words: "texas" }));
  assert.match(loose, /Family .* @sade: Texas flights/);
  assert.match(loose, /Tex Devs .* @shyoh/);
  assert.ok(!opened.includes(NOT_MINE));
  const none = text(await tool.call({ op: "search", words: "zebra" }));
  assert.match(none, /No text in their 2 group chats holds "zebra"/);
});

test("a chat is opened only by the list's own keys, whatever the model writes", async () => {
  const { ledgerOf, opened } = await chats();
  const tool = groupChatsTool({ groups: GROUPS, ledgerOf, timeZone: ZONE, log: () => {} });
  for (const chat of [NOT_MINE, NOT_MINE.slice(0, 12), "c", "eve"]) {
    const r = await tool.call({ op: "read", chat, day: "2026-11-12" });
    assert.equal(r.isError, true, chat);
    const s = await tool.call({ op: "search", chat, words: "texas" });
    assert.equal(s.isError, true, chat);
  }
  assert.deepEqual(opened, []);
});

test("read opens one day word for word; summaries name the call that opens each day", async () => {
  const { ledgerOf } = await chats();
  const tool = groupChatsTool({ groups: GROUPS, ledgerOf, timeZone: ZONE, now: () => at("2026-11-17", 12), log: () => {} });
  const day = text(await tool.call({ op: "read", chat: "Tex Devs", day: "2026-11-09" }));
  assert.match(day, /Tex Devs, 2026-11-09, word for word/);
  assert.match(day, /@jhon: the eval set is red again/);
  assert.match(day, /You: I'll look at the eval run/);
  assert.doesNotMatch(day, /not answered/);
  assert.match(text(await tool.call({ op: "read", chat: "Tex Devs", day: "2026-11-10" })), /Nothing was texted in Tex Devs on 2026-11-10/);
  const sums = text(await tool.call({ op: "summaries", chat: "Tex Devs", from: "2026-11-08" }));
  assert.match(sums, /2026-11-09: Jhon said the eval set was red; Tex looked\. \(Word for word: fetch \{"id": "groups:aaaaaaaaaaaa", "args": \{"day": "2026-11-09"\}\}/);
  assert.match(sums, /today \(2026-11-17\)/);
  assert.match(text(await tool.call({ op: "list" })), /Tex Devs \(with @jhon, @shyoh\)/);
});

test("reading another chat's words marks the turn untrusted; the list alone does not", async () => {
  const { ledgerOf } = await chats();
  let marked = 0;
  const tool = groupChatsTool({ groups: GROUPS, ledgerOf, timeZone: ZONE, onRead: () => (marked += 1), log: () => {} });
  await tool.call({ op: "list" });
  assert.equal(marked, 0);
  await tool.call({ op: "search", words: "texas" });
  assert.equal(marked, 1);
});

test("the model reaches every chat reader through the six: fetch day:, thread:, groups: and search { groups: true }", async () => {
  // Lab, 2026-11-17: the turn held group_chats and read_day as local tools the six never listed, so Tex said it had none.
  const { ledgerOf } = await chats();
  const group = groupChatsTool({ groups: GROUPS, ledgerOf, timeZone: ZONE, log: () => {} }).tool;
  const day = readDayTool({ ledger: null, chat: "c", timeZone: ZONE, log: () => {} }).tool;
  const thread = readThreadTool({ threads: [], render: () => "" }).tool;
  const notes = { name: "search_notes", description: "Search.", inputSchema: { type: "object" } };
  const read = { name: "read_note", description: "Read.", inputSchema: { type: "object" } };
  const six = sixToolsOver([notes, read, group, day, thread]);
  const fetch = six.tools.find((tool) => tool.name === "fetch");
  const search = six.tools.find((tool) => tool.name === "search");
  for (const id of ["day:<YYYY-MM-DD>", "thread:<id>", "groups:<chat>"]) assert.ok(fetch.description.includes(id), id);
  assert.match(search.description, /groups: true/);
  assert.deepEqual(six.resolve("fetch", { id: "day:2026-11-09", args: { part: 2 } }), { name: "read_day", args: { day: "2026-11-09", part: 2 } });
  assert.deepEqual(six.resolve("fetch", { id: "thread:t3" }), { name: "read_thread", args: { thread: "t3" } });
  assert.deepEqual(six.resolve("fetch", { id: "groups:" }), { name: "group_chats", args: { op: "list" } });
  assert.deepEqual(six.resolve("fetch", { id: "groups:Tex Devs", args: { day: "2026-11-09" } }), { name: "group_chats", args: { op: "read", chat: "Tex Devs", day: "2026-11-09" } });
  assert.deepEqual(six.resolve("fetch", { id: "groups:Tex Devs", args: { from: "2026-11-09", to: "2026-11-15" } }), { name: "group_chats", args: { op: "summaries", chat: "Tex Devs", from: "2026-11-09", to: "2026-11-15" } });
  assert.deepEqual(six.resolve("fetch", { id: "groups:Family", args: { words: "texas" } }), { name: "group_chats", args: { op: "search", chat: "Family", words: "texas" } });
  assert.deepEqual(six.resolve("search", { query: "traveling to texas", args: { groups: true } }), { name: "group_chats", args: { op: "search", words: "traveling to texas" } });
  // Without the tool, none of it routes there: a turn that holds no group reader reads no group.
  const bare = sixToolsOver([notes, read]);
  assert.doesNotMatch(bare.tools.find((tool) => tool.name === "fetch")?.description ?? "", /groups:/);
  assert.notEqual(bare.resolve("search", { query: "texas", args: { groups: true } }).name, "group_chats");
  assert.notEqual(bare.resolve("fetch", { id: "groups:Family" }).name, "group_chats");
});

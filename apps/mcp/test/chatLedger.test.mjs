// The chat's ledger (Dev2, 2026-11-02): one versioned JSON record per chat in
// its Tex object, everything kept but another workspace's contents.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texLedger, LEDGER_SCHEMA, LEDGER_VERSION, MAX_ENTRY_BYTES } from "../src/texStore/ledger.js";
import { TexObjectRefused } from "../src/texStore/objects.js";
import { judgeEntry, ledgerObserver, keptArgs, ledgerFor, ledgerPlace, ledgerWriter, readsOtherWorkspace, toolEntry, wordsEntry, eventEntry, MAX_RESULT_CHARS, ONE_TO_ONE_CHAT } from "../src/agent/ledger.js";
import { durableSql, texStoreNamespace } from "./texStoreFixture.mjs";

const entry = (id, kind = "text", extra = {}) => ({ id, kind, at: 1_700_000_000_000 + Number(id.replace(/\D/g, "") || 0), ...extra });

test("a chat's ledger reads back as one document, manifest first, in the order it was written", () => {
  const ledger = texLedger(durableSql(), { now: () => 5 });
  ledger.append("texts", [entry("a1", "text", { text: "hi" }), entry("a2", "thinking", { text: "they said hi" })]);
  ledger.append("texts", [entry("a3", "reply", { text: "Hey!" })]);
  const read = ledger.read("texts");
  assert.equal(read.manifest.schema, LEDGER_SCHEMA);
  assert.equal(read.manifest.version, LEDGER_VERSION);
  assert.equal(read.manifest.count, 3);
  assert.deepEqual(read.entries.map((e) => [e.seq, e.id, e.kind, e.v]), [[1, "a1", "text", 1], [2, "a2", "thinking", 1], [3, "a3", "reply", 1]]);
});

test("a retried append keeps one copy of each entry", () => {
  const ledger = texLedger(durableSql());
  ledger.append("texts", [entry("a1"), entry("a2")]);
  const again = ledger.append("texts", [entry("a2"), entry("a3")]);
  assert.equal(again.added, 1);
  assert.deepEqual(ledger.read("texts").entries.map((e) => e.id), ["a1", "a2", "a3"]);
});

test("two chats in one object never read each other's entries", () => {
  const ledger = texLedger(durableSql());
  ledger.append("texts", [entry("a1")]);
  ledger.append("other", [entry("b1")]);
  assert.deepEqual(ledger.read("texts").entries.map((e) => e.id), ["a1"]);
  assert.deepEqual(ledger.chats().map((m) => m.chat), ["other", "texts"]);
});

test("a read pages on with after, keeps only the kinds asked, and reads newest first with before", () => {
  const ledger = texLedger(durableSql());
  ledger.append("texts", Array.from({ length: 10 }, (_, i) => entry(`e${i + 1}`, i % 2 ? "tool" : "text")));
  const first = ledger.read("texts", { limit: 4 });
  assert.deepEqual(first.entries.map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(first.next, 4);
  assert.deepEqual(ledger.read("texts", { after: first.next, limit: 3 }).entries.map((e) => e.seq), [5, 6, 7]);
  assert.deepEqual(ledger.read("texts", { kinds: ["tool"] }).entries.map((e) => e.seq), [2, 4, 6, 8, 10]);
  const newest = ledger.read("texts", { before: 11, limit: 3 });
  assert.deepEqual(newest.entries.map((e) => e.seq), [10, 9, 8]);
  assert.equal(newest.before, 8);
});

test("the ledger refuses an unknown kind, an entry with no id and an entry too large, keeping none of the call", () => {
  const ledger = texLedger(durableSql());
  assert.throws(() => ledger.append("texts", [entry("a1"), { id: "x", kind: "made_up" }]), TexObjectRefused);
  assert.throws(() => ledger.append("texts", [{ kind: "text" }]), TexObjectRefused);
  assert.throws(() => ledger.append("texts", [entry("big", "tool", { result: "x".repeat(MAX_ENTRY_BYTES) })]), TexObjectRefused);
  assert.throws(() => ledger.append("../x", [entry("a1")]), TexObjectRefused);
  assert.equal(ledger.read("texts").entries.length, 0);
});

test("wiping the object removes every ledger", async () => {
  const tex = texStoreNamespace();
  const ledger = ledgerFor({ TEX_STORE: tex.namespace }, { person: "ws1" });
  await ledger.append("texts", [entry("a1")]);
  assert.equal((await ledger.read("texts")).entries.length, 1);
  const object = tex.object("person:ws1");
  await object.fetch(new Request("https://tex-store.internal/wipe", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "wipe" })), "x-tex-owner": "person:ws1" } }));
  assert.equal((await ledger.read("texts")).entries.length, 0);
});

test("through the gateway, a person's and a group's ledgers live in their own objects", async () => {
  const tex = texStoreNamespace();
  const env = { TEX_STORE: tex.namespace };
  const group = "a".repeat(64);
  await ledgerFor(env, { person: "ws1" }).append("texts", [entry("p1")]);
  await ledgerFor(env, { chat: group }).append(group, [entry("g1")]);
  assert.deepEqual((await ledgerFor(env, { person: "ws1" }).read("texts")).entries.map((e) => e.id), ["p1"]);
  assert.deepEqual((await ledgerFor(env, { chat: group }).read(group)).entries.map((e) => e.id), ["g1"]);
  assert.deepEqual([...new Set(tex.calls.map((call) => call.name))].sort(), [`chat:${group}`, "person:ws1"]);
});

test("an open page is told which kinds changed", async () => {
  const tex = texStoreNamespace();
  const object = tex.object("person:ws1");
  object.ready();
  const told = [];
  object.objects.ledgerChanged = (kinds) => told.push(kinds);
  await ledgerFor({ TEX_STORE: tex.namespace }, { person: "ws1" }).append("texts", [entry("a1", "advisor")]);
  assert.deepEqual(told, [["advisor"]]);
});

test("a session's ledger is the group's in a group and the person's one chat on their personal workspace", () => {
  const group = "b".repeat(64);
  assert.deepEqual(ledgerPlace({ texChatId: group, workspaceKind: "shared", workspaceId: "w" }), { owner: { chat: group }, chat: group });
  assert.deepEqual(ledgerPlace({ workspaceKind: "personal", workspaceId: "ws1" }), { owner: { person: "ws1" }, chat: ONE_TO_ONE_CHAT });
  assert.equal(ledgerPlace({ workspaceKind: "shared", workspaceId: "w" }), null);
});

test("a tool call keeps its arguments and result, and secrets stay hidden", () => {
  const kept = toolEntry({ name: "search", args: { query: "dentist", password: "hunter2" }, ok: true, ms: 12.4, result: "Thursday 3pm" }, { ownSlug: "ada" });
  assert.equal(kept.kind, "tool");
  assert.deepEqual(kept.args, { query: "dentist", password: "[hidden]" });
  assert.equal(kept.result, "Thursday 3pm");
  assert.equal(kept.ms, 12);
  assert.equal(kept.withheld, undefined);
  assert.deepEqual(keptArgs({ nested: { api_key: "k", ok: [1, { token: "t" }] } }), { nested: { api_key: "[hidden]", ok: [1, { token: "[hidden]" }] } });
});

test("a call that read another workspace keeps what it asked for, never what came back", () => {
  const other = toolEntry({ name: "fetch", args: { id: "plans.md", context: "@acme" }, ok: true, ms: 5, result: "Acme's secret plans" }, { ownSlug: "ada" });
  assert.equal(other.withheld, "other_workspace");
  assert.equal(other.result, undefined);
  assert.deepEqual(other.args, { id: "plans.md", context: "@acme" });
  assert.ok(!JSON.stringify(other).includes("secret plans"));
  // Its own workspace named outright is still its own.
  assert.equal(toolEntry({ name: "fetch", args: { context: "@Ada" }, ok: true, result: "mine" }, { ownSlug: "ada" }).result, "mine");
  assert.equal(readsOtherWorkspace({ context: "@ada" }, null), true, "no known own workspace: a named one is treated as another");
  assert.equal(readsOtherWorkspace({}, null), false);
});

test("a very long result is kept cut, with its full length", () => {
  const long = toolEntry({ name: "browse", args: {}, ok: true, result: "x".repeat(MAX_RESULT_CHARS + 10) }, { ownSlug: "ada" });
  assert.equal(long.result.length, MAX_RESULT_CHARS);
  assert.equal(long.cut, MAX_RESULT_CHARS + 10);
});

test("an event keeps its id, so the same text is kept once however often it is written", async () => {
  const tex = texStoreNamespace();
  const ledger = ledgerFor({ TEX_STORE: tex.namespace }, { person: "ws1" });
  const event = { id: "1700000000000-000001", at: 1_700_000_000_000, chat: "c", from: { kind: "person", name: "ada" }, kind: "text", text: "hi" };
  await ledger.append("texts", [eventEntry(event)]);
  await ledger.append("texts", [eventEntry(event)]);
  const read = await ledger.read("texts");
  assert.equal(read.entries.length, 1);
  assert.equal(read.entries[0].text, "hi");
  assert.equal(read.entries[0].event, "text");
});

test("the writer keeps order, never throws, and logs a failed write without its words", async () => {
  const seen = [];
  let fail = true;
  const writer = ledgerWriter({ append: async (_chat, entries) => {
    if (fail) { fail = false; throw new Error("down"); }
    seen.push(...entries.map((e) => e.text));
  } }, "texts");
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(line);
  try {
    writer.write(wordsEntry("note", "first, lost"));
    writer.write([wordsEntry("note", "second"), wordsEntry("note", "third")]);
    await writer.flush();
  } finally {
    console.log = log;
  }
  assert.deepEqual(seen, ["second", "third"]);
  assert.equal(logged.length, 1);
  assert.ok(!logged[0].includes("first, lost"));
});

test("a judging of a draft is kept as a judge entry: the draft, each judge, whether it went (2026-11-05)", () => {
  const written = [];
  const observe = ledgerObserver({ write: (entry) => written.push(entry) }, null, { turn: "t1" });
  observe({ kind: "judge", by: "gates", model: "@cf/cloudflare/clef-flash", round: 0, draft: "Here's the icon.", went: false, ms: 1412.4, notice: "Fix it.", judges: [{ id: "heard_them", yes: 0.82, at: 0.7, passed: false }, { id: "finished", yes: 0.19, at: 0.35, passed: true }, { id: "sourced", yes: null, at: 0.35, passed: true }], failed: ["heard_them"] });
  const [kept] = written;
  assert.equal(kept.kind, "judge");
  assert.equal(kept.turn, "t1");
  assert.equal(kept.text, "Here's the icon.");
  assert.equal(kept.went, false);
  assert.equal(kept.ms, 1412);
  assert.equal(kept.notice, "Fix it.");
  assert.deepEqual(kept.failed, ["heard_them"]);
  assert.deepEqual(kept.judges[2], { id: "sourced", yes: null, at: 0.35, passed: true }, "a judge that didn't answer is kept as no score");
  const ledger = texLedger(durableSql());
  ledger.append("texts", [kept]);
  assert.equal(ledger.read("texts").entries[0].kind, "judge", "the ledger keeps the kind");
  assert.equal(judgeEntry({ by: "code", round: 1, draft: "x", went: false }).by, "code");
});

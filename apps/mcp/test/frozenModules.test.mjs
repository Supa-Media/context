/**
 * THE FREEZE (Dev2, 2026-11-20, the cache rules: "until the next summary, the tools, system prompt and first message
 * stay byte-identical"; `src/agent/frozenModules.js`, `packages/tex/gateway/texStore/frozen.js`): a step set to `freeze: "summary"`
 * sends its rarely-changing modules with the words of the chat's first turn of the day, so a mid-day edit to the
 * group's playbook or About me no longer rewrites the cached history after it; what changed since is said after the
 * history and wins. Sabotage: drop `put(kept)` in `turnPrompt.js` `freezeModules` and "the system keeps the day's
 * words" fails; drop the copy of `threadParts` and "every round of a turn" fails; drop the day check in
 * `frozenModules` and "the next day freezes anew" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { turnPrompt } from "../src/agent/turnPrompt.js";
import { frozenModules, summaryDay } from "../src/agent/frozenModules.js";
import { FROZEN_MODULES } from "../src/agent/frozenModuleNames.js";
import { TEX_CONFIG as CONFIG, texFreeze, withDraft } from "../src/agent/texConfig.js";
import { texFrozen, FROZEN_FRESH_MS } from "../../../packages/tex/gateway/texStore/frozen.js";
import { TexObjectRefused } from "../../../packages/tex/gateway/texStore/objects.js";
import { durableSql, texStoreNamespace } from "./texStoreFixture.mjs";
import { ledgerFor } from "../src/agent/ledger.js";

const NOW = Date.UTC(2026, 10, 20, 15, 0, 0);
const base = { texting: true, pictures: false, notes: null, models: null, tools: [], history: [], threadNote: [["group", "\n\nThe group's playbook: morning."], ["learned", ""]], turnNote: "", webNames: new Set(), progress: null, aboutMe: null, identity: null, jobs: null, voice: null, calendar: null, observe: false, workspaces: [], groups: "\n\nTheir groups: Book club.", devShare: "", mail: null, localNow: { now: NOW, timeZone: "UTC" }, plan: null, nudge: "" };
const said = (o) => turnPrompt(null, "anthropic/claude-haiku-5-5", { ...base, ...o });

test("the day's first turn keeps its words and sends them unchanged", () => {
  let seen = null;
  const freeze = { modules: null, see: (current) => (seen = current) };
  const plain = said({});
  const first = said({ freeze });
  assert.equal(first.system.context, plain.system.context);
  assert.equal(first.preamble, plain.preamble, "nothing changed yet: no note");
  assert.equal(seen["context/thread/group"], "\n\nThe group's playbook: morning.");
  assert.equal(seen["context/groups"], "\n\nTheir groups: Book club.");
});

test("the system keeps the day's words, and what changed is said after the history", () => {
  const morning = said({}).system.context;
  const kept = { "context/thread/group": "\n\nThe group's playbook: morning.", "context/groups": "\n\nTheir groups: Book club." };
  const later = { threadNote: [["group", "\n\nThe group's playbook: afternoon."], ["learned", ""]], groups: "" };
  const frozen = said({ ...later, freeze: { modules: kept } });
  assert.equal(frozen.system.context, morning, "byte for byte the morning's");
  assert.notEqual(said(later).system.context, morning, "without the freeze it would have changed");
  assert.match(frozen.preamble, /these are now, and win/);
  assert.match(frozen.preamble, /This group chat \(its people, rules and playbook\) now reads:\nThe group's playbook: afternoon\./);
  assert.equal(frozen.preamble.includes("Their group chats now reads"), false, "a module with no words this turn was not read: the day's words stand");
  assert.ok(frozen.prompt.modules.some((m) => m.id === "preamble/frozen"), "the note is in the manifest");
});

test("every round of a turn sends the same frozen words and the same note", () => {
  const threadNote = [["group", "\n\nThe group's playbook: afternoon."], ["learned", ""]];
  const freeze = { modules: { "context/thread/group": "\n\nThe group's playbook: morning." } };
  const one = said({ threadNote, freeze });
  const two = said({ threadNote, freeze });
  assert.equal(two.system.context, one.system.context);
  assert.equal(two.preamble, one.preamble);
  assert.equal(threadNote[0][1], "\n\nThe group's playbook: afternoon.", "the caller's parts are not changed");
});

test("only the slow modules freeze", () => {
  assert.ok(!FROZEN_MODULES.includes("context/thread/job"), "a job's brief is its own");
  assert.ok(!FROZEN_MODULES.includes("context/jobs"));
  const kept = { "context/thread/group": "\n\nThe group's playbook: morning.", "context/groups": base.groups };
  const out = said({ threadNote: [["group", "\n\nThe group's playbook: morning."], ["job", "\n\nJob: book flights."]], freeze: { modules: kept } });
  assert.match(out.system.context, /Job: book flights/);
  assert.equal(out.preamble.includes("now reads"), false);
});

test("the chat's home keeps one day's words per step, fresh for two days, wiped with the ledger", () => {
  let now = NOW;
  const store = texFrozen(durableSql(), { now: () => now });
  store.put("texts", "fd", { day: "2026-11-20", modules: { "context/aboutMe": "x", bad: 3 } });
  assert.deepEqual(store.get("texts", "fd"), { day: "2026-11-20", modules: { "context/aboutMe": "x" } });
  assert.equal(store.get("texts", "job"), null, "another step's");
  assert.equal(store.get("other", "fd"), null, "another chat's");
  assert.throws(() => store.put("texts", "fd", { day: "today", modules: {} }), TexObjectRefused);
  assert.throws(() => store.put("texts", "FD!", { day: "2026-11-20", modules: {} }), TexObjectRefused);
  assert.throws(() => store.put("texts", "fd", { day: "2026-11-20", modules: { a: "x".repeat(1_100_000) } }), TexObjectRefused);
  now += FROZEN_FRESH_MS + 1;
  assert.equal(store.get("texts", "fd"), null, "stale");
  now = NOW;
  store.put("texts", "fd", { day: "2026-11-20", modules: {} });
  store.wipe();
  assert.equal(store.get("texts", "fd"), null);
});

function homeStore() {
  const rows = new Map();
  const home = { frozenOf: async (chat, step) => rows.get(`${chat}/${step}`) ?? null, keepFrozen: async (chat, step, data) => void rows.set(`${chat}/${step}`, data) };
  return { rows, store: { texLedger: () => home } };
}
const session = { workspaceKind: "personal", workspaceId: "ws_1" };

test("the next day freezes anew, and a step that reads each turn or a chat with no home is not frozen", async () => {
  const { rows, store } = homeStore();
  const log = () => {};
  assert.equal(await frozenModules({ store, session, step: "fd", freeze: "turn", now: NOW, log }), null);
  assert.equal(await frozenModules({ store: {}, session, step: "fd", freeze: "summary", now: NOW, log }), null);
  assert.equal(await frozenModules({ store, session: { workspaceKind: "shared", workspaceId: "ws_2" }, step: "fd", freeze: "summary", now: NOW, log }), null);
  const first = await frozenModules({ store, session, step: "fd", freeze: "summary", now: NOW, timeZone: "UTC", log });
  assert.equal(first.modules, null);
  await first.see({ "context/aboutMe": "Likes tea." });
  assert.equal(first.modules["context/aboutMe"], "Likes tea.", "later rounds of the same turn send the same words");
  await first.see({ "context/aboutMe": "Likes coffee." });
  assert.equal([...rows.values()][0].modules["context/aboutMe"], "Likes tea.", "kept once");
  const later = await frozenModules({ store, session, step: "fd", freeze: "summary", now: NOW + 3_600_000, timeZone: "UTC", log });
  assert.equal(later.modules["context/aboutMe"], "Likes tea.");
  const tomorrow = await frozenModules({ store, session, step: "fd", freeze: "summary", now: NOW + 86_400_000, timeZone: "UTC", log });
  assert.equal(tomorrow.modules, null, "a new day's first turn");
  assert.equal(summaryDay(Date.UTC(2026, 10, 21, 3, 0), "America/New_York"), "2026-11-20", "the person's own day");
});

test("main reads every turn, and a draft can freeze the front door and the job step", () => {
  assert.equal(texFreeze("fd"), "turn");
  assert.equal(texFreeze("job"), "turn");
  const draft = { nodes: CONFIG.nodes.map((node) => (node.id === "fd" ? { ...node, freeze: "summary" } : node.id === "job" ? { ...node, freeze: "sideways" } : node)), edges: CONFIG.edges };
  const drafted = withDraft(CONFIG, draft);
  assert.equal(texFreeze("fd", drafted), "summary");
  assert.equal(texFreeze("job", drafted), "turn", "a value the gateway can't run is main's");
});

test("the frozen words go through the chat's own home, never another's, and go with a wipe", async () => {
  const tex = texStoreNamespace();
  const env = { TEX_STORE: tex.namespace };
  const day = { day: "2026-11-20", modules: { "context/aboutMe": "Likes tea." } };
  await ledgerFor(env, { person: "ws1" }).keepFrozen("texts", "fd", day);
  assert.deepEqual(await ledgerFor(env, { person: "ws1" }).frozenOf("texts", "fd"), day);
  assert.equal(await ledgerFor(env, { person: "ws2" }).frozenOf("texts", "fd"), null, "another person's home has none of it");
  await tex.object("person:ws1").fetch(new Request("https://tex-store.internal/wipe", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "wipe" })), "x-tex-owner": "person:ws1" } }));
  assert.equal(await ledgerFor(env, { person: "ws1" }).frozenOf("texts", "fd"), null);
});

/**
 * A GROUP CHAT'S GUEST NAMES, READ FROM THE CHAT (Dev2, 2026-11-27; `guestNamePass.js`, the shelf node `guestNames`).
 *
 * In the launch-day rehearsal Tunde wrote "Diego you said 2 hrs right?" under Diego's text, and Tex went on calling
 * Diego by his number. The pass reads the newest lines with a small model and keeps a name only where code can check
 * it: the line the model cites says the name and is the guest's own, a reply typed under their text, or names their
 * label. All people and words are invented.
 *
 * Sabotage record (2026-11-27), each applied, this file run, named test failing, reverted:
 *  1. `checkedNames` without the own/under/label check → "a name said to the room is nobody's" fails.
 *  2. `checkedNames` not skipping a kept name → "a name already kept is never replaced" fails.
 *  3. `nameGuestsFromChat` without the recent-unnamed check → "a chat whose guests are all named asks no model" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkedNames, nameGuestsFromChat, readNames, renderLines, saysName } from "../../../packages/tex/gateway/agent/guestNamePass.js";
import { guestNameEntry } from "../../../packages/tex/gateway/agent/groupGuestNames.js";

const DIEGO = "guest-1a2b";
const KEMI = "guest-3c4d";
const line = (id, from, text, extra = {}) => ({ v: 1, id: `ev${id}`, eid: id, at: Number(id.replace(/\D/g, "")) || 1, kind: "text", from, text, ...extra });
const guest = (label) => ({ kind: "person", name: label });
const member = (handle) => ({ kind: "person", name: handle });

function memoryLedger(entries) {
  const kept = [...entries];
  return {
    kept,
    async read(_chat, { kinds, limit }) {
      const out = kept.filter((entry) => kinds.includes(entry.kind)).sort((a, b) => b.at - a.at).slice(0, limit);
      return { entries: out };
    },
    async append(_chat, added) {
      kept.push(...added);
    },
  };
}

const CHAT = [
  line("m1", member("tunde"), "ok Tex find us a cabin near a lake"),
  line("m2", guest(DIEGO), "poconos! driving distance from nyc"),
  line("m3", member("tunde"), "Diego you said 2 hrs right?", { replyTo: "m2" }),
  line("m4", guest(KEMI), "lol yes do it"),
  line("m5", member("tunde"), "Marcus and Jade are in too"),
];

test("a reply typed under a guest's text names that guest", () => {
  const names = checkedNames([{ guest: DIEGO, name: "Diego", line: "m3" }], CHAT, new Map());
  assert.deepEqual(names, [{ guest: DIEGO, name: "Diego", by: "tunde" }]);
});

test("a name said to the room is nobody's, and a line that doesn't say it ties nothing", () => {
  assert.deepEqual(checkedNames([{ guest: KEMI, name: "Marcus", line: "m5" }], CHAT, new Map()), []);
  assert.deepEqual(checkedNames([{ guest: DIEGO, name: "Dieguito", line: "m3" }], CHAT, new Map()), []);
  assert.deepEqual(checkedNames([{ guest: DIEGO, name: "Diego", line: "m9" }], CHAT, new Map()), [], "a line it wasn't shown");
});

test("a guest's own line can name them", () => {
  const own = [...CHAT, line("m6", guest(KEMI), "it's Kemi btw")];
  assert.deepEqual(checkedNames([{ guest: KEMI, name: "Kemi", line: "m6" }], own, new Map()), [{ guest: KEMI, name: "Kemi", by: KEMI }]);
});

test("a name already kept is never replaced, and no guest takes a member's or another guest's name", () => {
  assert.deepEqual(checkedNames([{ guest: DIEGO, name: "Diego", line: "m3" }], CHAT, new Map([[DIEGO, "Dee"]])), []);
  assert.deepEqual(checkedNames([{ guest: DIEGO, name: "Diego", line: "m3" }], CHAT, new Map([[KEMI, "Diego"]])), []);
  assert.deepEqual(checkedNames([{ guest: DIEGO, name: "Tunde", line: "m3" }], [...CHAT.slice(0, 2), line("m3", member("sam"), "Tunde you said 2 hrs?", { replyTo: "m2" })], new Map(), ["Tunde"]), []);
});

test("a name is a whole word of the line, and the model's answer is read strictly", () => {
  assert.equal(saysName("Diego you said", "Diego"), true);
  assert.equal(saysName("Diegos place", "Diego"), false);
  assert.deepEqual(readNames('sure: {"names":[{"guest":"guest-1a2b","name":"Diego","line":"m3"}]}'), [{ guest: DIEGO, name: "Diego", line: "m3" }]);
  assert.deepEqual(readNames("no idea"), []);
  assert.deepEqual(readNames('{"names":"Diego"}'), []);
});

test("the model reads each line with its id and the line a reply was typed under, labels for the unnamed", () => {
  const shown = renderLines(CHAT, new Map([[KEMI, "Kemi"]]));
  assert.match(shown, /\[m3\] tunde \(reply to \[m2\]\): Diego you said 2 hrs right\?/);
  assert.match(shown, /\[m4\] Kemi: lol yes do it/);
});

test("one pass keeps what it found in the chat's ledger as a name entry", async () => {
  const ledger = memoryLedger(CHAT);
  const asked = [];
  const out = await nameGuestsFromChat({
    ledger,
    chat: "group:abc",
    config: { stub: true },
    words: { "guest-names": "Find the names." },
    request: async (call) => (asked.push(call), { text: '{"names":[{"guest":"guest-1a2b","name":"Diego","line":"m3"},{"guest":"guest-3c4d","name":"Marcus","line":"m5"}]}' }),
  });
  assert.deepEqual(out, { outcome: "done", found: 2, kept: 1 });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].system, "Find the names.");
  assert.equal(asked[0].model, "anthropic/claude-haiku-5-5");
  const names = ledger.kept.filter((entry) => entry.kind === "name");
  assert.deepEqual(names.map(({ guest: g, name, by }) => ({ g, name, by })), [{ g: DIEGO, name: "Diego", by: "tunde" }]);
});

test("a chat whose guests are all named asks no model", async () => {
  const ledger = memoryLedger([...CHAT, guestNameEntry(DIEGO, "Diego", { at: 1 }), guestNameEntry(KEMI, "Kemi", { at: 1 })]);
  let asked = 0;
  const out = await nameGuestsFromChat({ ledger, chat: "group:abc", config: { stub: true }, words: { "guest-names": "x" }, request: async () => (asked++, { text: "{}" }) });
  assert.equal(out.outcome, "nobody_unnamed");
  assert.equal(asked, 0);
});

test("a model that fails or a ledger that can't be read writes nothing and never throws", async () => {
  const ledger = memoryLedger(CHAT);
  assert.deepEqual(await nameGuestsFromChat({ ledger, chat: "group:abc", config: { stub: true }, words: { "guest-names": "x" }, request: async () => { throw new Error("down"); } }), { outcome: "model_failed" });
  const broken = { read: async () => { throw new Error("x"); }, append: async () => {} };
  assert.deepEqual(await nameGuestsFromChat({ ledger: broken, chat: "group:abc", config: { stub: true }, words: {}, request: async () => ({}) }), { outcome: "unread" });
  assert.equal(ledger.kept.filter((entry) => entry.kind === "name").length, 0);
});

/**
 * Node "edit" (Dev2, 2026-11-16: "Build edit support in Tex", "not just edits but deleted messages as well"): what a
 * person's edit or unsend of a text is, `/texts/edit` running it on the config's graph, how the log keeps one, and how
 * the transcript shows it to the model.
 *
 * Sabotage (applied, run, observed failing, reverted, 2026-11-16):
 *  1. `editNode` answering "turn" for unchanged words → "an edit that changed nothing is nothing…".
 *  2. `words` dropping the edit's mark → "the transcript marks an edit and names the text it changed".
 *  3. `checkEvent` taking `edited` from Tex → "only a person's own text is ever an edit".
 */
import assert from "node:assert/strict";
import test from "node:test";

import { editNode } from "../src/agent/graph/nodes/edit.js";
import { editForTexts } from "../src/agent/textsEdit.js";
import { checkEvent, EventRefusal } from "../src/agent/log.js";
import { renderEvents } from "../src/agent/logRender.js";

const one = (over) => ({ kind: "one", change: "edit", ...over });

test("an edit that changed nothing is nothing, and any other goes on as a text: whether it is answered is Decide's", async () => {
  assert.equal((await editNode(one({ words: "Dinner at 6?", earlier: "dinner at 6? " }))).to, "same");
  assert.deepEqual(await editNode(one({ words: "dinner at 6 tonight?", earlier: "dinner at 6 tonigt?" })), { to: "turn", why: "the words changed" }, "a fixed typo too: the judge's examples teach it to stay quiet");
  assert.equal((await editNode(one({ words: "call me at 11:30", earlier: "call me at 10:30" }))).to, "turn");
  assert.deepEqual(await editNode(one({ words: "dinner at 7" })), { to: "turn", why: "the words before are not known" });
  assert.equal((await editNode(one({ words: "  " }))).to, "same");
});

test("an unsend is always taken back, in a 1:1 or a group", async () => {
  assert.deepEqual(await editNode({ kind: "group", change: "unsend", earlier: "anything" }), { to: "withdraw", why: "they took the text back" });
  assert.equal((await editNode({ kind: "one", change: "unsend" })).to, "withdraw");
});

const post = (body) => new Request("https://gateway/texts/edit", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

test("/texts/edit runs the node on the config's graph, and refuses a body its inSchema does not take", async () => {
  const ran = await editForTexts(post(one({ words: "lunch on friday instead", earlier: "dinner at 6 tonight?" })));
  assert.equal(ran.status, 200);
  assert.deepEqual(await ran.json(), { to: "turn", why: "the words changed" });
  assert.equal((await editForTexts(post({ kind: "one", change: "rewrite", words: "x" }))).status, 422);
  assert.equal((await editForTexts(post({ kind: "one", change: "edit", words: "x", secret: "y" }))).status, 422);
  assert.equal((await editForTexts(post("{"))).status, 400);
  assert.equal((await editForTexts(new Request("https://gateway/texts/edit"))).status, 400);
});

const NOW = Date.UTC(2026, 10, 16, 15, 0, 0);
const id = (at, n) => `${at}-${String(n).padStart(6, "0")}`;
const person = { kind: "person", who: "a".repeat(64) };

test("only a person's own text is ever an edit or an unsend, and an unsend carries no words", () => {
  const base = { id: id(NOW, 1), at: NOW, chat: "c", from: person, kind: "text", text: "new words" };
  assert.equal(checkEvent({ ...base, edited: true, replyTo: id(NOW - 1, 2), quoted: "old" }, { chat: "c", now: NOW }).edited, true);
  assert.equal(checkEvent({ ...base, text: "", unsent: true }, { chat: "c", now: NOW }).unsent, true);
  assert.throws(() => checkEvent({ ...base, from: { kind: "tex" }, edited: true }, { chat: "c", now: NOW }), EventRefusal);
  assert.throws(() => checkEvent({ ...base, edited: "yes" }, { chat: "c", now: NOW }), EventRefusal);
  assert.throws(() => checkEvent({ ...base, unsent: true }, { chat: "c", now: NOW }), EventRefusal, "an unsend with words");
  assert.throws(() => checkEvent({ ...base, text: "", unsent: true, edited: true }, { chat: "c", now: NOW }), EventRefusal);
  assert.throws(() => checkEvent({ ...base, kind: "reaction", edited: true }, { chat: "c", now: NOW }), EventRefusal);
});

test("the transcript marks an edit and names the text it changed, an unsend the text taken back, and neither is a to-do", () => {
  const first = { id: id(NOW, 1), at: NOW, chat: "c", from: person, kind: "text", text: "dinner at 6 tonight?" };
  const edit = { id: id(NOW + 60_000, 2), at: NOW + 60_000, chat: "c", from: person, kind: "text", text: "lunch friday instead?", edited: true, replyTo: first.id, quoted: first.text };
  const gone = { id: id(NOW + 120_000, 3), at: NOW + 120_000, chat: "c", from: person, kind: "text", text: "", unsent: true, replyTo: edit.id };
  const shown = renderEvents([first, edit, gone], { timeZone: "UTC" });
  assert.match(shown, /\(edited an earlier text to\) lunch friday instead\?/);
  assert.match(shown, /\(the edit of their 3:00 PM message, which said: "dinner at 6 tonight\?"\)/);
  assert.match(shown, /\(unsent an earlier text\)/);
  assert.match(shown, /\(they took back their 3:01 PM message, which said: "\(edited an earlier text to\) lunch friday instead\?"\)/);
  assert.equal(shown.match(/not answered/g)?.length, 1, "only the first text is waiting on Tex");
  // A text outside what is shown keeps its words outside it, as a reply's does.
  const alone = renderEvents([edit], { timeZone: "UTC" });
  assert.match(alone, /the edit of an earlier message not shown here/);
  assert.doesNotMatch(alone, /dinner at 6/);
});

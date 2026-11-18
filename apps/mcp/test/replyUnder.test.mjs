import test from "node:test";
import assert from "node:assert/strict";

import { splitUnder, underNote, underOf, withoutMarks } from "../src/agent/replyUnder.js";

// Battle of the Bots, 2026-11-17: "tex, say alpha" and "tex, say bravo" answered in one turn.
const alpha = { id: "1794970601459-000882", from: { kind: "person", name: "guest-66ef" }, text: "tex, say alpha" };
const bravo = { id: "1794970602028-000885", from: { kind: "person", name: "guest-66ef" }, text: "tex, say bravo" };

test("a group turn answering two texts is shown them numbered; one text, a 1:1 or no log gets no note", () => {
  const note = underNote([alpha, bravo], { group: true });
  assert.match(note, /\[1\] @guest-66ef: tex, say alpha/);
  assert.match(note, /\[2\] @guest-66ef: tex, say bravo/);
  assert.equal(underNote([bravo], { group: true }), "");
  assert.equal(underNote([alpha, bravo], { group: false }), "");
  assert.equal(underNote(undefined, { group: true }), "");
  // Tex's own texts and empty ones are never numbered.
  assert.equal(underNote([alpha, { id: "1794970611270-000890", from: { kind: "tex" }, text: "alpha" }], { group: true }), "");
});

test("numbered paragraphs go under their own texts, and no number reaches the chat", () => {
  const { answer, parts } = splitUnder("[1] alpha\n\n[2] bravo", [alpha, bravo]);
  assert.equal(answer, "alpha\n\nbravo");
  assert.deepEqual(parts, [{ under: alpha.id, text: "alpha" }, { under: bravo.id, text: "bravo" }]);
});

test("a paragraph after a number stays with it; one before any number goes where it always went", () => {
  const { parts } = splitUnder("Both coming up.\n\n[1] alpha\nstill alpha\n\nmore on alpha\n\n[2] bravo", [alpha, bravo]);
  assert.deepEqual(parts, [
    { under: null, text: "Both coming up." },
    { under: alpha.id, text: "alpha\nstill alpha\n\nmore on alpha" },
    { under: bravo.id, text: "bravo" },
  ]);
});

test("no numbers, or a turn answering one text, changes nothing", () => {
  assert.deepEqual(splitUnder("alpha\n\nbravo", [alpha, bravo]), { answer: "alpha\n\nbravo", parts: null });
  // One text: a "[1]" the person might have asked for is left as written.
  assert.deepEqual(splitUnder("[1] first step", [bravo]), { answer: "[1] first step", parts: null });
  // A number past the texts answered is taken out and threads nowhere new.
  assert.deepEqual(splitUnder("[7] alpha", [alpha, bravo]), { answer: "alpha", parts: null });
  assert.equal(withoutMarks("[2] bravo\n  [1] alpha"), "bravo\n  alpha");
});

test("the gateway's own lines after the answer go with its last part; a changed answer threads nothing", () => {
  const { answer, parts } = splitUnder("[1] alpha\n\n[2] bravo", [alpha, bravo]);
  assert.deepEqual(underOf(parts, answer, `${answer}\n\nSend it? 👍 or 👎?`), [
    { under: alpha.id, text: "alpha" },
    { under: bravo.id, text: "bravo\n\nSend it? 👍 or 👎?" },
  ]);
  assert.equal(underOf(parts, answer, "Something else entirely"), null);
  assert.equal(underOf(null, answer, answer), null);
});

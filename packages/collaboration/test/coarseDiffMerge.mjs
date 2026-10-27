/**
 * A rewrite too large to diff finely must not decide a peer's edits away.
 *
 * `textDiff.js` gives up past a fixed edit length: characters, then lines,
 * then the changed middle swapped whole. Its own note says the saved text is
 * exact at every tier, and it is. But `replay.js` does not use the diff to
 * build text; it reads the diff's *shape* to decide whether the writer's
 * replacement may be rebased onto the current document or whether the
 * exact-base merge keeps deciding. The coarsest tier reports one removed
 * middle, so a run the peer deleted no longer looks "mostly in one unchanged
 * stretch", `keepsDeletedRun` stops firing, and a peer who only deleted has
 * nothing gained to protect them: the replacement rebases and puts the text
 * they deleted back.
 *
 * The line tier has the same hole one size smaller: a run the peer deleted
 * from inside a line the writer also rewrote reads as rewritten, not kept, so
 * the replacement rebases and brings the run back.
 *
 * The rule: when the diff is too coarse to tell a peer's run from a rewritten
 * one, the replacement keeps the exact-base merge rather than rebasing.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { diffChars, diffLines } from "diff";
import { replayResolution } from "../src/replay.js";
import { CHAR_EDIT_LIMIT, LINE_EDIT_LIMIT } from "../src/textDiff.js";

/** A run the writer still has and a peer deleted. */
const KEPT = "Routing and account numbers stay exactly as written on this line.";

const body = (tag, count) =>
  Array.from({ length: count }, (_, at) => `${tag} row ${at}: a line long enough to be a change of its own`).join("\n");

const baseText = `${body("old", 1500)}\n${KEPT}\n${body("old tail", 1500)}`;
const rewritten = `${body("new", 1500)}\n${KEPT}\n${body("new tail", 1500)}`;
/** The same edit, small enough that the character tier still handles it. */
const nudged = baseText.replace("old row 0:", "fresh row 0:");

/** `base`, and `current` with the peer's deletion of `KEPT` applied. */
function peerDeletedKept() {
  const base = new Y.Doc();
  base.getText("note").insert(0, baseText);
  const current = new Y.Doc();
  Y.applyUpdate(current, Y.encodeStateAsUpdate(base));
  const text = current.getText("note");
  text.delete(text.toString().indexOf(KEPT), KEPT.length);
  return { base, current };
}

test("the rewrite really is past both finer tiers, so the coarsest one decides", () => {
  assert.equal(diffChars(baseText, rewritten, { maxEditLength: CHAR_EDIT_LIMIT }), undefined);
  assert.equal(diffLines(baseText, rewritten, { maxEditLength: LINE_EDIT_LIMIT }), undefined);
});

test("a small rewrite keeps the peer's deletion: the exact-base merge decides", () => {
  const { base, current } = peerDeletedKept();
  assert.equal(replayResolution(base, current, nudged), null);
});

test("a rewrite past the tiers keeps the peer's deletion too", () => {
  const { base, current } = peerDeletedKept();
  assert.equal(replayResolution(base, current, rewritten), null);
});

/** A run the peer deleted from inside a line the writer rewrote the rest of. */
const INLINE = "account 12345678";
const inlineBase = `${body("old", 100)}\nAlpha ${INLINE} Beta\n${body("old tail", 100)}`;
const inlineRewritten = `${body("new", 100)}\nAlpha ${INLINE} Gamma\n${body("new tail", 100)}`;

test("the inline rewrite really is past the character tier, so the line tier decides", () => {
  assert.equal(diffChars(inlineBase, inlineRewritten, { maxEditLength: CHAR_EDIT_LIMIT }), undefined);
  assert.notEqual(diffLines(inlineBase, inlineRewritten, { maxEditLength: LINE_EDIT_LIMIT }), undefined);
});

test("a run deleted from inside a rewritten line is not brought back", () => {
  const base = new Y.Doc();
  base.getText("note").insert(0, inlineBase);
  const current = new Y.Doc();
  Y.applyUpdate(current, Y.encodeStateAsUpdate(base));
  const text = current.getText("note");
  text.delete(text.toString().indexOf(INLINE), INLINE.length);
  assert.equal(text.toString().includes(INLINE), false);
  assert.equal(replayResolution(base, current, inlineRewritten), null);
});

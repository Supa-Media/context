/**
 * Tex's suggested edits in a comment thread (`packages/shared/src/comments.cjs`).
 *
 * A Tex run in a note answers in a comment thread and may propose new words
 * for the highlighted ones: a `suggests` line holding the replacement as a
 * JSON string. The person answers with Keep (the words are replaced and a
 * `kept` line is added) or Undo (an `undid` line, the words untouched). A
 * newer suggestion supersedes an older one, so a follow-up revises the
 * pending edit. ⌘L at a bare caret opens a thread on a point anchor.
 *
 * Sabotage record (temporary local edits, reverted; FAIL counts):
 *   pendingOf ignores `kept`/`undid`                                         2
 *   SUGGEST_RE checked after COMMENT_RE (reads as a comment by "Tex suggests") 6
 *   keepSuggestion drops other threads' markers inside the words              1
 *   `kept` flips thread.status                                                1
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import comments from "../../../packages/shared/src/comments.cjs";

const { addThread, appendEvent, applyChanges, keepSuggestion, parseComments, sanitizeAuthor, stripComments } = comments;
const AT = "2026-11-20T23:30:00Z";

function noteWithThread() {
  const text = "# Party\n\n- Snacks and drinks\n";
  const from = text.indexOf("Snacks");
  const made = addThread(text, { from, to: from + "Snacks and drinks".length, author: "@seyi", body: "@Tex add stuff from my grocery list", at: AT, id: "tex1" });
  return applyChanges(text, made.changes);
}

function apply(text, result) {
  assert.equal(result.error, undefined, result.error);
  return applyChanges(text, result.changes);
}

test("a suggestion is its own event, read back exactly, and is the pending edit", () => {
  let text = noteWithThread();
  text = apply(text, appendEvent(text, { thread: "tex1", kind: "comment", author: "Tex", body: "Added the 3 party items. Keep or undo?", at: AT }));
  const words = 'Snacks and drinks:\n• Chips "and" salsa\n• Sparkling water';
  text = apply(text, appendEvent(text, { thread: "tex1", kind: "suggestion", author: "Tex", body: words, at: AT }));
  assert.match(text, /- 2026-11-20T23:30:00Z Tex suggests: "Snacks and drinks:\\n/);
  const [thread] = parseComments(text).threads;
  assert.deepEqual(thread.events.map((e) => e.kind), ["comment", "comment", "suggestion"]);
  assert.equal(thread.events[2].author, "Tex");
  assert.equal(thread.events[2].text, words);
  assert.deepEqual(thread.pending, { text: words, at: AT, author: "Tex", index: 2 });
  assert.equal(thread.status, "open");
});

test("a newer suggestion revises the pending one", () => {
  let text = noteWithThread();
  text = apply(text, appendEvent(text, { thread: "tex1", kind: "suggestion", author: "Tex", body: "one", at: AT }));
  text = apply(text, appendEvent(text, { thread: "tex1", kind: "comment", author: "@seyi", body: "drop the plates", at: AT }));
  text = apply(text, appendEvent(text, { thread: "tex1", kind: "suggestion", author: "Tex", body: "two", at: AT }));
  assert.equal(parseComments(text).threads[0].pending.text, "two");
});

test("Keep replaces the anchored words, keeps the markers, and records who kept it", () => {
  let text = noteWithThread();
  text = apply(text, appendEvent(text, { thread: "tex1", kind: "suggestion", author: "Tex", body: "Chips and salsa", at: AT }));
  text = apply(text, keepSuggestion(text, { thread: "tex1", author: "@seyi", at: AT }));
  assert.match(text, /- <!--c:tex1-->Chips and salsa<!--\/c:tex1-->\n/);
  assert.match(text, /- 2026-11-20T23:30:00Z @seyi kept\n/);
  const [thread] = parseComments(text).threads;
  assert.equal(thread.pending, null);
  assert.equal(thread.status, "open");
  assert.equal(thread.events.at(-1).kind, "kept");
  assert.equal(stripComments(text), "# Party\n\n- Chips and salsa\n");
  assert.match(keepSuggestion(text, { thread: "tex1", author: "@seyi" }).error, /no suggested edit/);
});

test("Undo leaves the words alone and closes the suggestion", () => {
  let text = noteWithThread();
  text = apply(text, appendEvent(text, { thread: "tex1", kind: "suggestion", author: "Tex", body: "nope", at: AT }));
  const before = text.slice(0, text.indexOf("```comments"));
  text = apply(text, appendEvent(text, { thread: "tex1", kind: "undid", author: "@seyi", at: AT }));
  assert.equal(text.slice(0, text.indexOf("```comments")), before);
  assert.equal(parseComments(text).threads[0].pending, null);
  assert.match(appendEvent(text, { thread: "tex1", kind: "undid", author: "@seyi" }).error, /no suggested edit/);
  assert.match(appendEvent(text, { thread: "tex1", kind: "kept", author: "@seyi" }).error, /no suggested edit/);
});

test("kept and undid never change whether a thread is resolved", () => {
  let text = noteWithThread();
  text = apply(text, appendEvent(text, { thread: "tex1", kind: "suggestion", author: "Tex", body: "x", at: AT }));
  text = apply(text, appendEvent(text, { thread: "tex1", kind: "resolved", author: "@seyi", at: AT }));
  text = apply(text, keepSuggestion(text, { thread: "tex1", author: "@seyi", at: AT }));
  assert.equal(parseComments(text).threads[0].status, "resolved");
});

test("Keep never detaches another thread whose marker sits inside the words", () => {
  let text = noteWithThread();
  const from = text.indexOf("and drinks");
  text = apply(text, addThread(text, { from, to: from + 3, author: "@sayo", body: "hm", at: AT, id: "say2" }));
  text = apply(text, appendEvent(text, { thread: "tex1", kind: "suggestion", author: "Tex", body: "Chips", at: AT }));
  text = apply(text, keepSuggestion(text, { thread: "tex1", author: "@seyi", at: AT }));
  const anchors = parseComments(text).anchors;
  assert.ok(anchors.has("tex1"));
  assert.ok(anchors.has("say2"));
});

test("a point thread (⌘L at the caret) exists only when asked for", () => {
  const text = "# Party\n\nGuests\n";
  const at = text.indexOf("Guests");
  assert.match(addThread(text, { from: at, to: at, author: "@seyi", body: "@Tex hi" }).error, /empty/);
  const next = apply(text, addThread(text, { from: at, to: at, point: true, author: "@seyi", body: "@Tex hi", at: AT, id: "pnt1" }));
  const parsed = parseComments(next);
  const anchor = parsed.anchors.get("pnt1");
  assert.equal(anchor.from, anchor.to);
  assert.equal(parsed.threads[0].quote, "");
  assert.equal(parsed.threads[0].anchored, true);
  let suggested = apply(next, appendEvent(next, { thread: "pnt1", kind: "suggestion", author: "Tex", body: "Sayo +2", at: AT }));
  suggested = apply(suggested, keepSuggestion(suggested, { thread: "pnt1", author: "@seyi", at: AT }));
  assert.match(suggested, /<!--c:pnt1-->Sayo \+2<!--\/c:pnt1-->Guests/);
});

test("names ending in the new status words cannot forge a status line", () => {
  assert.equal(sanitizeAuthor("Mallory kept"), "Mallory kept.");
  assert.equal(sanitizeAuthor("Eve undid"), "Eve undid.");
  assert.equal(sanitizeAuthor("Tex suggests"), "Tex suggests.");
});

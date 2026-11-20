// The Connect node's code half (`packages/tex/gateway/agent/noteConnect.js`): which written notes it connects, which
// of the model's links it keeps, and how a link is written both ways under `## Connections` without touching any other
// line. The model half is scored by the bench's `link` lines (`bench/noteLinks.mjs`, Dev conversation study-threads).
//
// Sabotage record (temporary local edits, reverted): letting a navigation reason through ("a link without a reason
// ... is dropped" fails); writing the near note before checking the far one exists ("a link to a note that is not
// there writes nothing" fails); appending at the note's end when a Connections section exists ("a link lands at the
// end of Connections" fails).
import { test } from "node:test";
import assert from "node:assert/strict";

import { givesReason, linksOf, linksTo, noteName, notesToConnect, withConnection, writeLinks, connectNotes } from "../../../packages/tex/gateway/agent/noteConnect.js";
import { wroteOf } from "../../../packages/tex/gateway/agent/turnLog.js";

const J19 = "Study/Judges/Judges 19.md";
const G19 = "Study/Genesis/Genesis 19.md";

test("a turn's step names the notes a write saved, and only a write that worked", () => {
  assert.deepEqual(wroteOf({ name: "write_note", args: { path: J19 } }, {}), { wrote: [J19] });
  assert.deepEqual(wroteOf({ name: "save_many", args: { notes: [{ path: J19 }, { path: G19 }] } }, {}), { wrote: [J19, G19] });
  assert.deepEqual(wroteOf({ name: "write_note", args: { path: J19 } }, { isError: true }), {});
  assert.deepEqual(wroteOf({ name: "read_note", args: { path: J19 } }, {}), {});
  assert.deepEqual(wroteOf({ name: "write_note", args: { path: J19, context: "@team" } }, {}), {}, "another workspace's note is not theirs to connect");
});

test("only the person's own notes are connected: not Tex's, not plumbing, not a template", () => {
  assert.deepEqual(notesToConnect([J19, J19, "tex/about.md", ".context/x.md", "Study/Templates/Chapter study.md", "pic.png", G19]), [J19, G19]);
  assert.equal(notesToConnect(["a.md", "b.md", "c.md", "d.md"]).length, 3);
});

test("a link without a reason, to a template, or from a note the turn did not write is dropped", () => {
  assert.equal(givesReason("see also"), false);
  assert.equal(givesReason("the same crowd at a guest's door"), true);
  const answer = `Here: ${JSON.stringify([
    { from: J19, to: G19, why: "the same crowd at the door of a guest's house" },
    { from: J19, to: "Study/Judges/Judges 20.md", why: "next chapter" },
    { from: J19, to: "Study/Templates/Chapter study.md", why: "made from this template for the chapter study" },
    { from: G19, to: J19, why: "the same crowd at the door again" },
    { from: J19, to: G19, why: "duplicate of the first link here" },
    { from: J19, to: "Study/Ruth/Ruth 4.md", why: "the [[tribe]] of Judah\nagainst Benjamin" },
  ])}`;
  assert.deepEqual(linksOf(answer, [J19]), [
    { from: J19, to: G19, why: "the same crowd at the door of a guest's house" },
    { from: J19, to: "Study/Ruth/Ruth 4.md", why: "the tribe of Judah against Benjamin" },
  ]);
  assert.deepEqual(linksOf("no json here", [J19]), []);
  assert.equal(linksOf(JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ from: J19, to: `n${i}.md`, why: "shares the same named person here" }))), [J19]).length, 4);
});

test("a link lands at the end of Connections, every other line as it was", () => {
  const body = "# Judges 19\n\nPrevious: [[Judges 18]]\n\n## Connections\n\n- [[Ruth 4]]: Judah against Benjamin\n\n## Later\n\ntext\n";
  assert.equal(
    withConnection(body, "Genesis 19", "the same crowd at the door"),
    "# Judges 19\n\nPrevious: [[Judges 18]]\n\n## Connections\n\n- [[Ruth 4]]: Judah against Benjamin\n- [[Genesis 19]]: the same crowd at the door\n\n## Later\n\ntext\n"
  );
  assert.equal(withConnection("# A\n\n## Connections\n", "B", "why it is so here"), "# A\n\n## Connections\n\n- [[B]]: why it is so here\n");
  assert.equal(withConnection("# A\n\nbody", "B", "why it is so here"), "# A\n\nbody\n\n## Connections\n\n- [[B]]: why it is so here\n");
  assert.equal(withConnection("see [[genesis 19|G]] here", "Genesis 19", "x y z"), null, "a note already linked is left alone");
  assert.equal(linksTo("[[Study/Genesis/Genesis 19]]", "genesis 19"), true);
  assert.equal(noteName(G19), "Genesis 19");
});

/** A dispatcher over `notes` (path to text) that records writes. */
function fakeNotes(notes) {
  const writes = [];
  const dispatch = async (name, args) => {
    if (name === "read_note") {
      if (!Object.hasOwn(notes, args.path)) return { isError: true, content: [{ type: "text", text: "not found" }] };
      return { content: [{ type: "text", text: `etag: e-${args.path}\n\n${notes[args.path]}` }] };
    }
    if (name === "write_note") {
      if (args.expected_etag !== `e-${args.path}`) return { isError: true, content: [{ type: "text", text: "conflict" }] };
      writes.push(args.path);
      notes[args.path] = args.content;
      return { content: [{ type: "text", text: "saved" }] };
    }
    return { isError: true, content: [{ type: "text", text: "no" }] };
  };
  return { dispatch, writes, notes };
}

test("a link is written both ways; a link to a note that is not there writes nothing", async () => {
  const f = fakeNotes({ [J19]: "# Judges 19\n\n## Connections\n", [G19]: "# Genesis 19\n\nLot.\n" });
  const done = await writeLinks(f.dispatch, [
    { from: J19, to: G19, why: "the same crowd at the door" },
    { from: J19, to: "Study/Nowhere.md", why: "a note the model made up" },
  ]);
  assert.deepEqual(done.map((d) => [d.to, d.there, d.back]), [[G19, "written", "written"], ["Study/Nowhere.md", "skipped", "unread"]]);
  assert.match(f.notes[J19], /- \[\[Genesis 19\]\]: the same crowd at the door/);
  assert.match(f.notes[G19], /## Connections\n\n- \[\[Judges 19\]\]: the same crowd at the door/);
  assert.ok(!f.notes[J19].includes("Nowhere"));
  const again = await writeLinks(f.dispatch, [{ from: J19, to: G19, why: "the same crowd at the door" }]);
  assert.deepEqual([again[0].there, again[0].back], ["had", "had"], "a link already there is never written twice");
});

test("a turn that wrote nothing of theirs, read words from outside, or ran in a group connects nothing and calls no model", async () => {
  const never = async () => assert.fail("no call");
  assert.deepEqual(await connectNotes({ dispatch: never, paths: ["tex/about.md"] }), { outcome: "nothing_written" });
  assert.deepEqual(await connectNotes({ dispatch: never, paths: [J19], tainted: true }), { outcome: "tainted", notes: 1 });
  assert.deepEqual(await connectNotes({ dispatch: never, paths: [J19], group: true }), { outcome: "group", notes: 1 });
});

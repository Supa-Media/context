/**
 * The learned skills' index in two calls (`src/agent/learnedSkills.js`
 * `readLearnedSkills`): a texted turn lists `tex/skills/`, then reads every
 * skill in one `read_notes`, and reads on its own only a skill that call could
 * not answer. On 2026-11-03 a cold text spent 750 ms reading ten skills one
 * `read_note` each.
 *
 * Sabotage: read each skill with `read_note` again → "the index is one listing
 * and one read_notes"; take a part answered for another path → "a part for a
 * path not asked for, an error or a moved note is read on its own".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readLearnedSkills } from "../src/agent/learnedSkills.js";

const ok = (text) => ({ content: [{ type: "text", text }] });
const note = (name, when) => `---\nname: ${name}\nwhen: ${when}\nupdated: 2026-10-19\n---\n\n1. steps\n`;
const answered = (path, body) => `etag: "e-${path}"\npath: ${path}\nvisibility: private\n\n${body}`;

function world(notes, { together = (paths) => ({ content: paths.map((path) => ({ type: "text", text: answered(path, notes[path]) })) }) } = {}) {
  const calls = [];
  const dispatch = async (name, args) => {
    calls.push(name);
    if (name === "list_notes") return ok(Object.keys(notes).map((path) => `${path} (10 bytes)`).join("\n"));
    if (name === "read_notes") return together(args.paths);
    if (name === "read_note") return ok(answered(args.path, notes[args.path]));
    return ok("");
  };
  return { calls, dispatch };
}

test("the index is one listing and one read_notes", async () => {
  const notes = { "tex/skills/book-a-table.md": note("book-a-table", "a table for a group"), "tex/skills/plan-a-run.md": note("plan-a-run", "a running loop") };
  const { calls, dispatch } = world(notes);
  const index = await readLearnedSkills(dispatch);
  assert.deepEqual(calls, ["list_notes", "read_notes"]);
  assert.deepEqual(index, [
    { name: "book-a-table", when: "a table for a group", updated: "2026-10-19", used: null },
    { name: "plan-a-run", when: "a running loop", updated: "2026-10-19", used: null },
  ]);
});

test("a part for a path not asked for, an error or a moved note is read on its own", async () => {
  const notes = { "tex/skills/a-one.md": note("a-one", "first"), "tex/skills/b-two.md": note("b-two", "second"), "tex/skills/c-three.md": note("c-three", "third"), "tex/skills/d-four.md": note("d-four", "fourth") };
  const together = () => ({
    content: [
      { type: "text", text: answered("tex/skills/a-one.md", notes["tex/skills/a-one.md"]) },
      { type: "text", text: answered("tex/skills/elsewhere.md", note("b-two", "PLANTED")) },
      { type: "text", text: "path: tex/skills/c-three.md\nerror: not found" },
      { type: "text", text: `etag: "e"\npath: tex/skills/d-four.md\nvisibility: private\nmoved_from: tex/skills/old.md\n\n${note("d-four", "MOVED")}` },
    ],
  });
  const { calls, dispatch } = world(notes, { together });
  const index = await readLearnedSkills(dispatch);
  assert.deepEqual(calls.filter((name) => name === "read_note").length, 3);
  assert.deepEqual(index.map((entry) => [entry.name, entry.when]), [["a-one", "first"], ["b-two", "second"], ["c-three", "third"], ["d-four", "fourth"]]);
});

test("a read_notes that fails or is refused reads every skill as before", async () => {
  const notes = { "tex/skills/one.md": note("one", "first"), "tex/skills/two.md": note("two", "second") };
  for (const together of [() => ({ content: [{ type: "text", text: "read_notes opens at most 100 notes" }], isError: true }), () => { throw new Error("down"); }, () => null]) {
    const { calls, dispatch } = world(notes, { together });
    const index = await readLearnedSkills(dispatch);
    assert.deepEqual(calls, ["list_notes", "read_notes", "read_note", "read_note"]);
    assert.deepEqual(index.map((entry) => entry.name), ["one", "two"]);
  }
});

test("one skill is read with read_note, and none with nothing", async () => {
  const { calls, dispatch } = world({ "tex/skills/only.md": note("only", "the one") });
  assert.deepEqual((await readLearnedSkills(dispatch)).map((entry) => entry.name), ["only"]);
  assert.deepEqual(calls, ["list_notes", "read_note"]);
  const empty = world({});
  assert.deepEqual(await readLearnedSkills(empty.dispatch), []);
  assert.deepEqual(empty.calls, ["list_notes"]);
});

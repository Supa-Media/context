/**
 * A NOTE THEY ALREADY HAVE STAYS WHERE IT IS, AND AS IT IS (owner,
 * 2026-10-30: "why was my note completely overwritten, archived and replaced
 * with this ugly page?"). Their chapter note Joshua 1 was archived and a
 * `Joshua 1.page.md` put in its place by a texted turn (`agent/theirNotes.js`).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `withTheirNotesKept` returning `callTool` always → "their note is not
 *     archived or moved unless they ask" and "a page is not made beside
 *     their own plain note" fail.
 *   `withActivityHint` back to `enumerable: false` → "the write's hint
 *     survives a texting wrapper's spread" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ASKS_TO_MOVE, notesTaken, withTheirNotesKept } from "../src/agent/theirNotes.js";
import { activityHintOf, withActivityHint } from "../src/live/activityHint.js";
import { textingAwareCallTool } from "../src/agent/textingWrites.js";

const LISTING = ["areas/bible/joshua/Joshua 1.md (2400 bytes)", "areas/bible/joshua/Joshua 2.md (2100 bytes)"].join("\n");

/** A dispatcher that records calls, lists LISTING, and says whether each write created its note. */
function dispatcher(existing = new Set(["areas/bible/joshua/Joshua 1.md", "areas/bible/joshua/Joshua 2.md"])) {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === "list_notes") return { content: [{ type: "text", text: LISTING }] };
    if (name === "write_note") {
      const created = !existing.has(args.path);
      existing.add(args.path);
      return withActivityHint({ content: [{ type: "text", text: `written: ${args.path}` }] }, { created });
    }
    return { content: [{ type: "text", text: "done" }] };
  };
  return { calls, callTool };
}

const ran = (calls, name) => calls.filter((call) => call.name === name).length;

test("their note is not archived or moved unless they ask", async () => {
  const { calls, callTool } = dispatcher();
  const call = withTheirNotesKept(callTool, { question: "add an overview to joshua 1" });
  const archived = await call("archive_note", { path: "areas/bible/joshua/Joshua 1.md" });
  assert.equal(archived.isError, true);
  assert.match(archived.content[0].text, /is their note, and they did not ask for it to be moved or archived/);
  const moved = await call("move_note", { source: "areas/bible/joshua/Joshua 1.md", destination: "archive/Joshua 1.md" });
  assert.equal(moved.isError, true);
  const many = await call("manage", { action: "move_many", args: { moves: [{ source: "areas/bible/joshua/Joshua 2.md", destination: "x/Joshua 2.md" }] } });
  assert.equal(many.isError, true);
  assert.equal(ran(calls, "archive_note") + ran(calls, "move_note") + ran(calls, "manage"), 0);

  // Asked in their own words, it runs.
  for (const asked of ["archive joshua 1", "move it into the Old Testament folder", "can you tidy up my bible folder", "rename joshua 1"]) {
    const { calls: seen, callTool: dispatch } = dispatcher();
    const result = await withTheirNotesKept(dispatch, { question: asked })("archive_note", { path: "areas/bible/joshua/Joshua 1.md" });
    assert.notEqual(result.isError, true, asked);
    assert.equal(ran(seen, "archive_note"), 1, asked);
  }
  // A routine's run is not wrapped.
  assert.equal(withTheirNotesKept(callTool, { question: "", on: false }), callTool);
});

test("a note made this turn is Tex's own to archive (the page floor's plain copy)", async () => {
  const { calls, callTool } = dispatcher();
  const call = withTheirNotesKept(callTool, { question: "make me a plan for the retreat" });
  await call("write_note", { path: "projects/retreat/plan.md", content: "# Plan" });
  await call("write_note", { path: "projects/retreat/plan.page.md", content: "# Plan" });
  const archived = await call("archive_note", { path: "/projects/retreat/plan.md" });
  assert.notEqual(archived.isError, true);
  assert.equal(ran(calls, "archive_note"), 1);
  // Overwriting their note does not make it Tex's own.
  const over = withTheirNotesKept(dispatcher().callTool, { question: "add an overview to joshua 1" });
  await over("write_note", { path: "areas/bible/joshua/Joshua 1.md", content: "# Joshua 1" });
  assert.equal((await over("archive_note", { path: "areas/bible/joshua/Joshua 1.md" })).isError, true);
});

test("a page is not made beside their own plain note unless they ask for a page", async () => {
  const { calls, callTool } = dispatcher();
  const call = withTheirNotesKept(callTool, { question: "add an overview to joshua 1" });
  const result = await call("write_note", { path: "areas/bible/joshua/Joshua 1.page.md", content: "---\nskill: x\n---\n# Joshua 1" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Joshua 1\.md is already their note/);
  assert.equal(ran(calls, "write_note"), 0);
  // Asked for a page, it saves.
  const { calls: seen, callTool: dispatch } = dispatcher();
  const asked = await withTheirNotesKept(dispatch, { question: "turn joshua 1 into a page" })("write_note", { path: "areas/bible/joshua/Joshua 1.page.md", content: "# J" });
  assert.notEqual(asked.isError, true);
  assert.equal(ran(seen, "write_note"), 1);
  // A page with no plain twin saves.
  const fresh = await call("write_note", { path: "areas/bible/joshua/Joshua 3.page.md", content: "# J3" });
  assert.notEqual(fresh.isError, true);
});

test("which notes a call takes, by tool", () => {
  assert.deepEqual(notesTaken("archive_note", { path: "a.md" }), ["a.md"]);
  assert.deepEqual(notesTaken("manage", { action: "archive", args: { path: "a.md" } }), ["a.md"]);
  assert.deepEqual(notesTaken("move_notes", { folder: "inbox", match: "x", into: "y" }), ["inbox"]);
  assert.deepEqual(notesTaken("move_folder", { source: "a", destination: "b" }), ["a"]);
  assert.deepEqual(notesTaken("write_note", { path: "a.md" }), []);
  assert.equal(ASKS_TO_MOVE.test("add an overview to joshua 1"), false);
  assert.equal(ASKS_TO_MOVE.test("write up deuteronomy 34 like the others"), false);
});

test("the write's hint survives a texting wrapper's spread", async () => {
  const inner = async () => withActivityHint({ content: [{ type: "text", text: "written" }] }, { created: false });
  const tools = [{ name: "write_note", inputSchema: { properties: { path: {}, content: {}, expected_etag: {} } } }];
  const result = await textingAwareCallTool(inner, tools)("write_note", { path: "areas/a.md", content: "x" });
  assert.equal(activityHintOf(result)?.created, false);
  assert.equal(JSON.stringify(result).includes("created"), false, "never in the tool's text");
});

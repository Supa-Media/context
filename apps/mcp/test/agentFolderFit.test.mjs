/**
 * A NEW NOTE GOES WHERE THE PERSON'S FOLDERS SAY (Tex's self-review, 2026-10-24).
 *
 * The meeting notes asked for "in thoughts and reflections" were saved beside
 * the person's "2026 - Fall" subfolder instead of in it. A texted create
 * straight into a folder with subfolders is asked once to pick one.
 *
 * ## Sabotage record
 *
 *   `withFolderFit` passing every write through
 *     → "a new note beside the person's subfolders is asked to pick one" fails
 *   `asked` never remembering the path
 *     → "the same path again saves it where it was asked for" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { folderShape, withFolderFit } from "../src/agent/folderFit.js";

const LISTING = [
  "Areas/Thoughts and Reflection/2026 - Fall/journal-10-01.md (120 bytes)",
  "Areas/Thoughts and Reflection/2026 - Fall/journal-10-12.md (99 bytes)",
  "Areas/Thoughts and Reflection/2026 - Summer/journal-07-04.md (80 bytes)",
  "Areas/Thoughts and Reflection/attachments/photo.md (10 bytes)",
  "Areas/Thoughts and Reflection/loose.md (40 bytes)",
].join("\n");

function fakeDispatch(listing = LISTING) {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === "list_notes") return { content: [{ type: "text", text: listing }] };
    return { content: [{ type: "text", text: `written: ${args.path} (etag e1)` }] };
  };
  return { calls, callTool };
}

const writes = (calls) => calls.filter((call) => call.name === "write_note");

test("the subfolders are read from a listing, Context's own pieces left out", () => {
  const shape = folderShape(LISTING, "Areas/Thoughts and Reflection", "Areas/Thoughts and Reflection/new.md");
  assert.deepEqual(shape, { exists: false, subfolders: [{ name: "2026 - Fall", notes: 2 }, { name: "2026 - Summer", notes: 1 }] });
  assert.equal(folderShape(LISTING, "Areas/Thoughts and Reflection", "Areas/Thoughts and Reflection/loose.md").exists, true);
});

test("a new note beside the person's subfolders is asked to pick one", async () => {
  const { calls, callTool } = fakeDispatch();
  const call = withFolderFit(callTool);
  const answer = await call("write_note", { path: "Areas/Thoughts and Reflection/2026-10-23-laurel-high-notes.md", content: "x" });
  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /2026 - Fall \(2 notes\), 2026 - Summer \(1 note\)/);
  assert.doesNotMatch(answer.content[0].text, /attachments/);
  assert.equal(writes(calls).length, 0, "nothing saved yet");
  const placed = await call("write_note", { path: "Areas/Thoughts and Reflection/2026 - Fall/2026-10-23-laurel-high-notes.md", content: "x" });
  assert.notEqual(placed.isError, true);
  assert.equal(writes(calls).at(-1).args.path, "Areas/Thoughts and Reflection/2026 - Fall/2026-10-23-laurel-high-notes.md");
});

test("the same path again saves it where it was asked for", async () => {
  const { calls, callTool } = fakeDispatch();
  const call = withFolderFit(callTool);
  const path = "Areas/Thoughts and Reflection/odd-one.md";
  await call("write_note", { path, content: "x" });
  const again = await call("write_note", { path, content: "x" });
  assert.notEqual(again.isError, true);
  assert.deepEqual(writes(calls).map((entry) => entry.args.path), [path]);
});

test("an edit, a top-level note, Tex's own folder, a routine and a folder with no subfolders are never asked about", async () => {
  const { calls, callTool } = fakeDispatch();
  const call = withFolderFit(callTool);
  await call("write_note", { path: "Areas/Thoughts and Reflection/loose.md", content: "x", expected_etag: "e0" });
  await call("write_note", { path: "top.md", content: "x" });
  await call("write_note", { path: "tex/about-me.md", content: "x" });
  await call("write_note", { path: "tex/routines/daily/call-kyle.md", content: "x" });
  await call("write_note", { path: "Areas/Thoughts and Reflection/loose.md", content: "x" }); // exists already
  assert.equal(writes(calls).length, 5);
  const flat = fakeDispatch("Resources/a.md (1 bytes)\nResources/b.md (1 bytes)");
  const answer = await withFolderFit(flat.callTool)("write_note", { path: "Resources/Foods to try.md", content: "x" });
  assert.notEqual(answer.isError, true);
});

test("the listing is asked in the workspace the write names, and a failed listing asks nothing", async () => {
  const { calls, callTool } = fakeDispatch();
  await withFolderFit(callTool)("write_note", { path: "Areas/Thoughts and Reflection/n.md", content: "x", context: "@band" });
  assert.deepEqual(calls[0], { name: "list_notes", args: { prefix: "Areas/Thoughts and Reflection/", context: "@band" } });
  const failing = async (name, args) => (name === "list_notes" ? { isError: true, content: [{ type: "text", text: "no" }] } : { content: [{ type: "text", text: `written: ${args.path} (etag e1)` }] });
  const saved = await withFolderFit(failing)("write_note", { path: "Areas/Thoughts and Reflection/n.md", content: "x" });
  assert.notEqual(saved.isError, true);
});

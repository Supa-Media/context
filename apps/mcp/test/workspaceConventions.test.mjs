/**
 * A workspace's own rules come with the first call into it (`agent/workspaceConventions.js`; Dev2, 2026-11-17,
 * Servant Hearted trace issue 9: Tex wrote a project in a shared workspace without reading its index.md).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-11-17).
 *
 *  1. Only the top folder read → "the folders on the way to the path are read too" fails.
 *  2. `seen` never filled → "each folder's rules come once a turn" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { foldersOnTheWay, ownWorkspaceName, withWorkspaceConventions } from "../src/agent/workspaceConventions.js";

const NOTES = {
  "index.md": "# Team\n\nProjects live in projects/, one overview.md and one task-*.md note per task.",
  "projects/README.md": "Each task is its own note with status, owner and due.",
  "projects/bake/about.md": "Bake sale, run by the band.",
};
function dispatcher(notes = NOTES) {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === "read_note") {
      const body = notes[args.path];
      return body === undefined ? { isError: true, content: [{ type: "text", text: "not found" }] } : { content: [{ type: "text", text: `etag: e\npath: ${args.path}\nvisibility: team\n\n${body}` }] };
    }
    return { content: [{ type: "text", text: `written: ${args.path} (etag x)\nvisibility: team` }] };
  };
  return { calls, callTool };
}

test("the first call into another workspace comes back with its index, about and README", async () => {
  const { callTool } = dispatcher();
  const call = withWorkspaceConventions(callTool, { own: "maya" });
  const result = await call("write_note", { path: "notes/x.md", content: "x", context: "@band" });
  const text = result.content[0].text;
  assert.match(text, /^written: notes\/x\.md/, "the call's own answer first");
  assert.match(text, /How @band is kept/);
  assert.match(text, /one task-\*\.md note per task/);
});

test("the folders on the way to the path are read too, and an @name/ path names the workspace", async () => {
  const { calls, callTool } = dispatcher();
  const call = withWorkspaceConventions(callTool, { own: "maya" });
  const text = (await call("read_note", { path: "@band/projects/bake/overview.md" })).content[0].text;
  assert.match(text, /@band\/projects\/README\.md ---\nEach task is its own note/);
  assert.match(text, /@band\/projects\/bake\/about\.md ---\nBake sale/);
  const read = calls.filter((c) => c.name === "read_note" && c.args.context === "@band").map((c) => c.args.path);
  for (const file of ["index.md", "about.md", "README.md", "projects/index.md", "projects/bake/README.md"]) assert.ok(read.includes(file), file);
});

test("each folder's rules come once a turn; a deeper path adds only its new folders", async () => {
  const { calls, callTool } = dispatcher();
  const call = withWorkspaceConventions(callTool, { own: "maya" });
  await call("list_notes", { prefix: "projects/", context: "@band" });
  const before = calls.length;
  const again = await call("search_notes", { query: "bake", context: "@band" });
  assert.equal(calls.length, before + 1, "nothing read again");
  assert.doesNotMatch(again.content[0].text, /How @band is kept/);
  const deeper = await call("write_note", { path: "projects/bake/task-flyers.md", content: "x", context: "@band" });
  assert.match(deeper.content[0].text, /projects\/bake\/about\.md/);
  assert.doesNotMatch(deeper.content[0].text, /@band\/index\.md/);
});

test("the turn's own workspace, and a workspace with none of these notes, add nothing", async () => {
  const { calls, callTool } = dispatcher();
  const call = withWorkspaceConventions(callTool, { own: "maya" });
  const own = await call("write_note", { path: "a.md", content: "x" });
  const ownNamed = await call("write_note", { path: "a.md", content: "x", context: "@Maya" });
  assert.equal(calls.filter((c) => c.name === "read_note").length, 0);
  assert.doesNotMatch(own.content[0].text + ownNamed.content[0].text, /is kept/);
  const bare = await withWorkspaceConventions(dispatcher({}).callTool, { own: "maya" })("write_note", { path: "a.md", context: "@band" });
  assert.equal(bare.content[0].text, "written: a.md (etag x)\nvisibility: team");
});

test("a long note is cut, and everything attached stays under the cap", async () => {
  const { callTool } = dispatcher({ "index.md": "x".repeat(10_000), "about.md": "y".repeat(10_000), "README.md": "z".repeat(10_000) });
  const text = (await withWorkspaceConventions(callTool, { own: "maya" })("search_notes", { query: "q", context: "@band" })).content[0].text;
  assert.ok(text.length < 9_000, String(text.length));
  assert.match(text, /cut; read the note for the rest/);
});

test("folders on the way, and the own workspace's name", () => {
  assert.deepEqual(foldersOnTheWay({ path: "a/b/c/d/e.md" }), ["", "a/", "a/b/", "a/b/c/"]);
  assert.deepEqual(foldersOnTheWay({ prefix: "projects" }), ["", "projects/"]);
  assert.deepEqual(foldersOnTheWay({ query: "x" }), [""]);
  assert.equal(ownWorkspaceName([{ name: "@maya", current: true }, { name: "band" }]), "maya");
});

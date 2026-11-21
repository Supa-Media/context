/**
 * tex_dev `search` (Dev2, 2026-11-21: the Lab's search try-out, with tex_dev parity): the guide and the tool's
 * description name it, its answer reads as ranked keys for main and the draft with what differs, and bad args are
 * refused before anything is asked of the Lab.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-21):
 *   searchText leaving out the draft's side                         "the answer ranks main and the draft" fails
 *   the `search` case dropping its query check                     "a search with no query is refused" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { searchText } from "../../../packages/lab/gateway/texDev/search.js";
import { guideText } from "../../../packages/lab/gateway/texDev/guide.js";
import { createTexDev } from "../../../packages/lab/gateway/texDev/tool.js";

const side = (keys) => ({ hits: keys.map((key) => ({ key, title: key.toUpperCase() })), searched: ["@me"], steps: [{ node: "search", ms: 1, ok: true }, { node: "each", ms: 5, ok: true }] });

test("the answer ranks main and the draft, says it is a try-out and names what differs", () => {
  const text = searchText({ query: "renewal", main: side(["a.md", "b.md"]), draft: side(["b.md", "a.md"]), changed: ["fuse.hits"] }, "v1abc");
  assert.match(text, /a try-out, not a real search/);
  assert.match(text, /main:\n1\. a\.md — A\.MD\n2\. b\.md/);
  assert.match(text, /draft v1abc:\n1\. b\.md — B\.MD\n2\. a\.md/);
  assert.match(text, /steps: search 1 ms → each 5 ms/);
  assert.match(text, /Settings that differ from main: fuse\.hits\./);
  assert.match(searchText({ query: "x", main: side([]), draft: null, changed: [] }, "v1abc"), /has no search steps, so it searched as main does/);
});

test("the guide names search and every other architecture's own config", () => {
  const text = typeof guideText === "function" ? guideText() : String(guideText);
  assert.match(text, /`search` \{ draft\?, query, only\? \}/);
  assert.match(text, /Search \(graph "search", apps\/mcp\/src\/search\/config\/searchConfig\.json\)/);
  assert.match(text, /### Search graph \(16 steps/);
});

test("a search with no query, or a draft that is not a draft id, is refused before the Lab is asked", async () => {
  let asked = 0;
  const controlPlane = new Proxy({}, { get: () => async () => { asked += 1; return { status: "ok" }; } });
  const tool = createTexDev({ env: {}, session: { workspaceSlug: "context-lc", scope: "private", role: "editor" }, controlPlane });
  const noQuery = await tool("search", {});
  assert.ok(noQuery.isError, JSON.stringify(noQuery));
  assert.match(noQuery.content[0].text, /query is the words to search for/);
  const badDraft = await tool("search", { draft: "not a draft", query: "x" });
  assert.match(badDraft.content[0].text, /Name the draft/);
  assert.equal(asked, 0);
});

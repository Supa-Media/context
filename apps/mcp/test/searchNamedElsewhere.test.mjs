/**
 * A search asked of one workspace names its title matches elsewhere
 * (`src/tools/searchNamed.js`).
 *
 * Incident, production, invented words: a person asked "what's on the coach
 * reading list?". The assistant read "coach" as the name of a workspace and
 * called search_notes with `context: "@kiln-guild"` every time. The note was
 * `resources/books/coach-reading-list.md` in the person's own workspace, which
 * a plain search for "reading list" ranks first. A search addressed with
 * `context` opens only that workspace, so it could never see the note, and the
 * assistant said the list did not exist. The fix names the title matches in the
 * other workspaces the person reaches when the scoped answer holds no title match.
 *
 * Sabotage record (temporary local edits, reverted; each run fails the tests named):
 *   the append dropped (withElsewhere returns scoped)   → 3 fail: the appends test, the integration test, the at-most-three test
 *   the hook removed from callToolForSession            → the integration "still finds the list" test fails
 *   the everywhere setting not checked                  → the "not reached when everywhere is off" unit test fails
 *   the 0.5 title floor lowered to 0.25                 → the "keeps a hyphenated file name" / "skips meaning-only" test fails
 *   the meaning-only skip removed                       → the "skips meaning-only blocks" test fails
 *   the current-workspace check removed                 → the "null for the current workspace" test fails
 *   the skip prefix ignored                             → the "skips meaning-only blocks and honours the skip prefix" test fails (2)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { namedOtherWorkspace, titledKeys, withElsewhere } from "../src/tools/searchNamed.js";
import { toolText, toolError } from "../src/tools/results.js";
import { MEANING_ONLY_LABEL } from "../src/search/meaning/serve.js";
import { callToolForSession } from "../src/tools/session.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { withServedTree } from "./servedTree.mjs";

const KILN = "@kiln-guild";
const call = (args = {}) => ({ name: "search_notes", arguments: { query: "kiln guild reading list", context: KILN, ...args } });
const store = (extra = {}) => ({ openContext: async () => null, contexts: [{ name: "@maya-home", current: true }, { name: KILN }], searchSettings: { everywhere: true }, ...extra });

test("namedOtherWorkspace names another workspace the person reaches", () => {
  assert.equal(namedOtherWorkspace(call(), store()), KILN);
  // Case does not matter.
  assert.equal(namedOtherWorkspace(call({ context: "@Kiln-Guild" }), store()), "@Kiln-Guild");
});

test("namedOtherWorkspace is null for the current workspace, no context, a prefix, an empty query, or a store that cannot reach others", () => {
  assert.equal(namedOtherWorkspace(call({ context: "@maya-home" }), store()), null, "the current workspace");
  assert.equal(namedOtherWorkspace(call({ context: "@MAYA-HOME" }), store()), null, "the current workspace, any case");
  assert.equal(namedOtherWorkspace({ name: "search_notes", arguments: { query: "x" } }, store()), null, "no context");
  assert.equal(namedOtherWorkspace(call({ prefix: "resources" }), store()), null, "a prefix narrows the search itself");
  assert.equal(namedOtherWorkspace(call({ query: "" }), store()), null, "an empty query");
  assert.equal(namedOtherWorkspace(call({ query: 7 }), store()), null, "a query that is not text");
  assert.equal(namedOtherWorkspace(call(), store({ searchSettings: { everywhere: false } })), null, "everywhere is off");
  assert.equal(namedOtherWorkspace(call(), store({ openContext: undefined })), null, "no openContext");
  assert.equal(namedOtherWorkspace({ name: "read_notes", arguments: { context: KILN, query: "x" } }, store()), null, "not a search");
});

const block = (key, snippet = "    a line") => `${key}\n${snippet}`;
const result = (...blocks) => toolText(`${blocks.length} matching note${blocks.length === 1 ? "" : "s"}\n\n${blocks.join("\n\n")}`);

test("titledKeys keeps a hyphenated file name that holds half the query's terms", () => {
  const text = result(block("resources/books/coach-reading-list.md"), block("notes/unrelated.md")).content[0].text;
  const keys = titledKeys(text, "kiln guild reading list", { skip: null }).map((entry) => entry.key);
  assert.deepEqual(keys, ["resources/books/coach-reading-list.md"]);
});

test("titledKeys skips meaning-only blocks and honours the skip prefix", () => {
  const meaning = `resources/books/coach-reading-list.md\n    (${MEANING_ONLY_LABEL})\n    a passage`;
  const text = result(meaning, block("@kiln-guild/reading/kiln-guild-reading-list.md"), block("@other/reading-list.md")).content[0].text;
  assert.deepEqual(titledKeys(text, "kiln guild reading list", { skip: null }).map((entry) => entry.key), [
    "@kiln-guild/reading/kiln-guild-reading-list.md",
    "@other/reading-list.md",
  ]);
  // The named workspace's own hits are not repeated.
  assert.deepEqual(titledKeys(text, "kiln guild reading list", { skip: "@kiln-guild" }).map((entry) => entry.key), ["@other/reading-list.md"]);
  // A title that holds one term of four is not named.
  assert.deepEqual(titledKeys(result(block("notes/guild.md")).content[0].text, "kiln guild reading list", { skip: null }), []);
});

test("titledKeys returns the block text with each key, and [] for no matches", () => {
  const text = result(block("a/coach-reading-list.md", "    indented passage")).content[0].text;
  assert.deepEqual(titledKeys(text, "coach reading list", { skip: null }), [{ key: "a/coach-reading-list.md", block: "a/coach-reading-list.md\n    indented passage" }]);
  assert.deepEqual(titledKeys("(no matches)\n\nA miss usually means the wrong word.", "coach reading list", { skip: null }), []);
});

test("withElsewhere appends the titled hits from the other workspaces, under the stated wording", () => {
  const scoped = toolText("1 matching note\n\nnotes/body-mention.md\n    the kiln guild lent the reading list once");
  const wide = result(block("@other/reading/coach-reading-list.md"), block("resources/books/coach-reading-list.md"));
  const out = withElsewhere(scoped, wide, "kiln guild reading list", KILN);
  const text = out.content[0].text;
  assert.ok(text.startsWith(scoped.content[0].text), "the scoped answer is kept first");
  assert.ok(
    text.includes(
      `\n\nThis search was asked of ${KILN} only. A workspace named in a question is often its topic, not where the note lives: in the other workspaces they reach, these are named for it (a path without @name/ is in their own workspace: read it with no context):\n\n`,
    ),
    text,
  );
  assert.ok(text.includes("@other/reading/coach-reading-list.md\n    a line"));
  assert.ok(text.includes("resources/books/coach-reading-list.md\n    a line"));
  assert.equal(out.isError, undefined);
});

test("withElsewhere appends at most three hits", () => {
  const wide = result(...["a", "b", "c", "d"].map((letter) => block(`@w${letter}/coach-reading-list.md`)));
  const text = withElsewhere(toolText("(no matches)"), wide, "coach reading list", KILN).content[0].text;
  assert.equal(text.split("\n").filter((line) => line.endsWith("coach-reading-list.md")).length, 3);
});

test("withElsewhere leaves the scoped result unchanged when it already holds a titled hit, is an error, or the wide search has none", () => {
  const wide = result(block("@other/coach-reading-list.md"));
  const titled = toolText("1 matching note\n\nin-kiln/coach-reading-list.md\n    a line");
  assert.equal(withElsewhere(titled, wide, "coach reading list", KILN), titled);
  const failed = toolError("this connection has no access to that context");
  assert.equal(withElsewhere(failed, wide, "coach reading list", KILN), failed);
  const scoped = toolText("(no matches)");
  assert.equal(withElsewhere(scoped, toolText("(no matches)"), "coach reading list", KILN), scoped);
  assert.equal(withElsewhere(scoped, result(block("@kiln-guild/coach-reading-list.md")), "coach reading list", KILN), scoped, "only the named workspace has it");
});

/** A workspace's notes as a store the search reads (as `searchEverywhere.test.mjs` builds them). */
function workspaceStore(notes, extra = {}) {
  const files = new Map(Object.entries(notes));
  const store = {
    async list({ prefix } = {}) {
      const objects = [...files.keys()]
        .filter((key) => !prefix || key.startsWith(prefix))
        .sort()
        .map((key) => ({ key, size: files.get(key).length, uploaded: new Date(0), etag: `e-${key}` }));
      return { objects, truncated: false };
    },
    async get(key) {
      if (!files.has(key)) return null;
      const body = files.get(key);
      return { etag: `e-${key}`, text: async () => body, size: body.length };
    },
    async head(key) {
      return files.has(key) ? { etag: `e-${key}`, size: files.get(key).length } : null;
    },
    ...extra,
  };
  return withPrivacyAuthority(withServedTree(store), { rules: { etag: "rows-v1", accessVersion: 1, folders: [], notes: [] } });
}

/**
 * The person's own workspace holds the list; the workspace the question names
 * holds only a note that does not match. The call goes through
 * `callToolForSession`, the way a tool call does, so the hook is what is tested.
 */
function incidentHome(kilnNotes = { "reading/kiln-notes.md": "# Kiln notes\n\nThe kiln guild meets on Thursdays.\n" }) {
  const kiln = workspaceStore(kilnNotes);
  return workspaceStore(
    { "resources/books/coach-reading-list.md": "# Coach reading list\n\nBooks for the coach.\n" },
    {
      contexts: [{ name: "@maya-home", current: true }, { name: KILN }],
      async openContext(name) {
        if (name !== KILN) throw new Error("not a workspace this person reaches");
        return { session: { scope: "private", workspaceId: "ws-kiln" }, store: kiln };
      },
    },
  );
}
const SESSION = { scope: "private", workspaceId: "ws-maya-home" };
const ask = (store, args) => callToolForSession({ name: "search_notes", arguments: args }, store, SESSION);

test("a question that names a workspace still finds the list in the person's own workspace", async () => {
  const out = await ask(incidentHome(), { query: "coach reading list", context: KILN });
  const text = out.content[0].text;
  assert.ok(text.includes(`This search was asked of ${KILN} only.`), text);
  assert.ok(text.includes("resources/books/coach-reading-list.md\n    # Coach reading list"), text);
  assert.notEqual(out.isError, true);
});

test("a scoped answer that already names a titled note is returned as it was, with no wide search", async () => {
  const kiln = { "reading/coach-reading-list.md": "# Coach reading list\n\nKiln copy.\n" };
  const out = await ask(incidentHome(kiln), { query: "coach reading list", context: KILN });
  const text = out.content[0].text;
  assert.ok(!text.includes("This search was asked of"), text);
  assert.ok(text.includes("reading/coach-reading-list.md"), text);
});

test("a search with no context is not widened: it is the wide search itself", async () => {
  const out = await ask(incidentHome(), { query: "coach reading list" });
  assert.ok(!out.content[0].text.includes("This search was asked of"), out.content[0].text);
  assert.ok(out.content[0].text.startsWith("1 matching note"), out.content[0].text);
});

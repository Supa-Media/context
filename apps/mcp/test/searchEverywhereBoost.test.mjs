/**
 * `search_notes` with `boost: "@name"` (`tools/search.js`, decided by the owner, 2026-11-19): every workspace the
 * person reaches is searched and fused by evidence, a boost only raises the named workspace's hits
 * (`fuseEverywhere`'s `boost`, `BOOST_FACTOR`), and the answer says which workspaces actually answered
 * (`Searched: ...`, last paragraph). A workspace the person is not a member of is never searched.
 *
 * Sabotage record (temporary local edits, reverted; each run fails the tests named):
 *   BOOST_FACTOR set to 1                                  → 2 fail: "BOOST_FACTOR is a modest multiplier…", "a boost lifts a hit just below the top…"
 *   `searched` built from `names` instead of who answered  → 1 fails: "a workspace whose open throws is not in Searched…"
 *   the Searched paragraph dropped                         → 3 fail: "a boosted search…", "a workspace whose open throws…", "a workspace the person is not a member of…"
 */

import test from "node:test";
import assert from "node:assert/strict";
import { BOOST_FACTOR, fuseEverywhere } from "../src/tools/search.js";
import { callToolForSession } from "../src/tools/session.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { withServedTree } from "./servedTree.mjs";

const hit = (key, { wordRank = null, loose = false, meaningScore = null } = {}) => ({ key, title: key, snippets: [], wordRank, loose, meaningScore });
const keysOf = (fused) => fused.map((entry) => entry.key);

test("BOOST_FACTOR is a modest multiplier, above one", () => {
  assert.ok(BOOST_FACTOR > 1 && BOOST_FACTOR < 2, String(BOOST_FACTOR));
});

test("a boost lifts a hit just below the top of another list above it, and a big gap is not closed", () => {
  // Word ranks 0 and 1 are 1/61 and 1/62 apart by under two per cent: a 1.2 boost closes it.
  const near = () => [[hit("own.md", { wordRank: 0 })], [hit("@kiln/a.md", { wordRank: 1 })]];
  assert.deepEqual(keysOf(fuseEverywhere(near())), ["own.md", "@kiln/a.md"]);
  assert.deepEqual(keysOf(fuseEverywhere(near(), 12, { boost: new Set([1]) })), ["@kiln/a.md", "own.md"]);
  // Rank 20 is far below rank 0: the same boost does not carry it past.
  const far = () => [[hit("own.md", { wordRank: 0 })], [hit("@kiln/far.md", { wordRank: 20 })]];
  assert.deepEqual(keysOf(fuseEverywhere(far(), 12, { boost: new Set([1]) })), ["own.md", "@kiln/far.md"]);
});

test("a boost never removes or adds a hit, and an empty or absent boost changes nothing", () => {
  const lists = () => [
    [hit("own-1.md", { wordRank: 0 }), hit("own-2.md", { wordRank: 3, meaningScore: 0.6 })],
    [hit("@kiln/a.md", { wordRank: 1 }), hit("@kiln/b.md", { meaningScore: 0.7 }), hit("@kiln/c.md", { wordRank: 2, loose: true })],
    [hit("@x/d.md", { wordRank: 0, meaningScore: 0.5 })],
  ];
  const plain = fuseEverywhere(lists());
  const boosted = fuseEverywhere(lists(), 12, { boost: new Set([1]) });
  assert.deepEqual(keysOf(boosted).slice().sort(), keysOf(plain).slice().sort());
  assert.deepEqual(keysOf(fuseEverywhere(lists(), 12, { boost: new Set() })), keysOf(plain));
  assert.deepEqual(keysOf(fuseEverywhere(lists(), 12, { boost: null })), keysOf(plain));
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

const KILN = "@kiln-guild";
const SESSION = { scope: "private", workspaceId: "ws-maya-home" };
const OWN_NOTES = { "resources/books/mentor-reading-list.md": "# Mentor reading list\n\nBooks for the mentor.\n" };
const KILN_NOTES = { "reading/kiln-guild-reading.md": "# Kiln guild reading\n\nThe reading list for the kiln guild meets on Thursdays.\n" };
// Every search goes through `callToolForSession`, the argument check included, as Tex's and a client's calls do.
const ask = (store, args) => callToolForSession({ name: "search_notes", arguments: args }, store, SESSION);
const askAsClient = ask;

/**
 * The person's own workspace (current) with the given other workspaces reachable. `openContext` opens a
 * workspace by name from `others`; a name in `broken` throws as an unavailable workspace does.
 */
function home({ others = { [KILN]: KILN_NOTES }, contexts = [KILN], broken = [], opened = [] } = {}) {
  return workspaceStore(OWN_NOTES, {
    contexts: [{ name: "@maya-home", current: true }, ...contexts.map((name) => ({ name }))],
    async openContext(name) {
      opened.push(name);
      if (broken.includes(name)) throw new Error("this workspace cannot be opened right now");
      if (!(name in others)) throw new Error("not a workspace this person reaches");
      return { session: { scope: "private", workspaceId: `ws-${name}` }, store: workspaceStore(others[name]) };
    },
  });
}

test("a boosted search still reaches the person's own note and the named workspace's trap note, and says where it searched", async () => {
  const out = await ask(home(), { query: "reading list", boost: "@kiln-guild" });
  const text = out.content[0].text;
  assert.ok(text.includes("resources/books/mentor-reading-list.md\n"), text);
  assert.ok(text.includes("@kiln-guild/reading/kiln-guild-reading.md\n"), text);
  assert.ok(text.endsWith("\n\nSearched: @maya-home, @kiln-guild."), text);
  assert.deepEqual(out.searched, ["@maya-home", "@kiln-guild"]);
  assert.equal(out.unreached, undefined);
});

test("a workspace whose open throws is not in Searched, is named as not reachable, and the rest still answer", async () => {
  const out = await ask(home({ contexts: [KILN, "@broken"], broken: ["@broken"] }), { query: "reading list", boost: "@kiln-guild" });
  const text = out.content[0].text;
  assert.ok(text.endsWith("\n\nSearched: @maya-home, @kiln-guild. Not reachable just now, so not searched: @broken."), text);
  assert.deepEqual(out.searched, ["@maya-home", "@kiln-guild"]);
  assert.deepEqual(out.unreached, ["@broken"]);
  assert.ok(text.includes("resources/books/mentor-reading-list.md\n"), "the own note still answers");
});

test("a workspace the person is not a member of is never searched, boosted or listed", async () => {
  const opened = [];
  const stranger = { "@stranger": { "reading/secret-reading-list.md": "# Secret reading list\n\nNot yours.\n" } };
  const store = home({ others: { ...stranger, [KILN]: KILN_NOTES }, opened });
  const out = await ask(store, { query: "reading list", boost: "@stranger" });
  const text = out.content[0].text;
  assert.ok(!text.includes("stranger"), text);
  assert.ok(!opened.includes("@stranger"), `opened: ${opened.join(", ")}`);
  assert.ok(text.endsWith("\n\nSearched: @maya-home, @kiln-guild."), text);
});

test("a one-workspace search with no boost is byte-identical to before: no Searched line", async () => {
  const store = workspaceStore(OWN_NOTES, { contexts: [{ name: "@maya-home", current: true }] });
  const out = await askAsClient(store, { query: "reading list" });
  const text = out.content[0].text;
  assert.ok(text.startsWith("1 matching note"), text);
  assert.ok(!text.includes("Searched:"), text);
  assert.ok(!text.includes("Not reachable"), text);
  assert.deepEqual(out.searched, ["@maya-home"]);
});

test("a search scoped with context searches that one workspace only, as before", async () => {
  const out = await askAsClient(home(), { query: "reading list", context: KILN });
  const text = out.content[0].text;
  assert.ok(text.includes("reading/kiln-guild-reading.md\n"), text);
  assert.ok(!text.includes("mentor-reading-list.md"), text);
  assert.ok(!text.includes("Searched:"), text);
});

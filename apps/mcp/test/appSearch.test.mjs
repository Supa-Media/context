/**
 * The app's search bar is answered by the search an AI client runs (`http/appSearch.js`, `tools/search.js`
 * `findNotes`; the search revamp, 2026-11-04).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the console-client check removed                          → "only the app's own client" fails
 *   `only` ignored (every reachable workspace searched)       → "the scope picker narrows" fails
 *   this workspace searched though `only` leaves it out        → "the scope picker narrows" fails
 *   a hit's `@name/` left on its path                          → "each hit names its workspace" fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import { handleAppSearch } from "../src/http/appSearch.js";
import { findNotes } from "../src/tools/search.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { withServedTree } from "./servedTree.mjs";

/** A workspace's notes as a store the search reads (`searchEverywhere.test.mjs`). */
function scannedStore(notes, extra = {}) {
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
  return withServedTree(store);
}

const rowsOf = (store) => withPrivacyAuthority(store, { rules: { etag: "rows-v1", accessVersion: 1, folders: [], notes: [] } });

function setup() {
  const others = {
    "@ops": scannedStore({ "areas/renewal.md": "# Workers comp renewal\n\nCarrier quote due in March.\n" }),
  };
  const home = rowsOf(scannedStore(
    { "inbox/todo.md": "# Todo\n\nCall the carrier about the renewal quote.\n" },
    {
      async openContext(name) {
        if (!others[name]) throw new Error("not reachable");
        return { session: { scope: "private" }, store: rowsOf(others[name]) };
      },
    },
  ));
  const session = {
    actorClientId: "context_console",
    workspaceId: "ws_home",
    workspaceSlug: "me",
    scope: "private",
    workspaces: [
      { slug: "me", workspaceId: "ws_home", role: "owner", kind: "personal" },
      { slug: "ops", workspaceId: "ws_ops", role: "member", kind: "shared" },
    ],
    scopes: ["read"],
    grantScopes: ["read"],
  };
  return { home, session };
}

const ask = (body) => new Request("https://gateway.test/app/search", { method: "POST", body: JSON.stringify(body) });

test("only the app's own client searches here", async () => {
  const { home, session } = setup();
  const response = await handleAppSearch(ask({ query: "renewal" }), home, { ...session, actorClientId: "some_ai" });
  assert.equal(response.status, 403);
});

test("each hit names its workspace, and its path is that workspace's own", async () => {
  const { home, session } = setup();
  const body = await (await handleAppSearch(ask({ query: "renewal" }), home, session)).json();
  const seen = body.hits.map((hit) => `${hit.workspace} ${hit.path}`).sort();
  assert.deepEqual(seen, ["@me inbox/todo.md", "@ops areas/renewal.md"]);
  assert.ok(body.matchCount >= 2);
});

test("the scope picker narrows: a workspace it leaves out is not searched, this one included", async () => {
  const { home, session } = setup();
  const onlyOps = await (await handleAppSearch(ask({ query: "renewal", workspaces: ["@ops"] }), home, session)).json();
  assert.deepEqual(onlyOps.hits.map((hit) => hit.workspace), ["@ops"]);
  const onlyMe = await (await handleAppSearch(ask({ query: "renewal", workspaces: ["@me"] }), home, session)).json();
  assert.deepEqual(onlyMe.hits.map((hit) => hit.workspace), ["@me"]);
  const nowhere = await findNotes(home, "private", [], new Map(), "renewal", "", { only: ["@stranger"] });
  assert.deepEqual(nowhere.hits, []);
});

test("a malformed ask is refused before anything is searched", async () => {
  const { home, session } = setup();
  for (const body of [{}, { query: "" }, { query: "x".repeat(501) }, { query: "a", workspaces: "@ops" }, { query: "a", workspaces: [1] }]) {
    assert.equal((await handleAppSearch(ask(body), home, session)).status, 400, JSON.stringify(body).slice(0, 40));
  }
});

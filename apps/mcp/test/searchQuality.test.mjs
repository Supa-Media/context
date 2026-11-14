/**
 * The gateway's side of search quality (`search/quality.js`, `controlPlane/changeReporters.js`): what a
 * search row and an open tell the control plane, and what must never cross.
 *
 * The hashes are computed here with Web Crypto directly, not with the gateway's own helpers, so a wrong seed
 * format or a wrong hit key in the gateway fails these checks rather than matching itself.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, with the failing checks as measured.
 *
 *   every searcher reported as "ai", Tex included                  → 1 fails: "a Tex turn's search is tex"
 *   another workspace's hit hashed with the asked-in workspace's id → 2 fail: "the fan-out…", "a note found in workspace B…"
 */

import test from "node:test";
import assert from "node:assert/strict";
import { handleAppSearch } from "../src/http/appSearch.js";
import { findNotes } from "../src/tools/search.js";
import { callTool } from "../src/tools/dispatch.js";
import { attachChangeReporters } from "../src/controlPlane/changeReporters.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { withServedTree } from "./servedTree.mjs";

const HEX16 = /^[0-9a-f]{16}$/;

async function sha16(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A workspace's notes as a scanned store, as `appSearch.test.mjs` builds them. */
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

/** A fake control plane that records every call, and can be told to fail. */
function fakeControlPlane({ failTiming = false, failOpen = false } = {}) {
  const calls = [];
  return {
    calls,
    reportSearchTiming: async (fields) => {
      calls.push({ path: "/gateway/search-timing", body: fields });
      if (failTiming) throw new Error("control plane down");
      return { ok: true };
    },
    reportSearchOpen: async (body) => {
      calls.push({ path: "/gateway/search-open", body });
      if (failOpen) throw new Error("control plane down");
      return { ok: true };
    },
  };
}

/** A store the way a request builds one: deferral kept until settled, reporters attached for its workspace. */
function wired(store, workspaceId, controlPlane, actor) {
  const pending = [];
  store.defer = (work) => pending.push(Promise.resolve(work));
  store.actor = { workspaceId, ...actor };
  attachChangeReporters(store, workspaceId, controlPlane, {});
  return { store, settle: async () => { while (pending.length) await Promise.allSettled(pending.splice(0)); } };
}

const NOTES = {
  "inbox/todo.md": "# Todo\n\nCall the carrier about the renewal quote.\n",
  "areas/diagnosis.md": "# Private diagnosis\n\nRenewal of the hunter2 password.\n",
};

/** No rules and no overrides: the private scope sees every note (as `appSearch.test.mjs` asks it). */
function rulesFor() {
  return { rules: [], overrides: new Map() };
}

async function homeStore(controlPlane, actor, extra = {}) {
  const home = rowsOf(scannedStore(NOTES, extra));
  return wired(home, "ws_home", controlPlane, actor);
}

const ASK = "renewal";

test("an AI client's search row carries who, actor and hashed hits, and nothing of the query or the paths", async () => {
  const cp = fakeControlPlane();
  const { store, settle } = await homeStore(cp, { grantId: "grant_ai", userId: "user_1", clientId: "mcp_client_ai" });
  const { rules, overrides } = rulesFor();
  const found = await findNotes(store, "private", rules, overrides, ASK, "");
  await settle();
  const rows = cp.calls.filter((c) => c.path === "/gateway/search-timing").map((c) => c.body);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.deepEqual(Object.keys(row).sort(), ["actor", "answeredBy", "found", "hits", "ms", "who", "workspaceId"]);
  assert.equal(row.who, "ai");
  assert.equal(row.actor, await sha16("search-actor:grant_ai"));
  assert.ok(row.hits.length >= 1 && row.hits.length <= 10);
  assert.ok(row.hits.every((hit) => HEX16.test(hit)));
  const expected = await Promise.all(found.hits.map((hit) => sha16(`search-hit:ws_home:${hit.key}`)));
  assert.deepEqual([...row.hits].sort(), [...expected].sort(), "the hits are the answer's, hashed by path");
  const serialized = JSON.stringify(cp.calls);
  for (const secret of [ASK, "inbox/todo.md", "areas/diagnosis.md", "Todo", "hunter2", "diagnosis"]) {
    assert.ok(!serialized.includes(secret), `"${secret}" crossed the wire`);
  }
});

test("a Tex turn's search is tex, with its own grant as the actor", async () => {
  for (const clientId of ["context_texts", "context_texts_group", "context_routines", "context_housekeeping", "context_dreams", "context_heartbeat"]) {
    const cp = fakeControlPlane();
    const { store, settle } = await homeStore(cp, { grantId: "grant_tex", userId: "user_1", clientId });
    const { rules, overrides } = rulesFor();
    await findNotes(store, "private", rules, overrides, ASK, "");
    await settle();
    const [row] = cp.calls.map((c) => c.body);
    assert.equal(row.who, "tex", clientId);
    assert.equal(row.actor, await sha16("search-actor:grant_tex"), clientId);
  }
});

test("the app's bar is its own surface, with no searcher and no hits", async () => {
  const cp = fakeControlPlane();
  const { store, settle } = await homeStore(cp, { grantId: "grant_console", userId: "user_1", clientId: "context_console" });
  store.searchSurface = "app";
  const { rules, overrides } = rulesFor();
  await findNotes(store, "private", rules, overrides, ASK, "");
  await settle();
  const [row] = cp.calls.map((c) => c.body);
  assert.deepEqual(Object.keys(row).sort(), ["answeredBy", "found", "ms", "surface", "workspaceId"]);
  assert.equal(row.surface, "app");
  assert.equal(row.who, undefined);
});

test("the app route marks its search as surface app through the gateway", async () => {
  const cp = fakeControlPlane();
  const { store, settle } = await homeStore(cp, { grantId: "grant_console", userId: "user_1", clientId: "context_console" });
  const session = {
    actorClientId: "context_console",
    workspaceId: "ws_home",
    workspaceSlug: "me",
    scope: "private",
    workspaces: [{ slug: "me", workspaceId: "ws_home", role: "owner", kind: "personal" }],
    scopes: ["read"],
    grantScopes: ["read"],
  };
  const response = await handleAppSearch(
    new Request("https://gateway.test/app/search", { method: "POST", body: JSON.stringify({ query: ASK }) }),
    store,
    session,
  );
  await settle();
  assert.equal(response.status, 200);
  const rows = cp.calls.map((c) => c.body);
  assert.ok(rows.length >= 1 && rows.every((row) => row.surface === "app" && row.who === undefined && row.actor === undefined));
});

test("a fan-out target answers timing only; the asked-in workspace writes the one counted row, with the other's hits in it", async () => {
  const cp = fakeControlPlane();
  const others = wired(
    rowsOf(scannedStore({ "areas/renewal.md": "# Workers comp renewal\n\nCarrier quote due in March.\n" })),
    "ws_ops",
    cp,
    { grantId: "grant_ai", userId: "user_1", clientId: "mcp_client_ai" },
  );
  const home = await homeStore(cp, { grantId: "grant_ai", userId: "user_1", clientId: "mcp_client_ai" }, {
    async openContext(name) {
      if (name !== "@ops") throw new Error("not reachable");
      return { session: { scope: "private", workspaceId: "ws_ops" }, store: others.store };
    },
  });
  home.store.contexts = [
    { name: "me", current: true, role: "owner" },
    { name: "@ops", current: false, role: "member" },
  ];
  const { rules, overrides } = rulesFor();
  await findNotes(home.store, "private", rules, overrides, ASK, "");
  await home.settle();
  await others.settle();
  const counted = cp.calls.filter((c) => c.body.who !== undefined);
  assert.equal(counted.length, 1, "one counted row per search");
  assert.equal(counted[0].body.workspaceId, "ws_home");
  const opsRow = cp.calls.find((c) => c.body.workspaceId === "ws_ops").body;
  assert.deepEqual(Object.keys(opsRow).sort(), ["answeredBy", "found", "ms", "workspaceId"]);
  assert.ok(counted[0].body.hits.includes(await sha16("search-hit:ws_ops:areas/renewal.md")), "the other workspace's hit, hashed with its own id");
});

test("a note found in workspace B by a search asked in A: the open from B matches A's counted hit", async () => {
  const cp = fakeControlPlane();
  const ops = wired(
    rowsOf(scannedStore({ "areas/renewal.md": "# Workers comp renewal\n\nCarrier quote due in March.\n" })),
    "ws_ops",
    cp,
    { grantId: "grant_ai", userId: "user_1", clientId: "mcp_client_ai" },
  );
  const home = await homeStore(cp, { grantId: "grant_ai", userId: "user_1", clientId: "mcp_client_ai" }, {
    async openContext(name) {
      if (name !== "@ops") throw new Error("not reachable");
      return { session: { scope: "private", workspaceId: "ws_ops" }, store: ops.store };
    },
  });
  home.store.contexts = [
    { name: "me", current: true, role: "owner" },
    { name: "@ops", current: false, role: "member" },
  ];
  const { rules, overrides } = rulesFor();
  const found = await findNotes(home.store, "private", rules, overrides, ASK, "");
  await home.settle();
  assert.ok(found.hits.some((hit) => hit.key === "@ops/areas/renewal.md"), "B's note is in the answer");
  const [row] = cp.calls.filter((c) => c.body.who !== undefined).map((c) => c.body);
  const aHit = await sha16("search-hit:ws_ops:areas/renewal.md");
  assert.ok(row.hits.includes(aHit));

  const read = await callTool("read_note", { path: "areas/renewal.md" }, ops.store, "private");
  await ops.settle();
  assert.notEqual(read.isError, true);
  const open = cp.calls.find((c) => c.path === "/gateway/search-open").body;
  assert.equal(open.workspaceId, "ws_ops", "the open names the workspace the note was read from");
  assert.equal(open.actor, row.actor, "the same searcher in both workspaces");
  assert.equal(open.hit, aHit, "the open's hit is the hit A's row carries");
});

test("an open reports the searcher's actor and the same hit hash the search row carried", async () => {
  const cp = fakeControlPlane();
  const { store, settle } = await homeStore(cp, { grantId: "grant_ai", userId: "user_1", clientId: "mcp_client_ai" });
  const { rules, overrides } = rulesFor();
  const found = await findNotes(store, "private", rules, overrides, ASK, "");
  await settle();
  const [search] = cp.calls.map((c) => c.body);
  assert.ok(found.hits.some((hit) => hit.key === "inbox/todo.md"));

  const read = await callTool("read_note", { path: "inbox/todo.md" }, store, "private");
  await settle();
  assert.notEqual(read.isError, true);
  const open = cp.calls.find((c) => c.path === "/gateway/search-open")?.body;
  assert.deepEqual(Object.keys(open).sort(), ["actor", "hit", "workspaceId"]);
  assert.equal(open.workspaceId, "ws_home");
  assert.equal(open.actor, search.actor);
  assert.equal(open.hit, await sha16("search-hit:ws_home:inbox/todo.md"));
  assert.ok(search.hits.includes(open.hit));
});

test("the ChatGPT fetch reports an open too, under the same hit", async () => {
  const cp = fakeControlPlane();
  const { store, settle } = await homeStore(cp, { grantId: "grant_ai", userId: "user_1", clientId: "mcp_client_ai" });
  const read = await callTool("fetch", { id: "inbox/todo.md" }, store, "private");
  await settle();
  assert.notEqual(read.isError, true);
  const open = cp.calls.find((c) => c.path === "/gateway/search-open")?.body;
  assert.equal(open.hit, await sha16("search-hit:ws_home:inbox/todo.md"));
  assert.equal(open.actor, await sha16("search-actor:grant_ai"));
});

test("a refused read reports no open", async () => {
  const cp = fakeControlPlane();
  const { store, settle } = await homeStore(cp, { grantId: "grant_ai", userId: "user_1", clientId: "mcp_client_ai" });
  const read = await callTool("read_note", { path: "no/such/note.md" }, store, "private");
  await settle();
  assert.equal(read.isError, true);
  assert.ok(!cp.calls.some((c) => c.path === "/gateway/search-open"));
});

test("a failing control plane never breaks a search or a read", async () => {
  const cp = fakeControlPlane({ failTiming: true, failOpen: true });
  const { store, settle } = await homeStore(cp, { grantId: "grant_ai", userId: "user_1", clientId: "mcp_client_ai" });
  const { rules, overrides } = rulesFor();
  const found = await findNotes(store, "private", rules, overrides, ASK, "");
  await settle();
  assert.ok(found.hits.length >= 1, "the search still answers");
  const read = await callTool("read_note", { path: "inbox/todo.md" }, store, "private");
  await settle();
  assert.notEqual(read.isError, true, "the read still answers");
  assert.match(read.content[0].text, /renewal quote/);
});

test("a store that cannot defer sends nothing", async () => {
  const cp = fakeControlPlane();
  const store = rowsOf(scannedStore(NOTES));
  store.actor = { workspaceId: "ws_home", grantId: "grant_ai", clientId: "mcp_client_ai" };
  attachChangeReporters(store, "ws_home", cp, {});
  const { rules, overrides } = rulesFor();
  await findNotes(store, "private", rules, overrides, ASK, "");
  await callTool("read_note", { path: "inbox/todo.md" }, store, "private");
  assert.equal(cp.calls.length, 0);
});

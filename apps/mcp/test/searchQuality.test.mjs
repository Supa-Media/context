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
 *   session.js's open against the caller's own workspace removed     → 1 fails: "through real dispatch, a read in another context…"
 *   contextOpener.js attaching reporters with no searchEnv           → 1 fails: "a context a call opens reports…"
 */

import test from "node:test";
import assert from "node:assert/strict";
import { handleAppSearch } from "../src/http/appSearch.js";
import { findNotes } from "../src/tools/search.js";
import { callTool } from "../src/tools/dispatch.js";
import { callToolForSession } from "../src/tools/session.js";
import { fetchSearchQualityRoot, SearchQualityKeyObject } from "../src/search/qualityKeyObject.js";
import { attachChangeReporters } from "../src/controlPlane/changeReporters.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { withServedTree } from "./servedTree.mjs";
import { deriveSearchQualityKey, reportOpenedNote, searchQualityKeyOf } from "../src/search/quality.js";

const HEX16 = /^[0-9a-f]{16}$/;

/** A test root, long enough to derive from. Not a secret: it exists only in this file. */
const TEST_ROOT = "test-root-for-search-quality";
const KEY_PROMISE = deriveSearchQualityKey(TEST_ROOT);

/**
 * The expected MAC, computed here with Web Crypto from an HKDF derivation written out independently of
 * `search/quality.js`, so a wrong info string or a wrong seed format in the gateway fails these checks.
 */
const EXPECTED_KEY = (async () => {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(TEST_ROOT), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("context-search-quality-v1") },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
})();

async function mac(text) {
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", await EXPECTED_KEY, new TextEncoder().encode(text)));
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
function wired(store, workspaceId, controlPlane, actor, searchKey = KEY_PROMISE) {
  const pending = [];
  store.defer = (work) => pending.push(Promise.resolve(work));
  store.actor = { workspaceId, ...actor };
  attachChangeReporters(store, workspaceId, controlPlane, { searchKey });
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

async function homeStore(controlPlane, actor, extra = {}, searchKey = KEY_PROMISE) {
  const home = rowsOf(scannedStore(NOTES, extra));
  return wired(home, "ws_home", controlPlane, actor, searchKey);
}

const ASK = "renewal";

test("an AI client's search row carries who, actor and MAC'd hits, and nothing of the query or the paths", async () => {
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
  assert.equal(row.actor, await mac("search-actor:grant_ai"));
  assert.ok(row.hits.length >= 1 && row.hits.length <= 10);
  assert.ok(row.hits.every((hit) => HEX16.test(hit)));
  const expected = await Promise.all(found.hits.map((hit) => mac(`search-hit:${hit.key}`)));
  assert.deepEqual([...row.hits].sort(), [...expected].sort(), "the hits are the answer's, MAC'd by the address they are read by");
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
    assert.equal(row.actor, await mac("search-actor:grant_tex"), clientId);
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
  assert.ok(counted[0].body.hits.includes(await mac("search-hit:@ops/areas/renewal.md")), "the other workspace's hit, under its @name address");
});

test("a note found in workspace B by a search asked in A: an open with context @ops matches A's counted hit", async () => {
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
  const aHit = await mac("search-hit:@ops/areas/renewal.md");
  assert.ok(row.hits.includes(aHit));

  // The caller reads it the way its search named it: with context "@ops". The open is reported from the asked-in store
  // (`reportOpenedNote`), which computes the address the hit carries.
  reportOpenedNote("read_note", { path: "areas/renewal.md", context: "@ops" }, home.store, { isError: false });
  await home.settle();
  const open = cp.calls.find((c) => c.path === "/gateway/search-open").body;
  assert.equal(open.actor, row.actor, "the same searcher");
  assert.equal(open.hit, aHit, "an open with context @ops is the hit the search row carries");
  const plain = await mac("search-hit:areas/renewal.md");
  assert.ok(!cp.calls.some((c) => c.path === "/gateway/search-open" && c.body.hit === plain), "never as a plain path");
});

test("an open of the caller's own context, named or not, is the plain path", async () => {
  const cp = fakeControlPlane();
  const { store, settle } = await homeStore(cp, { grantId: "grant_ai", userId: "user_1", clientId: "mcp_client_ai" });
  store.contexts = [{ name: "@home", current: true, role: "owner" }];
  await callTool("read_note", { path: "inbox/todo.md", context: "@home" }, store, "private");
  await callTool("read_note", { path: "inbox/todo.md" }, store, "private");
  await settle();
  const hits = cp.calls.filter((c) => c.path === "/gateway/search-open").map((c) => c.body.hit);
  assert.deepEqual(hits, [await mac("search-hit:inbox/todo.md"), await mac("search-hit:inbox/todo.md")]);
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
  assert.equal(open.hit, await mac("search-hit:inbox/todo.md"));
  assert.ok(search.hits.includes(open.hit));
});

test("the ChatGPT fetch reports an open too, under the same hit", async () => {
  const cp = fakeControlPlane();
  const { store, settle } = await homeStore(cp, { grantId: "grant_ai", userId: "user_1", clientId: "mcp_client_ai" });
  const read = await callTool("fetch", { id: "inbox/todo.md" }, store, "private");
  await settle();
  assert.notEqual(read.isError, true);
  const open = cp.calls.find((c) => c.path === "/gateway/search-open")?.body;
  assert.equal(open.hit, await mac("search-hit:inbox/todo.md"));
  assert.equal(open.actor, await mac("search-actor:grant_ai"));
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

test("with no root, a search and an open send timing only: no actor, no hits, no who", async () => {
  const cp = fakeControlPlane();
  const { store, settle } = await homeStore(cp, { grantId: "grant_ai", userId: "user_1", clientId: "mcp_client_ai" }, {}, Promise.resolve(null));
  const { rules, overrides } = rulesFor();
  await findNotes(store, "private", rules, overrides, ASK, "");
  await callTool("read_note", { path: "inbox/todo.md" }, store, "private");
  await settle();
  const search = cp.calls.find((c) => c.path === "/gateway/search-timing").body;
  assert.deepEqual(Object.keys(search).sort(), ["answeredBy", "found", "ms", "workspaceId"]);
  assert.ok(!cp.calls.some((c) => c.path === "/gateway/search-open"));
});

test("the key is HKDF of the root under the quality info string, and GATEWAY_SECRET is never a root", async () => {
  const key = await deriveSearchQualityKey(TEST_ROOT);
  const seed = "grant_ai";
  const fromModule = await (await import("../src/search/quality.js")).searchActorHash(key, seed);
  assert.equal(fromModule, await mac(`search-actor:${seed}`));
  assert.equal(await deriveSearchQualityKey("short"), null, "a root too short to derive from gives no key");
  assert.equal(await searchQualityKeyOf({ GATEWAY_SECRET: "a-gateway-secret-convex-also-holds" }), null, "no key object, no key");
});

/** A Durable Object namespace over one in-memory `SearchQualityKeyObject`, counting the asks. */
function keyNamespace({ fail = false } = {}) {
  const data = new Map();
  const object = new SearchQualityKeyObject({
    storage: { get: async (k) => data.get(k), put: async (k, v) => void data.set(k, v) },
  });
  const ns = {
    asks: 0,
    names: [],
    data,
    idFromName(name) {
      ns.names.push(name);
      return { name };
    },
    get(_id, options) {
      ns.options = options;
      return {
        fetch: async (request) => {
          ns.asks += 1;
          if (fail) throw new Error("object unreachable");
          return object.fetch(request);
        },
      };
    },
  };
  return ns;
}

test("the key object makes one random root and keeps it, and refuses anything but POST", async () => {
  const ns = keyNamespace();
  const first = await fetchSearchQualityRoot({ SEARCH_QUALITY_KEY: ns });
  const second = await fetchSearchQualityRoot({ SEARCH_QUALITY_KEY: ns });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(second, first, "the same root on every ask");
  assert.deepEqual(ns.names, ["search-quality-key:v1", "search-quality-key:v1"], "one object");
  assert.equal(ns.options?.locationHint, "enam");
  const other = await fetchSearchQualityRoot({ SEARCH_QUALITY_KEY: keyNamespace() });
  assert.notEqual(other, first, "a new object makes a new random root");
  const object = new SearchQualityKeyObject({ storage: { get: async () => undefined, put: async () => {} } });
  assert.equal((await object.fetch(new Request("https://x.invalid/", { method: "GET" }))).status, 405);
});

test("the quality key comes from the key object once per env, and a failed ask is asked again", async () => {
  const ns = keyNamespace();
  const env = { SEARCH_QUALITY_KEY: ns, GATEWAY_SECRET: "a-gateway-secret-convex-also-holds" };
  const key = await searchQualityKeyOf(env);
  assert.ok(key, "a key");
  assert.equal(await searchQualityKeyOf(env), key, "derived once per env");
  assert.equal(ns.asks, 1);
  const root = ns.data.get("root");
  const expected = await deriveSearchQualityKey(root);
  const sign = async (k) => [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("x")))].join(",");
  assert.equal(await sign(key), await sign(expected), "derived from the object's root");
  const fromSecret = await deriveSearchQualityKey(env.GATEWAY_SECRET);
  assert.notEqual(await sign(key), await sign(fromSecret), "never from GATEWAY_SECRET");

  const down = keyNamespace({ fail: true });
  const downEnv = { SEARCH_QUALITY_KEY: down };
  assert.equal(await searchQualityKeyOf(downEnv), null, "unreachable: no key, timing only");
  assert.equal(await searchQualityKeyOf(downEnv), null);
  assert.equal(down.asks, 2, "a failure is not remembered");
});

test("reporters built with an env and no searchKey use the key object, and only when something is reported", async () => {
  const ns = keyNamespace();
  const cp = fakeControlPlane();
  const store = rowsOf(scannedStore(NOTES));
  const pending = [];
  store.defer = (work) => pending.push(Promise.resolve(work));
  store.actor = { workspaceId: "ws_home", grantId: "grant_ai", userId: "user_1", clientId: "mcp_client_ai" };
  attachChangeReporters(store, "ws_home", cp, { searchEnv: { SEARCH_QUALITY_KEY: ns } });
  assert.equal(ns.asks, 0, "attaching asks nothing");
  const { rules, overrides } = rulesFor();
  await findNotes(store, "private", rules, overrides, ASK, "");
  while (pending.length) await Promise.allSettled(pending.splice(0));
  const row = cp.calls.find((c) => c.body.who !== undefined)?.body;
  assert.ok(row, "a counted row");
  const key = await deriveSearchQualityKey(ns.data.get("root"));
  const { searchActorHash } = await import("../src/search/quality.js");
  assert.equal(row.actor, await searchActorHash(key, "grant_ai"));
});

/**
 * A connection whose own workspace is `@home`, reaching `@ops` as a member, both wired the way a request wires them,
 * and every call made through `callToolForSession`, which takes `context` off the arguments before the tool sees it.
 */
async function twoContexts(cp) {
  const actor = { grantId: "grant_ai", userId: "user_1", clientId: "mcp_client_ai" };
  const ops = wired(rowsOf(scannedStore({ "areas/renewal.md": "# Renewal\n\nThe renewal plan.\n" })), "ws_ops", cp, actor);
  ops.store.contexts = [{ name: "@ops", current: true, role: "member" }];
  const opsSession = { workspaceId: "ws_ops", workspaceSlug: "ops", workspaceKind: "shared", scope: "private", role: "owner", grantId: "grant_ai", actorUserId: "user_1", actorClientId: "mcp_client_ai" };
  const home = await homeStore(cp, actor, {
    async openContext(name) {
      if (name !== "@ops") throw new Error("not reachable");
      return { session: opsSession, store: ops.store };
    },
  });
  home.store.contexts = [
    { name: "@home", current: true, role: "owner" },
    { name: "@ops", current: false, role: "member" },
  ];
  const session = { workspaceId: "ws_home", workspaceSlug: "home", workspaceKind: "personal", scope: "private", role: "owner", grantId: "grant_ai", actorUserId: "user_1", actorClientId: "mcp_client_ai" };
  const settle = async () => {
    await home.settle();
    await ops.settle();
  };
  return { home, ops, session, settle };
}

test("through real dispatch, a read in another context opens the search hit wherever the search was asked", async () => {
  const cp = fakeControlPlane();
  const { home, session, settle } = await twoContexts(cp);
  const read = await callToolForSession({ name: "read_note", arguments: { path: "areas/renewal.md", context: "@ops" } }, home.store, session, { legacy: true });
  await settle();
  assert.notEqual(read.isError, true, JSON.stringify(read));
  const opens = cp.calls.filter((c) => c.path === "/gateway/search-open").map((c) => c.body);
  const actor = await mac("search-actor:grant_ai");
  assert.deepEqual(
    opens.map((o) => [o.workspaceId, o.hit]).sort(),
    [
      ["ws_home", await mac("search-hit:@ops/areas/renewal.md")],
      ["ws_ops", await mac("search-hit:areas/renewal.md")],
    ].sort(),
    "the caller's own workspace by @ops/path (a search across contexts), and @ops by its plain path (a search asked there)",
  );
  assert.ok(opens.every((o) => o.actor === actor), "one searcher in both");
});

test("through real dispatch, a read in the caller's own context opens one hit, by its plain path", async () => {
  const cp = fakeControlPlane();
  const { home, session, settle } = await twoContexts(cp);
  await callToolForSession({ name: "read_note", arguments: { path: "inbox/todo.md" } }, home.store, session, { legacy: true });
  await settle();
  const opens = cp.calls.filter((c) => c.path === "/gateway/search-open").map((c) => c.body);
  assert.deepEqual(opens.map((o) => [o.workspaceId, o.hit]), [["ws_home", await mac("search-hit:inbox/todo.md")]]);
});

test("a context a call opens reports its searches and opens under the connection's key, not timing only", async () => {
  const { attachContextOpener, onceEach } = await import("../src/http/contextOpener.js");
  const ns = keyNamespace();
  const cp = { ...fakeControlPlane(), reportSearchIndexProgress: async () => {}, notifyFormSubmission: async () => {} };
  const caller = { workspaceId: "ws_mine", grantId: "grant_ai", actorUserId: "user_1", actorClientId: "mcp_client_ai", grantScopes: ["context:read"], workspaces: [{ workspaceId: "ws_w2", slug: "team-w2", kind: "shared", role: "member" }] };
  Object.defineProperty(caller, "accessToken", { value: "fake-token" });
  const pending = [];
  const store = { defer: (work) => pending.push(Promise.resolve(work)) };
  const opened = {};
  attachContextOpener(store, caller, { env: { SEARCH_QUALITY_KEY: ns }, controlPlane: cp, origin: "https://example.test", openOnce: onceEach(async () => opened), pinnedName: "@context-lc" });
  const { store: other } = await store.openContext("@team-w2");
  assert.equal(other, opened);
  other.reportSearchOpen("areas/renewal.md");
  while (pending.length) await Promise.allSettled(pending.splice(0));
  const open = cp.calls.find((c) => c.path === "/gateway/search-open")?.body;
  assert.ok(open, "the opened context reports an open (with no key it would send nothing)");
  const key = await deriveSearchQualityKey(ns.data.get("root"));
  const { searchActorHash, searchHitHash } = await import("../src/search/quality.js");
  assert.equal(open.workspaceId, "ws_w2");
  assert.equal(open.actor, await searchActorHash(key, "grant_ai"));
  assert.equal(open.hit, await searchHitHash(key, "areas/renewal.md"));
});

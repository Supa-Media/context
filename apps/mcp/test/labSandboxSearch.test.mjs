// The Lab's search try-out, `op: "search"` on the sandbox route (packages/lab/gateway/labSandbox/search.js; Dev2,
// 2026-11-21: a draft's search config run next to main's, unrecorded). Fake ids, words and workspaces only.
//
// Sabotage (temporary local edits, reverted, 2026-11-21):
//   search.js dropping `record: false` from the draft run       "a try-out writes no counted row" fails
//   search.js skipping draftSearchOf's problems check          "a draft out of bounds is refused before any store opens" fails
//   search.js answering `changed` from the draft against itself "the settings that differ are named" fails

import test from "node:test";
import assert from "node:assert/strict";
import { handleLabSandbox } from "../../../packages/lab/gateway/labSandbox/route.js";
import { changedSettings, draftSearchOf, searchAnswer, searchInput } from "../../../packages/lab/gateway/labSandbox/search.js";
import { SEARCH_CONFIG } from "../src/search/config/searchConfig.cjs";
import { labSearchGraph } from "../src/search/config/labDraft.cjs";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { withServedTree } from "./servedTree.mjs";

const ALICE = "tok_alice_example_000000000000";
const STRANGER = "tok_nobody_example_0000000000";
const ME = { userId: "u_alice", workspaceId: "ws_alice" };

/** Fake control plane answers: who is asked, the session, and the drafts the Lab holds (by id). */
function routeWorld(drafts = {}) {
  const asked = [];
  const env = { LAB_SANDBOX: {}, CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000" };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    asked.push(body.action);
    const answer = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (!String(url).endsWith("/gateway/tex/lab-sandbox")) return answer({});
    if (body.accessToken !== ALICE) return answer({ status: "refused" });
    if (body.action === "who") return answer({ status: "ok", userId: ME.userId, chats: [] });
    if (body.action === "draft") {
      const graph = drafts[body.args.draft];
      return graph ? answer({ status: "ok", graph: JSON.stringify(graph) }) : answer({ status: "not_found" });
    }
    if (body.action === "session") return answer({ status: "ok", session: { grantId: "g1", clientId: "context_texts", actorUserId: ME.userId, scopes: ["context:read"], defaultWorkspaceId: ME.workspaceId, workspaces: [] }, people: [] });
    return answer({ status: "bad_request" });
  };
  const call = async (token, body) => {
    const response = await handleLabSandbox(new Request("https://gateway.example.invalid/tex-lab/sandbox", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env, null, {});
    return { status: response.status, body: await response.json() };
  };
  return { call, asked, restore: () => (globalThis.fetch = original) };
}

/** A copy of search's config with one step's settings laid over. */
function configWith(id, settings) {
  const config = structuredClone(SEARCH_CONFIG);
  const node = config.nodes.find((n) => n.id === id);
  node.settings = { ...node.settings, ...settings };
  return config;
}

test("a stranger is refused the search; a missing or long query and a bad only are refused before any session is opened", async () => {
  const w = routeWorld();
  try {
    assert.equal((await w.call(STRANGER, { op: "search", query: "renewal" })).status, 403);
    const none = await w.call(ALICE, { op: "search" });
    assert.equal(none.status, 400);
    assert.match(none.body.error, /query is the words to search for, at most 300 characters/);
    assert.equal((await w.call(ALICE, { op: "search", query: "x".repeat(301) })).status, 400);
    assert.equal((await w.call(ALICE, { op: "search", query: "   " })).status, 400);
    const badOnly = await w.call(ALICE, { op: "search", query: "renewal", only: ["ops"] });
    assert.equal(badOnly.status, 400);
    assert.match(badOnly.body.error, /only is a list of @names/);
    assert.ok(!w.asked.includes("session"), "no session is asked for a refused search");
  } finally {
    w.restore();
  }
});

test("a draft whose search config is out of bounds is refused with the problem, before any store opens", async () => {
  const w = routeWorld({ v1: labSearchGraph(configWith("fuse", { hits: 500 })) });
  try {
    const refused = await w.call(ALICE, { op: "search", query: "renewal", versionId: "v1" });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /hits must be from 1 to 50/);
    assert.ok(!w.asked.includes("session"), "no session is asked for a refused draft");
  } finally {
    w.restore();
  }
});

test("a draft with no search steps is not refused: it searches as main does", async () => {
  // A draft holding only Tex's steps: searchConfigFromDraft finds none, so the draft side is null, not an error.
  const w = routeWorld({ v2: { nodes: [{ id: "fd", label: "Front door", on: true, model: "code" }], edges: [] } });
  try {
    const got = await w.call(ALICE, { op: "search", query: "renewal", versionId: "v2" });
    assert.notEqual(got.status, 400, "a draft with no search steps is not a bad draft");
    assert.ok(w.asked.includes("draft"));
  } finally {
    w.restore();
  }
});

test("searchInput checks the query and the only list", () => {
  assert.deepEqual(searchInput({ query: "renewal", only: ["@ops"] }), { query: "renewal", only: ["@ops"] });
  assert.deepEqual(searchInput({ query: "renewal" }), { query: "renewal", only: null });
  assert.match(searchInput({ query: "a".repeat(300 + 1) }).error, /at most 300/);
  assert.match(searchInput({ query: "renewal", only: "@ops" }).error, /only is a list/);
});

test("draftSearchOf: no search steps is null; a sound config is kept; a broken one names its problem", () => {
  assert.deepEqual(draftSearchOf({ nodes: [{ id: "fd" }], edges: [] }), { config: null });
  const sound = labSearchGraph(SEARCH_CONFIG);
  assert.equal(draftSearchOf(sound).config.nodes.length, 3);
  assert.match(draftSearchOf(labSearchGraph(configWith("each", { minScore: 9 }))).error, /minScore/);
});

test("the settings that differ from main are named per step", () => {
  const draft = { nodes: configWith("fuse", { hits: 2 }).nodes, edges: [] };
  assert.deepEqual(changedSettings(draft), ["fuse.hits"]);
  assert.deepEqual(changedSettings({ nodes: SEARCH_CONFIG.nodes, edges: [] }), []);
});

// --- The answer for one person's store (a fake store as `searchQuality.test.mjs` builds one) ---

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

/** Home with three renewal notes and @ops with two: a search across workspaces runs `fuse`, which the draft tunes. */
function homeStore() {
  const others = {
    "@ops": withPrivacyAuthority(scannedStore({ "areas/renewal.md": "# Workers comp renewal\n\nCarrier quote due in March.\n", "areas/renewal-notes.md": "# Notes\n\nThe renewal call went fine.\n" }), { rules: { etag: "rows-v1", accessVersion: 1, folders: [], notes: [] } }),
  };
  const home = withPrivacyAuthority(
    scannedStore(
      {
        "inbox/todo.md": "# Todo\n\nCall the carrier about the renewal quote.\n",
        "projects/renewal.md": "# Renewal\n\nThe renewal plan.\n",
        "archive/old-renewal.md": "# Old renewal\n\nLast year's renewal.\n",
      },
      {
        contexts: [{ name: "@me", current: true, role: "owner" }, { name: "@ops", role: "member" }],
        async openContext(name) {
          if (!others[name]) throw new Error("not reachable");
          return { session: { scope: "private" }, store: others[name] };
        },
      },
    ),
    { rules: { etag: "rows-v1", accessVersion: 1, folders: [], notes: [] } },
  );
  home.reportSearchTiming = async (fields) => {
    home.rows.push(fields);
  };
  home.rows = [];
  return home;
}

test("a try-out answers main and the draft, ranked, with each step's time, and names the settings that differ", async () => {
  const store = homeStore();
  const config = configWith("fuse", { hits: 2 });
  const answer = await searchAnswer({ store, scope: "private", rules: [], overrides: new Map(), query: "renewal", config });
  assert.equal(answer.query, "renewal");
  assert.deepEqual(answer.main.steps.map((s) => s.node), ["search", "each", "fuse"], "a search across workspaces runs fuse");
  assert.deepEqual(answer.main.searched, ["@me", "@ops"]);
  assert.ok(answer.main.steps.every((s) => s.ok === true && typeof s.ms === "number"));
  assert.ok(answer.main.hits.length > 2, "main shows its whole fused list");
  assert.equal(answer.draft.hits.length, 2, "the draft's hits setting is the most it shows");
  assert.deepEqual(answer.draft.hits.map((h) => h.key), answer.main.hits.slice(0, 2).map((h) => h.key));
  assert.deepEqual(answer.changed, ["fuse.hits"]);
  assert.equal(store.rows.length, 0, "a try-out writes no counted row, nor a timing row");
});

test("a draft with no search config answers draft null and changes nothing", async () => {
  const store = homeStore();
  const answer = await searchAnswer({ store, scope: "private", rules: [], overrides: new Map(), query: "renewal", config: null });
  assert.equal(answer.draft, null);
  assert.deepEqual(answer.changed, []);
  assert.ok(answer.main.hits.length > 0);
  assert.equal(store.rows.length, 0);
});

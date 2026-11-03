/**
 * The app's Copy and Duplicate of one note, made by the gateway (`src/live/fileCopy.js`), and the route that serves
 * them (`POST /files/copy`, `/files/duplicate` in `src/live/fileOpsRoute.js`, `serveCopy`).
 *
 * Proven here:
 * - a plain copy of a Markdown note within the caller's reach is put under a new name, exactly, with the tier the
 *   control plane gives it, and nothing else is written to the rows;
 * - a note private only because of its folder stays private in a team folder, its exact row written before the put;
 * - the source is judged first: what the caller cannot see is `not_found` whatever the destination holds, and a
 *   destination the caller cannot see gives the same answer whether or not it exists (no existence leak);
 * - every case the gateway does not take (an exact override, a group-held source, a folder, a picture, a sealed or
 *   plumbing path) answers `defer` or `invalid_path` with nothing put;
 * - Duplicate picks the first free "… copy" name and gives up to the control plane after DUPLICATE_TRIES;
 * - a failed audit entry never fails a copy that landed;
 * - the route answers the copy in the app's shape, refuses unknown body keys, and serves only a workspace whose notes
 *   live in its object, without touching the store or the object otherwise.
 *
 * Sabotage, each confirmed to fail a case here: drop the source's `canSee`, the override `defer`, the team caller's
 * `forbidden`, the private carry, the put's `onlyIf: absent`, or the destination probe.
 *
 * Not covered here: the shared-editing read in `currentText` (this fake store has no collaboration support); it is
 * the same `readDocument` call `copyPath` and the move tools make.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyNote, duplicateNote, duplicateNames, DUPLICATE_TRIES } from "../src/live/fileCopy.js";
import { handleFileOp } from "../src/live/fileOpsRoute.js";
import { PRE_PARSED_RULES, PRIVACY_KEY, PrivacyOverrides } from "../src/privacy/engine.js";
import { SCOPE_READ, SCOPE_WRITE } from "../src/session.js";

// The workspace's rules as the access rows render them: a team folder, a private folder, and a group-held folder.
const RULES = [
  { prefix: "projects", vis: "team" },
  { prefix: "secret", vis: "private" },
  { prefix: "design", vis: "@design" },
];
const AUDIT = ".context/audit/";

/**
 * A store with the access rules loaded the way `loadPrivacyState` reads them (`PRE_PARSED_RULES` on the privacy
 * object), an in-memory bucket with conditional create, and a row-tier stand-in that records each call. `log` is one
 * ordered list of the puts and row writes, so an order can be asserted.
 */
function fakeStore({ files = {}, rules = RULES, overrides = [], throwOnAudit = false } = {}) {
  const objects = new Map(Object.entries(files));
  const log = [];
  const overrideMap = new PrivacyOverrides();
  for (const [path, visibility] of overrides) overrideMap.set(path, visibility);
  let version = 0;
  return {
    // No `conditionalCreate`: `collaborationSupported` is false, so the stored text is the note's text.
    capabilities: { conditionalWrite: true },
    objects,
    log,
    async get(key) {
      if (key === PRIVACY_KEY) return { etag: "rules-1", [PRE_PARSED_RULES]: { rules, overrides: overrideMap } };
      if (!objects.has(key)) return null;
      const text = objects.get(key);
      return { etag: `e-${key}`, text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
    },
    async head(key) {
      return objects.has(key) ? { etag: `e-${key}`, size: objects.get(key).length } : null;
    },
    async put(key, value, options = {}) {
      log.push({ op: "put", key, options });
      if (throwOnAudit && key.startsWith(AUDIT)) throw new Error("audit store unavailable");
      if (options.onlyIf?.absent === true && objects.has(key)) return null;
      objects.set(key, String(value));
      return { etag: `v${++version}` };
    },
    rowAccess: {
      async setTier(path, tier, opts) {
        log.push({ op: "setTier", path, tier, opts });
        return { ok: true, version: 1 };
      },
    },
  };
}

const caller = (scope, groups = []) => ({ scope, groups: new Set(groups) });
const putsTo = (store, key) => store.log.filter((entry) => entry.op === "put" && entry.key === key);
const rowWrites = (store) => store.log.filter((entry) => entry.op === "setTier");

test("a team caller's copy of a team note lands under the new name, exactly, with no row written", async () => {
  const body = "# A\n\nSome *text*.\n";
  const store = fakeStore({ files: { "projects/a.md": body } });
  const answer = await copyNote(store, caller("team"), "projects/a.md", "projects/b.md");
  assert.deepEqual(answer, { ok: true, from: "projects/a.md", to: "projects/b.md" });
  assert.equal(store.objects.get("projects/b.md"), body);
  assert.equal(store.objects.get("projects/a.md"), body, "the source is untouched");
  const [put] = putsTo(store, "projects/b.md");
  assert.deepEqual(put.options, { onlyIf: { absent: true }, tier: "team" });
  assert.deepEqual(rowWrites(store), [], "no tier persisted for a copy that takes its folder's tier");
});

test("a note private only by its folder stays private in a team folder, its row written before the put", async () => {
  const store = fakeStore({ files: { "secret/a.md": "held back\n" } });
  const answer = await copyNote(store, caller("private"), "secret/a.md", "projects/a.md");
  assert.deepEqual(answer, { ok: true, from: "secret/a.md", to: "projects/a.md" });
  const rowIndex = store.log.findIndex((entry) => entry.op === "setTier");
  const putIndex = store.log.findIndex((entry) => entry.op === "put" && entry.key === "projects/a.md");
  assert.ok(rowIndex >= 0, "the exact row is written");
  assert.ok(rowIndex < putIndex, "the narrowing lands before the copy is put");
  assert.equal(store.log[rowIndex].path, "projects/a.md");
  assert.equal(store.log[rowIndex].tier, "private");
  const [put] = putsTo(store, "projects/a.md");
  assert.equal(put.options.tier, "private");
});

test("a source the caller cannot see is not_found, and nothing is put even when the destination is taken", async () => {
  const store = fakeStore({ files: { "secret/a.md": "held back\n", "projects/b.md": "already here\n" } });
  const answer = await copyNote(store, caller("team"), "secret/a.md", "projects/b.md");
  assert.deepEqual(answer, { ok: false, code: "not_found" });
  assert.deepEqual(
    store.log.filter((entry) => entry.op === "put" || entry.op === "setTier"),
    [],
    "nothing put and no row written",
  );
});

test("a destination that already exists is taken, for an owner and for a team caller alike", async () => {
  const files = { "projects/a.md": "a\n", "projects/b.md": "b\n" };
  const owner = fakeStore({ files });
  assert.deepEqual(await copyNote(owner, caller("private"), "projects/a.md", "projects/b.md"), { ok: false, code: "taken" });
  assert.equal(store_text(owner, "projects/b.md"), "b\n", "the existing note is not overwritten");
  const team = fakeStore({ files });
  assert.deepEqual(await copyNote(team, caller("team"), "projects/a.md", "projects/b.md"), { ok: false, code: "taken" });
  assert.equal(store_text(team, "projects/b.md"), "b\n");
});

test("a destination the caller cannot see answers the same whether or not it exists, so existence does not leak", async () => {
  // A team caller aimed at a private folder is `forbidden` before the destination is probed, so the answer is the
  // same with or without a note there. The doc comment in fileCopy.js says `taken` is answered for any live name
  // "seen by the caller or not"; this case records what the code does instead (see the report).
  const empty = fakeStore({ files: { "projects/a.md": "a\n" } });
  const occupied = fakeStore({ files: { "projects/a.md": "a\n", "secret/b.md": "hidden\n" } });
  const without = await copyNote(empty, caller("team"), "projects/a.md", "secret/b.md");
  const withNote = await copyNote(occupied, caller("team"), "projects/a.md", "secret/b.md");
  assert.deepEqual(without, { ok: false, code: "forbidden" });
  assert.deepEqual(withNote, without);
});

test("a source with its own exact override, or one held by a group, is deferred to the control plane", async () => {
  const exact = fakeStore({ files: { "projects/a.md": "a\n" }, overrides: [["projects/a.md", "team"]] });
  assert.deepEqual(await copyNote(exact, caller("team"), "projects/a.md", "projects/b.md"), { ok: false, code: "defer" });
  const owned = fakeStore({ files: { "projects/a.md": "a\n" }, overrides: [["projects/a.md", "private"]] });
  assert.deepEqual(await copyNote(owned, caller("private"), "projects/a.md", "projects/b.md"), { ok: false, code: "defer" });
  assert.deepEqual(putsTo(exact, "projects/b.md"), []);

  const grouped = fakeStore({ files: { "design/a.md": "a\n" } });
  assert.deepEqual(await copyNote(grouped, caller("team", ["@design"]), "design/a.md", "projects/b.md"), { ok: false, code: "defer" });
  assert.deepEqual(putsTo(grouped, "projects/b.md"), []);
});

test("a team caller copying into a private folder is forbidden, and nothing is put", async () => {
  const store = fakeStore({ files: { "projects/a.md": "a\n" } });
  assert.deepEqual(await copyNote(store, caller("team"), "projects/a.md", "secret/a.md"), { ok: false, code: "forbidden" });
  assert.deepEqual(putsTo(store, "secret/a.md"), []);
});

test("a picture or PDF, a plumbing path, or a source the same as its destination is refused as the spec names", async () => {
  const store = fakeStore({ files: { "projects/a.png": "bytes", "projects/a.md": "a\n" } });
  assert.deepEqual(await copyNote(store, caller("team"), "projects/a.png", "projects/b.png"), { ok: false, code: "defer" });
  assert.deepEqual(await copyNote(store, caller("team"), "projects/a.md", "projects/b.png"), { ok: false, code: "defer" });
  assert.deepEqual(await copyNote(store, caller("team"), ".context/x.md", "projects/b.md"), { ok: false, code: "invalid_path" });
  assert.deepEqual(await copyNote(store, caller("team"), "projects/a.md", ".context/x.md"), { ok: false, code: "invalid_path" });
  assert.deepEqual(await copyNote(store, caller("team"), "projects/a.md", "projects/a.md"), { ok: false, code: "invalid_path" });
  assert.deepEqual(await copyNote(store, caller("team"), "/", "projects/b.md"), { ok: false, code: "invalid_path" });
  assert.deepEqual(
    store.log.filter((entry) => entry.op === "put"),
    [],
    "no refusal wrote anything",
  );
});

test("Duplicate takes the first free \"copy\" name, and a plain one when none is taken", async () => {
  const files = { "projects/a.md": "a\n", "projects/a copy.md": "earlier\n" };
  const taken = fakeStore({ files });
  assert.deepEqual(await duplicateNote(taken, caller("team"), "projects/a.md"), {
    ok: true,
    from: "projects/a.md",
    to: "projects/a copy 2.md",
  });
  assert.equal(store_text(taken, "projects/a copy 2.md"), "a\n");
  assert.equal(store_text(taken, "projects/a copy.md"), "earlier\n", "the earlier copy is not touched");

  const free = fakeStore({ files: { "projects/a.md": "a\n" } });
  assert.deepEqual(await duplicateNote(free, caller("team"), "projects/a.md"), {
    ok: true,
    from: "projects/a.md",
    to: "projects/a copy.md",
  });
});

test("duplicateNames yields \"x copy\", \"x copy 2\", \"x copy 3\" beside the note, and at the top level", () => {
  const names = duplicateNames("projects/x.md")();
  assert.deepEqual([names.next().value, names.next().value, names.next().value], [
    "projects/x copy.md",
    "projects/x copy 2.md",
    "projects/x copy 3.md",
  ]);
  const top = duplicateNames("x.md")();
  assert.deepEqual([top.next().value, top.next().value, top.next().value], ["x copy.md", "x copy 2.md", "x copy 3.md"]);
  const bare = duplicateNames("projects/notes")();
  assert.equal(bare.next().value, "projects/notes copy", "a name with no extension keeps none");
});

test("Duplicate gives up to the control plane once every try is taken", async () => {
  const files = { "projects/a.md": "a\n", "projects/a copy.md": "c\n" };
  for (let counter = 2; counter <= DUPLICATE_TRIES; counter += 1) files[`projects/a copy ${counter}.md`] = "c\n";
  const store = fakeStore({ files });
  assert.deepEqual(await duplicateNote(store, caller("team"), "projects/a.md"), { ok: false, code: "defer" });
  assert.deepEqual(
    store.log.filter((entry) => entry.op === "put"),
    [],
    "no copy was put",
  );
});

test("a copy that landed still answers ok when its audit entry cannot be written", async () => {
  const store = fakeStore({ files: { "projects/a.md": "a\n" }, throwOnAudit: true });
  const answer = await copyNote(store, caller("team"), "projects/a.md", "projects/b.md");
  assert.deepEqual(answer, { ok: true, from: "projects/a.md", to: "projects/b.md" });
  assert.equal(store_text(store, "projects/b.md"), "a\n");
});

// --- The route (`handleFileOp`, as the gateway serves it) ----------------------------------------------------------

const TEAM = { scope: "team", grantedGroups: new Set(), actorUserId: "user_1", scopes: [SCOPE_READ, SCOPE_WRITE] };

/** The request's store with the object's client, which must never be asked for a copy. */
function routeStore(files, { home = "object", behind = false } = {}) {
  const store = fakeStore({ files });
  const objectCalls = [];
  const record = (op) => async () => (objectCalls.push(op), { ok: false, code: "NOT_FOUND" });
  store.objectReading = {
    client: { write: { trash: record("trash"), restore: record("restore"), move: record("move") } },
    home,
    behind,
  };
  store.objectCalls = objectCalls;
  return store;
}

const post = (path, body) =>
  new Request(`https://gateway.example${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("POST /files/copy in an object-home workspace answers the app's moved shape, and the object is not asked", async () => {
  const store = routeStore({ "projects/a.md": "a\n" });
  const response = await handleFileOp(post("/files/copy", { from: "projects/a.md", to: "projects/b.md" }), "/files/copy", store, TEAM);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { kind: "moved", from: "projects/a.md", to: "projects/b.md", paths: ["projects/b.md"] });
  assert.equal(store_text(store, "projects/b.md"), "a\n");
  assert.deepEqual(store.objectCalls, []);
});

test("POST /files/copy refuses a body key it does not take with 400, and copies nothing", async () => {
  const store = routeStore({ "projects/a.md": "a\n" });
  const response = await handleFileOp(
    post("/files/copy", { from: "projects/a.md", to: "projects/b.md", expectedEtag: "e1" }),
    "/files/copy",
    store,
    TEAM,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_path" });
  assert.deepEqual(store.log.filter((entry) => entry.op === "put"), []);
});

test("a workspace not served by its object answers 409 not_object without touching the store", async () => {
  for (const options of [{ home: "bucket" }, { home: "dual" }, { home: "object", behind: true }]) {
    const store = routeStore({ "projects/a.md": "a\n" }, options);
    const reads = [];
    const get = store.get;
    store.get = async (key) => (reads.push(key), get(key));
    const response = await handleFileOp(post("/files/copy", { from: "projects/a.md", to: "projects/b.md" }), "/files/copy", store, TEAM);
    assert.equal(response.status, 409, JSON.stringify(options));
    assert.deepEqual(await response.json(), { error: "not_object" });
    assert.deepEqual(reads, [], JSON.stringify(options));
    assert.deepEqual(store.log, [], JSON.stringify(options));
  }
});

test("a copy the gateway defers answers 409 not_object, so the app sends it to the control plane", async () => {
  const store = routeStore({ "projects/a.png": "bytes" });
  const response = await handleFileOp(post("/files/copy", { from: "projects/a.png", to: "projects/b.png" }), "/files/copy", store, TEAM);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "not_object" });
});

test("a copy's refusals keep the control plane's statuses: not_found 404, taken 409", async () => {
  const hidden = routeStore({ "secret/a.md": "x\n", "projects/b.md": "y\n" });
  const missing = await handleFileOp(post("/files/copy", { from: "secret/a.md", to: "projects/b.md" }), "/files/copy", hidden, TEAM);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not_found" });

  const taken = routeStore({ "projects/a.md": "x\n", "projects/b.md": "y\n" });
  const answer = await handleFileOp(post("/files/copy", { from: "projects/a.md", to: "projects/b.md" }), "/files/copy", taken, TEAM);
  assert.equal(answer.status, 409);
  assert.deepEqual(await answer.json(), { error: "taken" });
});

test("POST /files/duplicate answers the moved shape, and refuses any key but path", async () => {
  const store = routeStore({ "projects/a.md": "a\n" });
  const response = await handleFileOp(post("/files/duplicate", { path: "projects/a.md" }), "/files/duplicate", store, TEAM);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { kind: "moved", from: "projects/a.md", to: "projects/a copy.md", paths: ["projects/a copy.md"] });

  const extra = routeStore({ "projects/a.md": "a\n" });
  const refused = await handleFileOp(post("/files/duplicate", { path: "projects/a.md", to: "projects/z.md" }), "/files/duplicate", extra, TEAM);
  assert.equal(refused.status, 400);
  assert.deepEqual(extra.log, [], "nothing was read or put for a refused body");
});

test("a session with only read scope is refused 403 before anything is read", async () => {
  const store = routeStore({ "projects/a.md": "a\n" });
  const reader = { ...TEAM, scopes: [SCOPE_READ] };
  const copy = await handleFileOp(post("/files/copy", { from: "projects/a.md", to: "projects/b.md" }), "/files/copy", store, reader);
  assert.equal(copy.status, 403);
  const duplicate = await handleFileOp(post("/files/duplicate", { path: "projects/a.md" }), "/files/duplicate", store, reader);
  assert.equal(duplicate.status, 403);
  assert.deepEqual(store.log, []);
});

/** The text at `key` in a fake store (the stored text, read back). */
function store_text(store, key) {
  return store.objects.get(key);
}

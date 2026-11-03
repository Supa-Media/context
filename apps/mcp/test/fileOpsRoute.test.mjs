/**
 * `POST /files/trash` and `/files/restore` (`src/live/fileOpsRoute.js`): the app's trash and restore, answered by
 * the workspace's object. The object is judged by the session's own clearance, never by the body; a workspace whose
 * notes are not in its object answers `not_object` without asking it; refusals keep the object's meaning.
 *
 * Sabotage, each expected to fail a case here: take the scope from the body, drop the home check, drop the write
 * scope check, or let an unknown body key through.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FILE_OP_PATHS, handleFileOp } from "../src/live/fileOpsRoute.js";
import { isTransportPath } from "../src/origin.js";
import { SCOPE_READ, SCOPE_WRITE } from "../src/session.js";

const session = { scope: "team", grantedGroups: ["design"], actorUserId: "user_1", scopes: [SCOPE_READ, SCOPE_WRITE] };

function storeWith(answer, { home = "object", behind = false } = {}) {
  const calls = [];
  const client = {
    write: {
      trash: async (body) => (calls.push({ op: "trash", body }), typeof answer === "function" ? answer(body) : answer),
      restore: async (body) => (calls.push({ op: "restore", body }), typeof answer === "function" ? answer(body) : answer),
    },
  };
  return { calls, store: { objectReading: { client, home, behind } } };
}

const post = (path, body) =>
  new Request(`https://gateway.example${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("both routes are origin-checked", () => {
  for (const path of FILE_OP_PATHS) assert.equal(isTransportPath(path), true, path);
});

test("a trash is answered by the object, judged by the session's clearance", async () => {
  const { calls, store } = storeWith({ ok: true, to: ".context/trash/2026-11-03T03-00-00-000Z/plans/a.md", count: 1, at: 5 });
  const response = await handleFileOp(post("/files/trash", { path: "plans/a.md", expectedEtag: "e1" }), "/files/trash", store, session);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    kind: "moved",
    from: "plans/a.md",
    to: ".context/trash/2026-11-03T03-00-00-000Z/plans/a.md",
    paths: [".context/trash/2026-11-03T03-00-00-000Z/plans/a.md"],
  });
  assert.deepEqual(calls, [{ op: "trash", body: { path: "plans/a.md", expectedEtag: "e1", scope: "team", groups: ["design"], userId: "user_1" } }]);
});

test("a restore is answered by the object", async () => {
  const from = ".context/trash/2026-11-03T03-00-00-000Z/plans/a.md";
  const { calls, store } = storeWith({ ok: true, count: 1, at: 6 });
  const response = await handleFileOp(post("/files/restore", { from, to: "plans/a.md" }), "/files/restore", store, session);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { kind: "moved", from, to: "plans/a.md", paths: ["plans/a.md"] });
  assert.equal(calls[0].op, "restore");
  assert.equal(calls[0].body.scope, "team");
});

test("the body cannot name the caller's clearance", async () => {
  const { calls, store } = storeWith({ ok: true, to: "x", count: 1, at: 1 });
  for (const extra of [{ scope: "private" }, { groups: ["owners"] }, { userId: "user_owner" }]) {
    const response = await handleFileOp(post("/files/trash", { path: "plans/a.md", ...extra }), "/files/trash", store, session);
    assert.equal(response.status, 400, JSON.stringify(extra));
  }
  assert.equal(calls.length, 0);
});

test("a workspace not served by its object answers not_object and never asks it", async () => {
  for (const options of [{ home: "bucket" }, { home: "dual" }, { home: "object", behind: true }]) {
    const { calls, store } = storeWith({ ok: true, to: "x", count: 1, at: 1 }, options);
    const response = await handleFileOp(post("/files/trash", { path: "plans/a.md" }), "/files/trash", store, session);
    assert.equal(response.status, 409, JSON.stringify(options));
    assert.deepEqual(await response.json(), { error: "not_object" });
    assert.equal(calls.length, 0);
  }
  const response = await handleFileOp(post("/files/trash", { path: "plans/a.md" }), "/files/trash", {}, session);
  assert.equal(response.status, 409);
});

test("a session without write is refused before anything is read", async () => {
  const { calls, store } = storeWith({ ok: true, to: "x", count: 1, at: 1 });
  const reader = { ...session, scopes: [SCOPE_READ] };
  const response = await handleFileOp(post("/files/trash", { path: "plans/a.md" }), "/files/trash", store, reader);
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});

test("refusals keep their meaning, and a hidden path reads as a missing one", async () => {
  const cases = [
    [{ ok: false, code: "NOT_FOUND" }, 404, { error: "not_found" }],
    [{ ok: false, code: "HIDDEN" }, 404, { error: "not_found" }],
    [{ ok: false, code: "CHANGED", currentEtag: "e2" }, 409, { error: "changed", currentEtag: "e2" }],
    [{ ok: false, code: "TAKEN" }, 409, { error: "taken" }],
    [{ ok: false, code: "ARCHIVE_STAYS" }, 409, { error: "protected" }],
    [{ ok: false, code: "INVALID" }, 400, { error: "invalid_path" }],
    [{ error: "refused", message: "a trash names its path" }, 503, { error: "unavailable" }],
    [{ ok: false, code: "MIRROR_PENDING" }, 503, { error: "mirror_pending" }],
  ];
  for (const [answer, status, body] of cases) {
    const { store } = storeWith(answer);
    const response = await handleFileOp(post("/files/trash", { path: "plans/a.md" }), "/files/trash", store, session);
    assert.equal(response.status, status, JSON.stringify(answer));
    assert.deepEqual(await response.json(), body);
  }
});

test("bad bodies are refused without asking the object", async () => {
  const { calls, store } = storeWith({ ok: true, to: "x", count: 1, at: 1 });
  const bad = [
    ["/files/trash", {}],
    ["/files/trash", { path: "" }],
    ["/files/trash", { path: "a\u0000b" }],
    ["/files/trash", { path: "x".repeat(2000) }],
    ["/files/trash", { path: "a.md", expectedEtag: 5 }],
    ["/files/restore", { from: ".context/trash/s/a.md" }],
    ["/files/restore", { from: ".context/trash/s/a.md", to: "a.md", extra: 1 }],
  ];
  for (const [path, body] of bad) {
    const response = await handleFileOp(post(path, body), path, store, session);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const notJson = new Request("https://gateway.example/files/trash", { method: "POST", body: "nope" });
  assert.equal((await handleFileOp(notJson, "/files/trash", store, session)).status, 400);
  const get = new Request("https://gateway.example/files/trash", { method: "GET" });
  assert.equal((await handleFileOp(get, "/files/trash", store, session)).status, 405);
  assert.equal(calls.length, 0);
});

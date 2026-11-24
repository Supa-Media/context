// The app saving a whole note through the gateway, into the workspace object (`live/noteWriteRoute.js`).
//
// 2026-11-24 (Dev): "if we could migrate off and just use what the mcp uses that would be great", behind a flag.
// Until then the app's whole-note saves (a new note, the offline outbox's drain) went through the control plane's
// `files.writeNote`, so a note's text passed through Convex. These cases send what the app sends and check that the
// save keeps that action's rules exactly, since the outbox depends on them, and that what the route does not settle
// is handed back to the control plane rather than refused or written.
//
// Sabotage, confirmed (applied, run, named case failing, reverted):
//  1. The workspace check dropped from `handleNoteWrite` → "a save named for another workspace…" fails.
//  2. `replaceLiveText` swapped for `replaceNoteText` with `onlyCurrent: true` (write_note's merge) → "an offline edit
//     typed against an older version is merged…" fails with a conflict.
//  3. The client check dropped → "only the app's own client saves here" fails.
//  4. `canSee` dropped → "a note held back is answered as a missing one…" fails (the member's save lands).
//  5. `tier: inherited` replaced by `tier: "private"` → "a new note takes its folder's access…" fails.
//  6. The flag check dropped → "a person without the flag…" fails.
//  7. `flags` dropped from the session `sessionFromPayload` builds (`session.js`) → "a save over a note…" fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { texObjects } from "../../../packages/tex/gateway/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { personRows } from "../src/workspaceStore/personRows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { bindingRows } from "../src/workspaceStore/bindingRows.js";
import { workspaceMarks } from "../src/workspaceStore/marks.js";
import { mirrorOutbox } from "../src/workspaceStore/mirrorOutbox.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { workspaceClient } from "../src/workspaceStore/api.js";
import { ACCESS_HOMES, objectToken } from "../src/workspaceStore/access.js";
import { sha256Hex } from "../src/controlPlane/index.js";
import { sealBinding } from "../src/workspaceStore/bindingSeal.js";
import { splitWorkspacePath } from "../src/workspacePath.js";
import { NOTE_READ_PATH } from "../src/live/noteReadRoute.js";
import { APP_SAVES_FLAG, CONFLICT_MESSAGES, handleNoteWrite, NOTE_WRITE_PATH } from "../src/live/noteWriteRoute.js";
import { renderEncryptedNote } from "../src/encryption/format.js";
import { isFlagId } from "../../../packages/shared/src/flags.cjs";
import { createWorkerCtx } from "./workerCtx.mjs";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

function durableSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...binds) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...binds);
        return { toArray: () => all };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
}

/** Workspace objects by name, each answering as the real object's `serveWorkspaceStore` does, writes included. */
function namespace() {
  const objects = new Map();
  const ops = [];
  return {
    ops,
    idFromName: (name) => ({ name, toString: () => name }),
    get(id) {
      if (!objects.has(id.name)) {
        const sql = durableSql();
        const store = {
          sql,
          objects: texObjects(sql),
          rows: workspaceRows(sql),
          person: personRows(sql),
          members: workspaceMembers(sql),
          binding: bindingRows(sql),
          marks: workspaceMarks(sql),
          mirror: mirrorOutbox(sql),
          transact: (fn) => fn(),
          flushMirror: async () => ({ done: true }),
          mirrorSoon: async () => {},
        };
        objects.set(id.name, {
          store,
          fetch: (request) => {
            ops.push(JSON.parse(decodeURIComponent(request.headers.get("x-tex-call") ?? "{}")).op);
            return serveWorkspaceStore(store, request);
          },
        });
      }
      return objects.get(id.name);
    },
  };
}

const SECRET = "gateway-secret-for-tests-only-0123456789";
const RULES = { etag: "m.1", accessVersion: 1, folders: [{ prefix: "areas", visibility: "team" }], notes: [{ path: "todo.md", visibility: "team" }, { path: "areas/secret.md", visibility: "private" }] };
const PWID = "pAlice";
const USER = "uAlice";
const SLUG = "alice";

function answerFor(workspaceId, notesHome = "object") {
  return {
    binding: { workspaceId, provider: "r2", endpoint: "https://s3.example-fileops.test", bucket: `bucket-${workspaceId}`, accessKeyId: `key-${workspaceId}`, secretAccessKey: `secret-${workspaceId}`, capabilities: { conditionalWrite: true, conditionalCreate: true }, notesHome, notesBackfilledAt: 1, status: "active" },
    searchIndex: null,
    meaningIndex: null,
    encryptionKey: null,
    rotation: null,
    noteCap: null,
    managedEncryption: null,
    privacy: RULES,
    idLayout: "keys",
    features: {},
    keyed: true,
  };
}

const ROWS = [
  { id: "d-areas", path: "areas", kind: "folder", at: 1 },
  { id: "f-todo", path: "todo.md", kind: "file", at: 2, storageKey: "notes/0199a000-0000-7000-8000-000000000001.md", noteId: "0199a000-0000-7000-8000-000000000001", etag: "e-todo" },
  { id: "f-daniel", path: "areas/daniel-2.md", kind: "file", at: 3, storageKey: "notes/0199a000-0000-7000-8000-000000000002.md", noteId: "0199a000-0000-7000-8000-000000000002", etag: "e-daniel" },
  { id: "f-secret", path: "areas/secret.md", kind: "file", at: 4, storageKey: "notes/0199a000-0000-7000-8000-000000000003.md", noteId: "0199a000-0000-7000-8000-000000000003", etag: "e-secret" },
];

/** Alice's personal workspace on its object: her session, her access, a sealed binding and her notes, all there. */
async function world({ notesHome = "object", flags = [APP_SAVES_FLAG] } = {}) {
  const ns = namespace();
  const env = {
    WORKSPACE_STORE: ns,
    GATEWAY_SECRET: SECRET,
    CONTROL_PLANE_URL: "https://control.invalid",
    CONTROL_PLANE_SECRET: "x".repeat(40),
  };
  const token = objectToken("access", PWID, "a".repeat(43));
  const aiToken = objectToken("access", PWID, "b".repeat(43));
  const access = workspaceClient(env, PWID).access;
  await access.pin(USER);
  await access.reach.put([{ workspaceId: PWID, slug: SLUG, kind: "personal", role: "owner", groups: [], at: 1 }]);
  await access.connections.put([
    { grantId: "gAlice", clientId: "context_console", clientName: "Context", workspaceId: PWID, scopes: ["context:read", "context:write"], tokenHash: await sha256Hex(token), refreshHash: await sha256Hex(`${token}r`), expiresAt: Date.now() + 3_600_000, status: "active", at: 1 },
    { grantId: "gClaude", clientId: "claude", clientName: "Claude", workspaceId: PWID, scopes: ["context:read", "context:write"], tokenHash: await sha256Hex(aiToken), refreshHash: await sha256Hex(`${aiToken}r`), expiresAt: Date.now() + 3_600_000, status: "active", at: 1 },
  ]);
  await access.setHome(ACCESS_HOMES.OBJECT);
  await access.flags.put({ flags, at: 1 });
  const client = workspaceClient(env, PWID);
  await client.setHome("object");
  await client.setEncryption("none");
  await client.rules.put(RULES, "member");
  const object = ns.get(ns.idFromName(`workspace:${PWID}`));
  object.store.rows.pinWorkspace(PWID);
  object.store.rows.put(ROWS);
  object.store.rows.putRules(RULES);
  object.store.members.put("members", [{ userId: USER, personalWorkspaceId: PWID, role: "owner", groups: [], at: 1 }]);
  object.store.members.setHome("object");
  await object.store.objects.put("notes/0199a000-0000-7000-8000-000000000001.md", "# Todo\n\nBuy milk.\n");
  await object.store.objects.put("notes/0199a000-0000-7000-8000-000000000002.md", "# Daniel\n");
  await object.store.objects.put("notes/0199a000-0000-7000-8000-000000000003.md", "# Secret\n\nNot for members.\n");
  object.store.rows.markBackfilled(1);
  object.store.binding.put({ sealed: await sealBinding(answerFor(PWID, notesHome), { secret: SECRET, workspaceId: PWID }), at: Date.now(), epoch: object.store.binding.get().epoch });
  return { ns, env, token, aiToken, object };
}

/**
 * The workspace's bucket, as far as these cases reach it: the backup copies and the activity log written behind a
 * save. An in-memory S3 that keeps what is put, so a save's bookkeeping runs as it does in production.
 */
function withBucket(run) {
  return async () => {
    const real = globalThis.fetch;
    const kept = new Map();
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (!url.hostname.endsWith("example-fileops.test")) return await real(input, init);
      const key = url.pathname;
      if (request.method === "PUT") {
        kept.set(key, new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { status: 200, headers: { etag: `"${kept.size}"` } });
      }
      if (request.method === "DELETE") {
        kept.delete(key);
        return new Response(null, { status: 204 });
      }
      if (!kept.has(key)) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
      return new Response(request.method === "HEAD" ? null : kept.get(key), { status: 200, headers: { etag: `"${kept.size}"`, "content-length": String(kept.get(key).byteLength) } });
    };
    try {
      await run();
    } finally {
      globalThis.fetch = real;
    }
  };
}

const send = (w, address, body, token = w.token) =>
  worker.fetch(
    new Request(`https://gateway.test${address}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    w.env,
    createWorkerCtx(),
  );

const answer = async (response) => ({ status: response.status, body: await response.json() });
const open = async (w, path) => answer(await send(w, `/@${SLUG}${NOTE_READ_PATH}`, { path }));
const save = async (w, fields, token) => answer(await send(w, `/@${SLUG}${NOTE_WRITE_PATH}`, { workspaceId: PWID, ...fields }, token));
const stored = async (w, key) => {
  const row = await w.object.store.objects.get(key);
  return row?.body === undefined ? null : typeof row.body === "string" ? row.body : new TextDecoder().decode(row.body);
};
const TODO_KEY = "notes/0199a000-0000-7000-8000-000000000001.md";
const SECRET_KEY = "notes/0199a000-0000-7000-8000-000000000003.md";
const NOT_SERVED = { status: 409, body: { error: "not_object" } };

test("the save's address is never read as a workspace name, and its flag is a real one", () => {
  assert.deepEqual(splitWorkspacePath(NOTE_WRITE_PATH), { slug: null, path: NOTE_WRITE_PATH });
  assert.equal(isFlagId(APP_SAVES_FLAG), true);
});

test("a save over a note, from the version the app read, lands in the object and the next open reads it", { skip }, withBucket(async () => {
  const w = await world();
  const first = await open(w, "todo.md");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  w.ns.ops.length = 0;
  const saved = await save(w, { path: "todo.md", text: "# Todo\n\nBuy oat milk.\n", expectedEtag: first.body.etag });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(Object.keys(saved.body).sort(), ["bytes", "conflictCheck", "etag", "forms", "kind", "path"]);
  assert.deepEqual([saved.body.kind, saved.body.path, saved.body.conflictCheck], ["written", "todo.md", "conditional"]);
  assert.ok(w.ns.ops.includes("ws.collab.replace"), `the object did not merge it: ${w.ns.ops.join(", ")}`);
  const again = await open(w, "todo.md");
  assert.equal(again.body.text, "# Todo\n\nBuy oat milk.\n");
  assert.equal(again.body.etag, saved.body.etag);
}));

test("an offline edit typed against an older version is merged, as the control plane's save merged it", { skip }, withBucket(async () => {
  const w = await world();
  await w.object.store.objects.put(TODO_KEY, "# Todo\n\nBuy milk.\n\nCall the bank.\n");
  const first = await open(w, "todo.md");
  // Saved from another device meanwhile.
  const there = await save(w, { path: "todo.md", text: "# Todo\n\nBuy oat milk.\n\nCall the bank.\n", expectedEtag: first.body.etag });
  assert.equal(there.status, 200, JSON.stringify(there.body));
  // The outbox drains an edit typed on the train against the first version.
  const queued = await save(w, { path: "todo.md", text: "# Todo\n\nBuy milk.\n\nCall the bank today.\n", expectedEtag: first.body.etag });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  assert.equal((await open(w, "todo.md")).body.text, "# Todo\n\nBuy oat milk.\n\nCall the bank today.\n");
}));

test("the outbox's conflicts are the control plane's: an existing note with no version, and a version for a gone one", { skip }, withBucket(async () => {
  const w = await world();
  const exists = await save(w, { path: "todo.md", text: "# Mine\n" });
  assert.equal(exists.status, 409);
  assert.deepEqual([exists.body.code, exists.body.message], ["CONFLICT", CONFLICT_MESSAGES.exists]);
  assert.equal(typeof exists.body.currentEtag, "string", "the current version, so Keep mine can send against it");
  assert.equal(await stored(w, TODO_KEY), "# Todo\n\nBuy milk.\n", "nothing was written");

  const gone = await save(w, { path: "areas/was-here.md", text: "# Was\n", expectedEtag: "e-old" });
  assert.equal(gone.status, 409);
  assert.deepEqual(gone.body, { error: "conflict", code: "CONFLICT", message: CONFLICT_MESSAGES.gone }, "no current version: it was deleted");
}));

test("a new note takes its folder's access, with no rule pinned on it, and a second create is a conflict", { skip }, withBucket(async () => {
  const w = await world();
  const made = await save(w, { path: "areas/plan.md", text: "# Plan\n" });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const opened = await open(w, "areas/plan.md");
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.deepEqual([opened.body.text, opened.body.visibility, opened.body.exception], ["# Plan\n", "team", false]);

  const twice = await save(w, { path: "areas/plan.md", text: "# Other\n" });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.message, CONFLICT_MESSAGES.exists);
  assert.equal((await open(w, "areas/plan.md")).body.text, "# Plan\n");
}));

test("a save named for another workspace is refused before anything is read", { skip }, withBucket(async () => {
  const w = await world();
  w.ns.ops.length = 0;
  const elsewhere = await answer(await send(w, `/@${SLUG}${NOTE_WRITE_PATH}`, { workspaceId: "pBob", path: "todo.md", text: "# Bob's\n" }));
  assert.deepEqual(elsewhere, { status: 409, body: { error: "wrong_workspace" } });
  assert.equal(await stored(w, TODO_KEY), "# Todo\n\nBuy milk.\n");
  assert.ok(!w.ns.ops.some((op) => op.startsWith("ws.collab") || op === "put"), w.ns.ops.join(", "));
}));

test("only the app's own client saves here; an AI client saves with write_note", { skip }, withBucket(async () => {
  const w = await world();
  const first = await open(w, "todo.md");
  const ai = await save(w, { path: "todo.md", text: "# Mine\n", expectedEtag: first.body.etag }, w.aiToken);
  assert.equal(ai.status, 403);
  assert.equal(await stored(w, TODO_KEY), "# Todo\n\nBuy milk.\n");
}));

test("a person without the flag is handed to the control plane, and nothing is written", { skip }, withBucket(async () => {
  const w = await world({ flags: [] });
  w.ns.ops.length = 0;
  assert.deepEqual(await save(w, { path: "areas/plan.md", text: "# Plan\n" }), NOT_SERVED);
  assert.ok(!w.ns.ops.includes("put"), w.ns.ops.join(", "));
}));

/** The handler alone, over a store whose object home is `home`; the session is the app's, with the flag. */
const APP = { scope: "private", scopes: ["context:read", "context:write"], grantedGroups: new Set(), workspaceId: PWID, actorClientId: "context_console", flags: [APP_SAVES_FLAG] };
const saveRequest = (body) => new Request("https://gateway.test/files/write", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("a workspace whose notes are not in its object yet is handed to the control plane, its object never asked", async () => {
  for (const home of ["bucket", "dual"]) {
    let asked = false;
    const store = { objectReading: { client: {}, home, behind: false }, get: async () => { asked = true; return null; }, put: async () => { asked = true; return null; } };
    const response = await handleNoteWrite(saveRequest({ workspaceId: PWID, path: "areas/plan.md", text: "# Plan\n" }), store, APP);
    assert.deepEqual([response.status, await response.json()], [409, { error: "not_object" }], home);
    assert.equal(asked, false, home);
  }
  // Behind its own wait, too: an older answer is never served.
  const behind = { objectReading: { client: {}, home: "object", behind: true }, get: async () => assert.fail("read while behind") };
  assert.equal((await handleNoteWrite(saveRequest({ workspaceId: PWID, path: "areas/plan.md", text: "# Plan\n" }), behind, APP)).status, 409);
});

test("a session without write access is refused before anything is read", async () => {
  const store = { objectReading: { client: {}, home: "object", behind: false }, get: async () => assert.fail("read without write") };
  const response = await handleNoteWrite(saveRequest({ workspaceId: PWID, path: "areas/plan.md", text: "# Plan\n" }), store, { ...APP, scopes: ["context:read"] });
  assert.equal(response.status, 403);
});

test("a note held back is answered as a missing one, and never written", { skip }, withBucket(async () => {
  const w = await world();
  // A member who may write, not the owner: the private note and the private top level are held back from them.
  w.object.store.members.put("members", [{ userId: USER, personalWorkspaceId: PWID, role: "editor", groups: [], at: 1 }]);
  await workspaceClient(w.env, PWID).access.reach.put([{ workspaceId: PWID, slug: SLUG, kind: "shared", role: "editor", groups: [], at: 1 }]);
  w.ns.ops.length = 0;
  const hidden = await save(w, { path: "areas/secret.md", text: "# Mine\n", expectedEtag: "e-secret" });
  const missing = await save(w, { path: "areas/nobody.md", text: "# Mine\n", expectedEtag: "e-secret" });
  const privateFolder = await save(w, { path: "private-thing.md", text: "# Mine\n" });
  assert.deepEqual(hidden, NOT_SERVED);
  assert.deepEqual(missing.status === 409 && missing.body.error === "conflict", true, "a visible missing note is the control plane's gone conflict");
  assert.deepEqual(privateFolder, NOT_SERVED, "a team reader creates only where the folder is open to them");
  assert.equal(await stored(w, SECRET_KEY), "# Secret\n\nNot for members.\n");
  assert.ok(!w.ns.ops.some((op) => op.startsWith("ws.collab") || op === "put"), w.ns.ops.join(", "));
}));

test("what this route does not settle goes to the control plane: an envelope, a form, a picture, Tex's folder", { skip }, withBucket(async () => {
  const w = await world();
  const envelope = renderEncryptedNote({ v: 1, kdf: { name: "x" }, iv: "i", ciphertext: "c" });
  for (const fields of [
    { path: "areas/locked.md", text: envelope },
    { path: "areas/form.md", text: "# Form\n\n```form\nid: rsvp\nfields:\n  - name: who\n    type: text\n```\n" },
    { path: "areas/photo.png", text: "x" },
    { path: "tex/notes.md", text: "# Mine\n" },
  ]) {
    assert.deepEqual(await save(w, fields), NOT_SERVED, fields.path);
  }
  const extra = await answer(await send(w, `/@${SLUG}${NOTE_WRITE_PATH}`, { workspaceId: PWID, path: "todo.md", text: "x", force: true }));
  assert.equal(extra.status, 400, "nothing rides along, and there is no force");
  const plumbing = await save(w, { path: ".context/collaboration/v1/heads/x.md", text: "x" });
  assert.equal(plumbing.status, 400);
}));

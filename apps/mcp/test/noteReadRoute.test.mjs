// The app opening a note through the gateway's front door, read in the workspace object (`live/noteReadRoute.js`).
//
// 2026-11-11 (Dev2): typing in a note, "This note cannot be opened safely for collaborative editing" appeared and the
// note went blank. The app opened notes through the control plane, which ran its own copy of the editing-history
// engine against the object while the gateway saved the typing with another; a read caught between two saves gave up,
// and the app closed the note. These cases send the request the app sends and check the answer is the note, read by
// the object's one engine, and that what this route does not serve is handed back to the control plane, never
// refused as missing.
//
// Sabotage, confirmed (applied, run, named case failing, reverted):
//  1. `canSee` dropped from `handleNoteRead` → "the gateway judges the reader itself…" fails (the object is asked
//     for the held-back note). The front-door case still passes then, because the object's own lookup holds the note
//     back too; the gateway's judgement is checked on its own for that reason.
//  2. `start: true` dropped from the object read → "a note nobody has edited together opens ready to edit live…"
//     fails (the Markdown etag comes back, so the app would not edit it live).
//  3. The engine's refusal answered as the Markdown → "a read the engine cannot finish…" fails.
//  4. `isEncryptedNote` not asked → "a password-encrypted note is its ciphertext, read-only" fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { texObjects } from "../src/texStore/objects.js";
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
import { handleNoteRead, NOTE_READ_PATH } from "../src/live/noteReadRoute.js";
import { PRE_PARSED_RULES, PrivacyOverrides } from "../src/privacy/engine.js";
import { renderEncryptedNote } from "../src/encryption/format.js";
import * as Y from "yjs";
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
// Team-visible, so the case is about the address and not about who may see the note.
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
async function world({ notesHome = "object" } = {}) {
  const ns = namespace();
  const env = {
    WORKSPACE_STORE: ns,
    GATEWAY_SECRET: SECRET,
    CONTROL_PLANE_URL: "https://control.invalid",
    CONTROL_PLANE_SECRET: "x".repeat(40),
  };
  const token = objectToken("access", PWID, "a".repeat(43));
  const access = workspaceClient(env, PWID).access;
  await access.pin(USER);
  await access.reach.put([{ workspaceId: PWID, slug: SLUG, kind: "personal", role: "owner", groups: [], at: 1 }]);
  await access.connections.put([
    { grantId: "gAlice", clientId: "context-console", clientName: "Context", workspaceId: PWID, scopes: ["context:read", "context:write"], tokenHash: await sha256Hex(token), refreshHash: await sha256Hex(`${token}r`), expiresAt: Date.now() + 3_600_000, status: "active", at: 1 },
  ]);
  await access.setHome(ACCESS_HOMES.OBJECT);
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
  return { ns, env, token, object };
}

const post = (w, address, body) =>
  worker.fetch(
    new Request(`https://gateway.test${address}`, {
      method: "POST",
      headers: { authorization: `Bearer ${w.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    w.env,
    createWorkerCtx(),
  );

const open = (w, path, prefix = `/@${SLUG}`) => post(w, `${prefix}${NOTE_READ_PATH}`, { path });

test("the open's address is never read as a workspace name", () => {
  assert.deepEqual(splitWorkspacePath(NOTE_READ_PATH), { slug: null, path: NOTE_READ_PATH });
});

test("a note nobody has edited together opens ready to edit live, read by the object in one call", { skip }, async () => {
  const w = await world();
  w.ns.ops.length = 0;
  const response = await open(w, "todo.md");
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.kind, "file");
  assert.equal(body.path, "todo.md");
  assert.equal(body.text, "# Todo\n\nBuy milk.\n");
  assert.match(body.etag, /^c2\./, "the editing history's version, so the app edits it live");
  assert.equal(typeof body.rawEtag, "string");
  assert.equal(typeof body.documentId, "string");
  assert.deepEqual([body.visibility, body.inherited, body.exception, body.readOnly, body.encrypted], ["team", "private", true, false, false]);
  assert.ok(w.ns.ops.includes("ws.collab.read"), "the object read it");
  assert.ok(!w.ns.ops.includes("get"), `the gateway read storage itself: ${w.ns.ops.join(", ")}`);

  // A second open reads the same history: same document, same version.
  const again = await (await open(w, "todo.md")).json();
  assert.equal(again.documentId, body.documentId);
  assert.equal(again.etag, body.etag);
});

test("the bare address (no workspace in it) opens the same note", { skip }, async () => {
  const w = await world();
  const response = await open(w, "areas/daniel-2.md", "");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, "# Daniel\n");
});

test("a note this reader may not see is handed to the control plane exactly as a missing one, and never read", { skip }, async () => {
  const w = await world();
  // A member, not the owner: the private note is held back from them.
  w.object.store.members.put("members", [{ userId: USER, personalWorkspaceId: PWID, role: "member", groups: [], at: 1 }]);
  await workspaceClient(w.env, PWID).access.reach.put([{ workspaceId: PWID, slug: SLUG, kind: "personal", role: "member", groups: [], at: 1 }]);
  w.ns.ops.length = 0;
  const hidden = await open(w, "areas/secret.md");
  const hiddenBody = await hidden.json();
  const missing = await open(w, "areas/nobody.md");
  const missingBody = await missing.json();
  assert.deepEqual([hidden.status, hiddenBody], [409, { error: "not_object" }]);
  assert.deepEqual([missing.status, missingBody], [hidden.status, hiddenBody], "held back and missing answer alike");
  assert.ok(!w.ns.ops.includes("ws.collab.read"), "the object was asked for a note's words this reader may not have");
});

test("what this route does not serve goes to the control plane, not refused", { skip }, async () => {
  const w = await world();
  for (const path of ["areas/photo.png"]) {
    const response = await open(w, path);
    assert.deepEqual([response.status, await response.json()], [409, { error: "not_object" }], path);
  }
  const plumbing = await open(w, ".context/collaboration/v1/heads/x.json");
  assert.equal(plumbing.status, 400);
  const extra = await post(w, `/@${SLUG}${NOTE_READ_PATH}`, { path: "todo.md", text: "x" });
  assert.equal(extra.status, 400, "nothing rides along");
});

/** The handler alone, over a store whose object answers `answer` for the read. */
function handlerStore(answer, home = "object") {
  return {
    objectReading: { client: {}, home, behind: false },
    get: async (key) => (key === "privacy.md" ? { [PRE_PARSED_RULES]: { rules: [{ prefix: "1-projects", vis: "team" }], overrides: new PrivacyOverrides() } } : null),
    oneRead(store) {
      return { noteAt: async () => ({ key: "notes/x.md", etag: "e", noteId: "x" }), readInObject: async () => answer, get: store.get };
    },
  };
}

const request = (body) => new Request("https://gateway.test/files/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const PLAN = "1-projects/plan.md";
const TEAM = { scope: "team", scopes: ["context:read"], grantedGroups: new Set() };

test("a read the engine cannot finish is unavailable, never the note's Markdown and never a refusal", async () => {
  const store = handlerStore({ served: true, markdown: { etag: "raw", size: 3, text: "old" }, error: { code: "DEPENDENCY_PENDING", message: "waiting" } });
  const response = await handleNoteRead(request({ path: PLAN }), store, TEAM);
  assert.deepEqual([response.status, await response.json()], [503, { error: "unavailable" }]);
});

test("a password-encrypted note is its ciphertext, read-only", async () => {
  const text = renderEncryptedNote({ v: 1, kdf: { name: "x" }, iv: "i", ciphertext: "c" });
  const store = handlerStore({ served: true, markdown: { etag: "raw", size: text.length, text }, collaboration: null });
  const response = await handleNoteRead(request({ path: PLAN }), store, TEAM);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual([body.text, body.etag, body.readOnly, body.encrypted], [text, "raw", true, true]);
});

test("a workspace whose notes are not in its object yet is handed to the control plane, its object never asked", async () => {
  for (const home of ["bucket", "dual"]) {
    let asked = false;
    const store = handlerStore({ served: true, markdown: { etag: "raw", size: 1, text: "x" }, collaboration: null }, home);
    const view = store.oneRead(store);
    store.oneRead = () => ({ ...view, readInObject: async () => { asked = true; return null; } });
    const response = await handleNoteRead(request({ path: PLAN }), store, TEAM);
    assert.deepEqual([response.status, await response.json()], [409, { error: "not_object" }], home);
    assert.equal(asked, false, home);
  }
});

test("a session without read access is refused before anything is looked up", async () => {
  const store = handlerStore({ served: true, markdown: { etag: "raw", size: 1, text: "x" }, collaboration: null });
  const response = await handleNoteRead(request({ path: PLAN }), store, { scope: "team", scopes: [], grantedGroups: new Set() });
  assert.equal(response.status, 403);
});

test("the gateway judges the reader itself: a note its rules hold back is never asked of the object", async () => {
  let asked = false;
  const store = handlerStore({ served: true, markdown: { etag: "raw", size: 6, text: "secret" }, collaboration: null });
  const view = store.oneRead(store);
  store.oneRead = () => ({ ...view, readInObject: async () => { asked = true; return { served: true, markdown: { etag: "raw", size: 6, text: "secret" }, collaboration: null }; } });
  const response = await handleNoteRead(request({ path: "2-areas/private.md" }), store, TEAM);
  assert.deepEqual([response.status, await response.json()], [409, { error: "not_object" }]);
  assert.equal(asked, false, "the object was asked for a note this reader may not see");
});

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

// The editor's live session on the same note (`live/collaborationRoute.js`, `live/collaborationInObject.js`): its read
// and its typing are run by the object's engine, one call each, so nothing edits the history from outside the object.
//
// Sabotage, confirmed: `commitLiveUpdate` going straight to the engine fails "typing is committed inside the object"
// (no `ws.collab.commit`, and the gateway reads the history key by key).
test("typing is committed inside the object, and the next open reads it", { skip }, withBucket(async () => {
  const w = await world();
  const live = async (body) => {
    const response = await post(w, `/@${SLUG}/collaboration`, body);
    return { status: response.status, body: await response.json() };
  };
  const first = await live({ path: "todo.md" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(typeof first.body.update, "string", "the editor's read carries the snapshot it merges from");
  assert.ok(w.ns.ops.includes("ws.collab.read"));

  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(first.body.update, "base64"));
  const before = Y.encodeStateVector(doc);
  doc.getText("note").insert(doc.getText("note").length, "Call the bank.\n");
  const update = Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64");

  w.ns.ops.length = 0;
  const committed = await live({ path: "todo.md", documentId: first.body.documentId, update });
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  assert.equal(committed.body.text, "# Todo\n\nBuy milk.\nCall the bank.\n");
  assert.ok(w.ns.ops.includes("ws.collab.commit"), `the object did not commit it: ${w.ns.ops.join(", ")}`);
  assert.ok(!w.ns.ops.includes("put"), `the gateway wrote the history itself: ${w.ns.ops.join(", ")}`);

  const opened = await (await open(w, "todo.md")).json();
  assert.equal(opened.text, "# Todo\n\nBuy milk.\nCall the bank.\n");
  assert.equal(opened.etag, committed.body.etag);
}));

test("the editor's whole-text replacement keeps its merge inside the object", { skip }, withBucket(async () => {
  const w = await world();
  const first = await (await post(w, `/@${SLUG}/collaboration`, { path: "todo.md" })).json();
  w.ns.ops.length = 0;
  const response = await post(w, `/@${SLUG}/collaboration`, { path: "todo.md", replacement: { expectedEtag: first.etag, text: "# Todo\n\nBuy oat milk.\n" } });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.text, "# Todo\n\nBuy oat milk.\n");
  assert.ok(w.ns.ops.includes("ws.collab.replace"), w.ns.ops.join(", "));

  // Typed on a phone against the first version while that save landed: merged, never refused as an agent's would be.
  // Sabotage, confirmed: `onlyCurrent: false` dropped from `replaceLiveText` fails here with 409.
  const stale = await post(w, `/@${SLUG}/collaboration`, { path: "todo.md", replacement: { expectedEtag: first.etag, text: "# Todo\n\nBuy milk.\n\nAnd bread.\n" } });
  const merged = await stale.json();
  assert.equal(stale.status, 200, JSON.stringify(merged));
  assert.equal(merged.text, "# Todo\n\nBuy oat milk.\n\nAnd bread.\n");
}));

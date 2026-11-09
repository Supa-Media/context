// The app's file operations through the gateway's real front door (`src/index.js`), not the handler alone.
//
// 2026-11-09: every delete, rename, move, copy and duplicate from the app answered "That note is not there any more".
// The app posts `/files/trash` (and the rest), and the front door split the first segment off as a workspace selector
// because `files` was not a reserved route word, so the request asked a workspace called `files` for `/trash` and fell
// through to 404. `fileOpsRoute.test.mjs` called `handleFileOp` directly and never saw it. These cases send the request
// the app sends, with a bearer token, to `worker.fetch`, against a workspace object holding the note, and check the
// note actually left its name.
//
// Sabotage, confirmed: `files` dropped from `RESERVED_FIRST_SEGMENTS` fails the first case and every bare-address case
// here with the production answer, 404 `not_found`; the addressed cases keep passing, which is why the app now names
// its workspace in the address.
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
import { FILE_OP_PATHS } from "../src/live/fileOpsRoute.js";
import { splitWorkspacePath } from "../src/workspacePath.js";
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
const RULES = { etag: "m.1", accessVersion: 1, folders: [{ prefix: "areas", visibility: "team" }], notes: [{ path: "todo.md", visibility: "team" }] };
const PWID = "pAlice";
const USER = "uAlice";
const SLUG = "alice";

function answerFor(workspaceId) {
  return {
    binding: { workspaceId, provider: "r2", endpoint: "https://s3.example-fileops.test", bucket: `bucket-${workspaceId}`, accessKeyId: `key-${workspaceId}`, secretAccessKey: `secret-${workspaceId}`, capabilities: { conditionalWrite: true }, notesHome: "object", status: "active" },
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
  { id: "f-todo", path: "todo.md", kind: "file", at: 2, storageKey: "notes/f-todo.md", noteId: "f-todo", etag: "e-todo" },
  { id: "f-daniel", path: "areas/daniel-2.md", kind: "file", at: 3, storageKey: "notes/f-daniel.md", noteId: "f-daniel", etag: "e-daniel" },
];

/** Alice's personal workspace on its object: her session, her access, a sealed binding and her notes, all there. */
async function world() {
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
  object.store.binding.put({ sealed: await sealBinding(answerFor(PWID), { secret: SECRET, workspaceId: PWID }), at: Date.now(), epoch: object.store.binding.get().epoch });
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

const liveAt = (w, path) => w.object.store.rows.byPath(path);

test("no file operation's address is read as a workspace name", () => {
  for (const path of FILE_OP_PATHS) assert.deepEqual(splitWorkspacePath(path), { slug: null, path }, path);
});

for (const [label, prefix] of [
  ["with the workspace in the address", `/@${SLUG}`],
  ["with no workspace in the address (apps loaded before 2026-11-09)", ""],
]) {
  test(`a trash through the front door, ${label}, moves the note into the trash`, { skip }, async () => {
    const w = await world();
    const response = await post(w, `${prefix}/files/trash`, { path: "todo.md" });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.kind, "moved");
    assert.match(body.to, /^\.context\/trash\/[^/]+\/todo\.md$/);
    assert.ok(w.ns.ops.includes("ws.write.trash"), "the workspace object was asked");
    assert.equal(liveAt(w, "todo.md"), null, "nothing is left at the old name");
    assert.notEqual(liveAt(w, body.to), null, "the note is in the trash");

    const back = await post(w, `${prefix}/files/restore`, { from: body.to, to: "todo.md" });
    assert.equal(back.status, 200, JSON.stringify(await back.clone().json()));
    assert.notEqual(liveAt(w, "todo.md"), null, "restored");
  });

  test(`a rename through the front door, ${label}, reaches the workspace object`, { skip }, async () => {
    const w = await world();
    const response = await post(w, `${prefix}/files/move`, { from: "areas/daniel-2.md", to: "areas/daniel-3.md" });
    const body = await response.json();
    assert.ok(w.ns.ops.includes("ws.write.move"), "the workspace object was asked");
    // This object holds no access set yet, so it leaves the rename to the control plane, and the app sends it there
    // (`objectFileOps.ts`). What must never come back is the 404 the app reads as "not there any more".
    assert.deepEqual([response.status, body], [409, { error: "not_object" }]);
  });

  test(`a duplicate through the front door, ${label}, is answered by the gateway's copy, not refused as missing`, { skip }, async () => {
    const w = await world();
    const response = await post(w, `${prefix}/files/duplicate`, { path: "todo.md" });
    const body = await response.json();
    assert.notDeepEqual([response.status, body], [404, { error: "not_found" }], JSON.stringify(body));
  });
}

test("a file operation addressed to a workspace the token does not reach is refused, not served from its own", { skip }, async () => {
  const w = await world();
  const response = await post(w, "/@someone-else/files/trash", { path: "todo.md" });
  assert.notEqual(response.status, 200);
  assert.notEqual(liveAt(w, "todo.md"), null, "nothing moved");
});


// A folder page's notes through the gateway's front door, from the workspace object (`live/folderNotesRoute.js`).
//
// 2026-11-24 (owner, of the Areas page): "it takes like 3 seconds to load", then "we should just be able to talk
// directly to cloudflare". These cases send the request the app sends and check the answer is the folder's notes with
// their front matter, listed and parsed by the object, never naming a note the reader may not see, and that what the
// route does not serve is handed back to the control plane.
//
// Sabotage, confirmed (applied, run, named case failing, reverted):
//  1. `canSee` dropped from `handleFolderNotes` → "the gateway judges the reader itself…" fails.
//  2. The home check dropped (`objectReader` replaced by the bare client) → "a workspace whose notes are not in its
//     object yet…" and "an object behind on a change…" fail.
//  3. The sealed check dropped → "a password-encrypted note is left out…" fails.
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
import { workspaceFacts } from "../src/workspaceStore/facts.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { workspaceClient } from "../src/workspaceStore/api.js";
import { ACCESS_HOMES, objectToken } from "../src/workspaceStore/access.js";
import { sha256Hex } from "../src/controlPlane/index.js";
import { sealBinding } from "../src/workspaceStore/bindingSeal.js";
import { splitWorkspacePath } from "../src/workspacePath.js";
import { FOLDER_NOTES_PATH, handleFolderNotes } from "../src/live/folderNotesRoute.js";
import { PRE_PARSED_RULES, PrivacyOverrides } from "../src/privacy/engine.js";
import { renderEncryptedNote } from "../src/encryption/format.js";
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
        const bodies = texObjects(sql);
        const store = {
          sql,
          objects: bodies,
          facts: workspaceFacts(sql, bodies),
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
const RULES = {
  etag: "m.1",
  accessVersion: 1,
  folders: [{ prefix: "areas", visibility: "team" }],
  notes: [{ path: "areas/secret.md", visibility: "private" }],
};

function answerFor(workspaceId, notesHome) {
  return {
    binding: { workspaceId, provider: "r2", endpoint: "https://s3.example-folders.test", bucket: `bucket-${workspaceId}`, accessKeyId: `key-${workspaceId}`, secretAccessKey: `secret-${workspaceId}`, capabilities: { conditionalWrite: true, conditionalCreate: true }, notesHome, notesBackfilledAt: 1, status: "active" },
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

const id = (n) => `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** One person's own workspace on its object: their session, access, sealed binding and notes, all there. */
async function workspace(ns, env, { pwid, user, slug, notes, notesHome = "object" }) {
  const token = objectToken("access", pwid, "a".repeat(43));
  const access = workspaceClient(env, pwid).access;
  await access.pin(user);
  await access.reach.put([{ workspaceId: pwid, slug, kind: "personal", role: "owner", groups: [], at: 1 }]);
  await access.connections.put([
    { grantId: `g-${pwid}`, clientId: "context-console", clientName: "Context", workspaceId: pwid, scopes: ["context:read", "context:write", "context:private"], tokenHash: await sha256Hex(token), refreshHash: await sha256Hex(`${token}r`), expiresAt: Date.now() + 3_600_000, status: "active", at: 1 },
  ]);
  await access.setHome(ACCESS_HOMES.OBJECT);
  const client = workspaceClient(env, pwid);
  await client.setHome("object");
  await client.setEncryption("none");
  await client.rules.put(RULES, "member");
  const object = ns.get(ns.idFromName(`workspace:${pwid}`));
  object.store.rows.pinWorkspace(pwid);
  const rows = [{ id: `d-areas-${pwid}`, path: "areas", kind: "folder", at: 1 }];
  let n = 0;
  for (const [path, text] of Object.entries(notes)) {
    n += 1;
    const noteId = id(n + (slug === "alice" ? 0 : 100));
    rows.push({ id: `f-${pwid}-${n}`, path, kind: "file", at: n + 1, storageKey: `notes/${noteId}.md`, noteId, etag: `e-${pwid}-${n}` });
    await object.store.objects.put(`notes/${noteId}.md`, text);
  }
  object.store.rows.put(rows);
  object.store.rows.putRules(RULES);
  object.store.members.put("members", [{ userId: user, personalWorkspaceId: pwid, role: "owner", groups: [], at: 1 }]);
  object.store.members.setHome("object");
  object.store.rows.markBackfilled(1);
  object.store.binding.put({ sealed: await sealBinding(answerFor(pwid, notesHome), { secret: SECRET, workspaceId: pwid }), at: Date.now(), epoch: object.store.binding.get().epoch });
  return { token, object, pwid, user, slug };
}

const ALICE_NOTES = {
  "areas/health.md": "---\nstatus: active\nmetric: weight\n---\n# Health\n\nStay well.\n",
  "areas/money.md": "---\nstatus: active\n---\n# Money\n",
  "areas/secret.md": "---\nstatus: hidden\n---\n# Secret\n\nNot for members.\n",
  "areas/health/sleep.md": "# Sleep\n",
  "areas/metrics.csv.md": "# not a sheet\n",
  "todo.md": "# Todo\n",
};

async function world() {
  const ns = namespace();
  const env = { WORKSPACE_STORE: ns, GATEWAY_SECRET: SECRET, CONTROL_PLANE_URL: "https://control.invalid", CONTROL_PLANE_SECRET: "x".repeat(40) };
  const alice = await workspace(ns, env, { pwid: "pAlice", user: "uAlice", slug: "alice", notes: ALICE_NOTES });
  return { ns, env, alice };
}

const ask = async (w, who, body, prefix = `/@${who.slug}`) => {
  const response = await worker.fetch(
    new Request(`https://gateway.test${prefix}${FOLDER_NOTES_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${who.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    w.env,
    createWorkerCtx(),
  );
  return { status: response.status, body: await response.json() };
};

const paths = (answer) => answer.notes.map((note) => note.path).sort();

test("the route's address is never read as a workspace name", () => {
  assert.deepEqual(splitWorkspacePath(FOLDER_NOTES_PATH), { slug: null, path: FOLDER_NOTES_PATH });
});

test("a folder's notes come back with their front matter, listed and parsed by the object", { skip }, async () => {
  const w = await world();
  w.ns.ops.length = 0;
  const { status, body } = await ask(w, w.alice, { folder: "areas", subfolders: false });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.kind, "folderNotes");
  assert.equal(body.available, true);
  assert.deepEqual(paths(body), ["areas/health.md", "areas/metrics.csv.md", "areas/money.md", "areas/secret.md"]);
  const health = body.notes.find((note) => note.path === "areas/health.md");
  const props = JSON.parse(health.props);
  assert.equal(props.properties.status, "active");
  assert.equal(props.heading, "Health");
  assert.equal(props.lede, "Stay well.");
  assert.deepEqual([body.cursor, body.missing], [null, []]);
  assert.ok(w.ns.ops.includes("ws.rows.manifest"), w.ns.ops.join(", "));
  assert.ok(w.ns.ops.includes("ws.facts"), w.ns.ops.join(", "));

  const deep = await ask(w, w.alice, { folder: "areas", subfolders: true });
  assert.ok(paths(deep.body).includes("areas/health/sleep.md"), "subfolders reach beneath");
  const root = await ask(w, w.alice, { folder: "", subfolders: false });
  assert.deepEqual(paths(root.body), ["todo.md"]);
});

test("the bare address (no workspace in it) answers the same folder", { skip }, async () => {
  const w = await world();
  const { status, body } = await ask(w, w.alice, { folder: "areas" }, "");
  assert.equal(status, 200);
  assert.ok(paths(body).includes("areas/money.md"));
});

test("a member is never told of a private note: not as a row, not as missing", { skip }, async () => {
  const w = await world();
  w.alice.object.store.members.put("members", [{ userId: w.alice.user, personalWorkspaceId: w.alice.pwid, role: "member", groups: [], at: 1 }]);
  await workspaceClient(w.env, w.alice.pwid).access.reach.put([{ workspaceId: w.alice.pwid, slug: "alice", kind: "personal", role: "member", groups: [], at: 1 }]);
  const { status, body } = await ask(w, w.alice, { folder: "areas", subfolders: true });
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(!JSON.stringify(body).includes("secret"), JSON.stringify(body));
  assert.ok(paths(body).includes("areas/money.md"));
});

test("one person's token never lists another person's workspace", { skip }, async () => {
  const w = await world();
  const bob = await workspace(w.ns, w.env, { pwid: "pBob", user: "uBob", slug: "bob", notes: { "areas/bobs.md": "# Bob\n" } });
  for (const prefix of ["/@alice", ""]) {
    const { status, body } = await ask(w, bob, { folder: "areas", subfolders: true }, prefix);
    const text = JSON.stringify(body);
    for (const path of Object.keys(ALICE_NOTES)) assert.ok(!text.includes(path), `${prefix}: ${path} named to Bob: ${status} ${text}`);
  }
  const own = await ask(w, bob, { folder: "areas" });
  assert.deepEqual(paths(own.body), ["areas/bobs.md"]);
});

test("a password-encrypted note is left out, as the control plane leaves it out", { skip }, async () => {
  const w = await world();
  const sealed = renderEncryptedNote({ v: 1, kdf: { name: "x" }, iv: "i", ciphertext: "c" });
  await w.alice.object.store.objects.put(`notes/${id(2)}.md`, sealed);
  const { body } = await ask(w, w.alice, { folder: "areas" });
  assert.ok(!paths(body).includes("areas/money.md"), JSON.stringify(body));
  assert.ok(!body.missing.includes("areas/money.md"));
});

test("a request that is not one is refused before anything is asked", { skip }, async () => {
  const w = await world();
  for (const body of [{ folder: ".context" }, { folder: "areas", extra: 1 }, { folder: 3 }, { folder: "areas", subfolders: "yes" }, { folder: "areas", cursor: 5 }]) {
    const answer = await ask(w, w.alice, body);
    assert.equal(answer.status, 400, JSON.stringify(body));
  }
});

/** The handler alone, over a store whose object answers `entries` for the listing and props for any note asked. */
function handlerStore(entries, { home = "object", rules = [{ prefix: "areas", vis: "team" }] } = {}) {
  const asked = { manifest: 0, facts: [] };
  const client = {
    rows: {
      manifest: async () => {
        asked.manifest += 1;
        return { served: true, entries, cursor: null };
      },
    },
    facts: async ({ paths: named }) => {
      asked.facts.push(...named);
      return { served: true, props: named.map((path) => ({ path, version: "e", sealed: false, props: JSON.stringify({ properties: {}, heading: path }) })) };
    },
  };
  return {
    asked,
    store: {
      objectReading: { client, home, behind: false, scope: "team", names: [], workspaceId: "w1" },
      get: async (key) => (key === "privacy.md" ? { [PRE_PARSED_RULES]: { rules, overrides: new PrivacyOverrides() } } : null),
    },
  };
}

const request = (body) => new Request(`https://gateway.test${FOLDER_NOTES_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const TEAM = { scope: "team", scopes: ["context:read"], grantedGroups: new Set() };

test("the gateway judges the reader itself: a note its rules hold back is never answered, nor its facts asked", async () => {
  const { store, asked } = handlerStore([{ path: "areas/a.md" }, { path: "private/b.md" }, { path: "areas/.hidden/c.md" }]);
  const response = await handleFolderNotes(request({ folder: "", subfolders: true }), store, TEAM);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(paths(body), ["areas/a.md"]);
  assert.deepEqual(asked.facts, ["areas/a.md"], "facts were asked for a note this reader may not see");
});

test("a workspace whose notes are not in its object yet is handed to the control plane, its object never asked", async () => {
  for (const home of ["bucket", "dual", null]) {
    const { store, asked } = handlerStore([{ path: "areas/a.md" }], { home });
    const response = await handleFolderNotes(request({ folder: "areas" }), store, TEAM);
    assert.deepEqual([response.status, await response.json()], [409, { error: "not_object" }], String(home));
    assert.equal(asked.manifest, 0, String(home));
  }
});

test("an object behind on a change hands the page to the control plane", async () => {
  const { store } = handlerStore([]);
  store.objectReading.client.rows.manifest = async () => ({ behind: true });
  const response = await handleFolderNotes(request({ folder: "areas" }), store, TEAM);
  assert.equal(response.status, 409);
  const behind = handlerStore([]);
  behind.store.objectReading.behind = true;
  assert.equal((await handleFolderNotes(request({ folder: "areas" }), behind.store, TEAM)).status, 409);
});

test("a session without read access is refused before anything is asked", async () => {
  const { store, asked } = handlerStore([{ path: "areas/a.md" }]);
  const response = await handleFolderNotes(request({ folder: "areas" }), store, { scope: "team", scopes: [], grantedGroups: new Set() });
  assert.equal(response.status, 403);
  assert.equal(asked.manifest, 0);
});

test("a note the facts have not read is a gap the page admits to, never an empty note", async () => {
  const { store } = handlerStore([{ path: "areas/a.md" }, { path: "areas/b.md" }]);
  store.objectReading.client.facts = async () => ({ served: true, props: [{ path: "areas/a.md", version: "e", sealed: false, props: "{}" }] });
  const body = await (await handleFolderNotes(request({ folder: "areas" }), store, TEAM)).json();
  assert.deepEqual([paths(body), body.missing], [["areas/a.md"], ["areas/b.md"]]);
});

test("a long folder is answered a page at a time, the cursor the last note handed out", async () => {
  const entries = Array.from({ length: 2_005 }, (_, i) => ({ path: `areas/n${String(i).padStart(5, "0")}.md` }));
  const { store } = handlerStore(entries);
  const body = await (await handleFolderNotes(request({ folder: "areas" }), store, TEAM)).json();
  assert.equal(body.notes.length, 2_000);
  assert.equal(body.cursor, "areas/n01999.md");
});

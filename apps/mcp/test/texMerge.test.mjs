// A person's Tex moved into their workspace's object (texStore/merge.js, workspaceStore/texHost.js): copied, checked,
// switched, and the old store retired; a group chat's Tex store stays where it is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { durableSql, oneAtATime, arrivedSql } from "./texStoreFixture.mjs";

let sqliteMissing = false;
try {
  await import("node:sqlite");
} catch {
  sqliteMissing = true;
}
const skip = sqliteMissing ? "node:sqlite is not available" : false;

const { TexStore } = await import("../src/texStore.js");
const { WorkspaceStore } = await import("../src/workspaceStore.js");
const { gatewayTexStore, texStoreStub, texTimers } = await import("../src/texStore/wire.js");
const { placeOf } = await import("../src/texStore/move.js");
const { KEEP_MERGED_MS } = await import("../src/texStore/merge.js");
const { everyAlarm } = await import("../src/texStore/alarms.js");

const NOTE = "notes/0190a3b2-0000-7000-8000-000000000001.md";
const OTHER = "notes/0190a3b2-0000-7000-8000-000000000002.md";

function stateNamed(name) {
  const storage = {
    sql: durableSql(),
    alarm: null,
    setAlarm(at) {
      storage.alarm = at;
    },
    deleteAlarm() {
      storage.alarm = null;
    },
    async getAlarm() {
      return storage.alarm;
    },
    transactionSync: (work) => work(),
  };
  return { id: { name }, storage, blockConcurrencyWhile: oneAtATime(), acceptWebSocket() {}, getWebSockets: () => [], getTags: () => [] };
}

/** Both namespaces over one env, as the Worker binds them; `hook(name, op, response)` may change an object's answer to another object. */
function world() {
  const env = {};
  const tex = new Map();
  const workspaces = new Map();
  const calls = [];
  const api = { env, tex, workspaces, calls, hook: null };
  const namespace = (map, make) => ({
    idFromName: (name) => ({ name, toString: () => `id-${name}` }),
    get: (id) => ({
      fetch: async (request) => {
        let op = "?";
        try {
          op = JSON.parse(decodeURIComponent(request.headers.get("x-tex-call") ?? "null"))?.op ?? "?";
        } catch {
          op = "?";
        }
        calls.push({ name: id.name, op });
        if (!map.has(id.name)) map.set(id.name, make(id.name));
        const answer = await map.get(id.name).fetch(request);
        return typeof api.hook === "function" ? ((await api.hook(id.name, op, answer)) ?? answer) : answer;
      },
    }),
  });
  env.TEX_STORE = namespace(tex, (name) => {
    const store = new TexStore(stateNamed(name), env, { dispatch: async () => ({ next: null }) });
    // A placed store already copied in from any older one (`move.js`), as every test not about that move starts.
    if (name.startsWith("enam:")) {
      store.ready();
      arrivedSql(store.state.storage.sql);
    }
    return store;
  });
  env.WORKSPACE_STORE = namespace(workspaces, (name) => new WorkspaceStore(stateNamed(name), env));
  return api;
}

/** A person's Tex as it was before: two notes, the bookkeeping, a ledger opening with its backfilled entry, an alarm. */
async function seedPerson(w, workspaceId) {
  const name = `enam:person:${workspaceId}`;
  const store = new TexStore(stateNamed(name), w.env, { dispatch: async () => ({ next: null }) });
  store.ready();
  arrivedSql(store.state.storage.sql);
  w.tex.set(name, store);
  await store.objects.put(NOTE, "# About me\n\nlikes tea\n", { httpMetadata: { contentType: "text/markdown" } });
  await store.objects.put(OTHER, "# Routine\n", {});
  await store.objects.put("state/agent/history/texts.json", '{"turns":[]}', {});
  await store.objects.put("state/agent/history/desk.json", '{"keys":[]}', {});
  store.objects.ledger.prepend("texts", [{ id: "backfilledv1", kind: "note", at: 1000 }]);
  store.objects.ledger.append("texts", [
    { id: "t1", kind: "text", at: 2000, text: "hi" },
    { id: "r1", kind: "reply", at: 2100, text: "hello" },
  ]);
  store.timers.schedule({ id: "routines/morning.md", at: Date.now() + 3_600_000, payload: { path: "routines/morning.md" } });
  return store;
}

const decode = async (object) => (object === null ? null : await object.text());

test("a person's first Tex call copies their Tex into the workspace object, checks it, and answers from there", { skip }, async () => {
  const w = world();
  const old = await seedPerson(w, "w1");
  const store = gatewayTexStore(w.env)("person:w1");

  assert.equal(await decode(await store.get(NOTE)), "# About me\n\nlikes tea\n");
  assert.equal(await decode(await store.get("state/agent/history/desk.json")), '{"keys":[]}');

  const workspace = w.workspaces.get("workspace:w1");
  assert.ok(workspace, "the call reached the workspace object");
  const sql = workspace.state.storage.sql;
  // Tex's notes are in their own tables, never among the workspace's own notes.
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM tex_objects").toArray()[0].n, 4);
  const own = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'objects'").toArray();
  assert.equal(own.length === 0 ? 0 : sql.exec("SELECT COUNT(*) AS n FROM objects").toArray()[0].n, 0);

  // The ledger, every row as it was kept and in order: the backfilled entry is still first.
  const ledger = await store.ledger.read("texts");
  assert.deepEqual(
    ledger.entries.map((entry) => entry.id),
    ["backfilledv1", "t1", "r1"],
  );
  assert.equal((await store.ledger.oldest("texts")).id, "backfilledv1");
  assert.equal(ledger.manifest.count, 3);
  // The routine alarm, now armed on the workspace object.
  assert.deepEqual(
    everyAlarm(sql).map((alarm) => alarm.id),
    ["routines/morning.md"],
  );
  assert.equal(typeof workspace.state.storage.alarm, "number");

  // The old store has handed over, been told the copy is confirmed, and runs no routine of its own any more.
  const place = placeOf(old.state.storage.sql);
  assert.equal(place.mergedTo, "workspace:w1");
  assert.equal(typeof place.mergeDoneAt, "number");
  assert.equal(place.purgeAt, place.mergeDoneAt + KEEP_MERGED_MS);
  assert.equal(old.state.storage.alarm, place.purgeAt);
  // The copy is still there until its time comes.
  assert.notEqual(old.objects.head(NOTE), null);
});

test("after the switch, every Tex call for the person goes to the workspace object, and none to a Tex store", { skip }, async () => {
  const w = world();
  await seedPerson(w, "w1");
  const store = gatewayTexStore(w.env)("person:w1");
  await store.get(NOTE);
  w.calls.length = 0;
  await store.put(NOTE, "# About me\n\nlikes coffee\n");
  await store.ledger.append("texts", [{ id: "t2", kind: "text", at: 3000, text: "again" }]);
  await store.desk();
  assert.ok(w.calls.length >= 3);
  assert.ok(w.calls.every((call) => call.name === "workspace:w1"), JSON.stringify(w.calls));
  const workspace = w.workspaces.get("workspace:w1");
  workspace.tex().engine.ready();
  assert.equal(new TextDecoder().decode(workspace.tex().engine.objects.get(NOTE).body), "# About me\n\nlikes coffee\n");
});

test("a gateway still on the old code writes to the old store, which passes it on to the workspace object", { skip }, async () => {
  const w = world();
  const old = await seedPerson(w, "w1");
  await gatewayTexStore(w.env)("person:w1").get(NOTE);
  // The old route: straight to the placed Tex store, naming the person.
  const { R2Store } = await import("../src/store/r2.js");
  const { texBucket } = await import("../src/texStore/wire.js");
  const { objectByName } = await import("../src/objectPlace.js");
  const raw = objectByName(w.env.TEX_STORE, "enam:person:w1");
  const stale = new R2Store(texBucket({ fetch: (request) => (request.headers.set("x-tex-owner", "person:w1"), raw.fetch(request)) }));
  await stale.put(OTHER, "# Routine\n\nat 8\n");
  assert.equal(new TextDecoder().decode(old.objects.get(OTHER).body), "# Routine\n", "the old store kept no write");
  const workspace = w.workspaces.get("workspace:w1");
  workspace.tex().engine.ready();
  assert.equal(new TextDecoder().decode(workspace.tex().engine.objects.get(OTHER).body), "# Routine\n\nat 8\n");
  assert.equal(await decode(await stale.get(OTHER)), "# Routine\n\nat 8\n");
});

test("a copy that does not match is thrown away and the call fails, and the next call copies it again", { skip }, async () => {
  const w = world();
  await seedPerson(w, "w1");
  // The old store's ledger page loses its first row on the way.
  w.hook = async (name, op, answer) => {
    if (op !== "merge_ledger") return null;
    const page = await answer.json();
    return Response.json({ ...page, rows: page.rows.slice(1) });
  };
  const store = gatewayTexStore(w.env)("person:w1");
  await assert.rejects(store.get(NOTE));
  const sql = w.workspaces.get("workspace:w1").state.storage.sql;
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM tex_objects").toArray()[0].n, 0, "nothing of a failed copy is kept");
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM ledger").toArray()[0].n, 0);
  assert.equal(placeOf(w.tex.get("enam:person:w1").state.storage.sql).mergeDoneAt, undefined, "the old copy is never cleared before a confirmed copy");

  w.hook = null;
  assert.equal(await decode(await store.get(NOTE)), "# About me\n\nlikes tea\n");
  assert.deepEqual(
    (await store.ledger.read("texts")).entries.map((entry) => entry.id),
    ["backfilledv1", "t1", "r1"],
  );
});

test("a changed note body in the copy fails the check", { skip }, async () => {
  const w = world();
  await seedPerson(w, "w1");
  w.hook = async (name, op, answer) => {
    if (op !== "merge_out") return null;
    const manifest = await answer.json();
    manifest.objects[0].etag = "0".repeat(32);
    return Response.json(manifest);
  };
  await assert.rejects(gatewayTexStore(w.env)("person:w1").get(NOTE));
  const sql = w.workspaces.get("workspace:w1").state.storage.sql;
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM tex_objects").toArray()[0].n, 0);
});

test("the old store clears its copy three days after the copy is confirmed, and not before", { skip }, async () => {
  const w = world();
  const old = await seedPerson(w, "w1");
  await gatewayTexStore(w.env)("person:w1").get(NOTE);
  const place = placeOf(old.state.storage.sql);
  old.now = () => place.purgeAt - 1;
  await old.alarm();
  assert.notEqual(old.objects.head(NOTE), null);
  assert.equal(old.state.storage.alarm, place.purgeAt);
  old.now = () => place.purgeAt;
  await old.alarm();
  assert.equal(old.objects.head(NOTE), null);
  assert.equal(old.objects.ledger.chats().length, 0);
  assert.deepEqual(everyAlarm(old.state.storage.sql), []);
  // A late call is still passed on.
  const workspaceText = await decode(await gatewayTexStore(w.env)("person:w1").get(NOTE));
  assert.equal(workspaceText, "# About me\n\nlikes tea\n");
});

test("the workspace object answers only its own person's Tex", { skip }, async () => {
  const w = world();
  await seedPerson(w, "w1");
  await gatewayTexStore(w.env)("person:w1").get(NOTE);
  const { objectByName } = await import("../src/objectPlace.js");
  const stub = objectByName(w.env.WORKSPACE_STORE, "workspace:w1");
  const ask = async (owner, op = "get") =>
    await stub.fetch(new Request("https://tex-store.internal/x", { method: "POST", headers: { "x-tex-owner": owner, "x-tex-call": encodeURIComponent(JSON.stringify({ op, key: NOTE })) } }));
  assert.equal((await ask("person:w2")).status, 400, "another person's");
  assert.equal((await ask("chat:abc")).status, 400, "a group chat's");
  assert.equal((await ask("person:w1", "merge_out")).status, 400, "a merge call");
  assert.equal((await ask("person:w1", "move_out")).status, 400, "a move call");
  assert.equal((await ask("person:w1")).status, 200);
});

test("wiping the person's Tex clears it in the workspace object and the old store at once", { skip }, async () => {
  const w = world();
  const old = await seedPerson(w, "w1");
  const store = gatewayTexStore(w.env)("person:w1");
  await store.get(NOTE);
  const { callTexStore } = await import("../src/texStore/wire.js");
  await callTexStore(texStoreStub(w.env, { person: "w1" }), "wipe");
  const sql = w.workspaces.get("workspace:w1").state.storage.sql;
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM tex_objects").toArray()[0].n, 0);
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM ledger").toArray()[0].n, 0);
  assert.deepEqual(everyAlarm(sql), []);
  assert.equal(old.objects.head(NOTE), null);
  assert.equal(old.objects.ledger.chats().length, 0);
  assert.equal(await store.get(NOTE), null);
});

test("a person who never had a Tex store starts with an empty one in the workspace object", { skip }, async () => {
  const w = world();
  const store = gatewayTexStore(w.env)("person:w9");
  assert.equal(await store.get(NOTE), null);
  await store.put(NOTE, "# New\n");
  assert.equal(await decode(await store.get(NOTE)), "# New\n");
  assert.ok(w.workspaces.has("workspace:w9"));
});

test("routine alarms run from the workspace object, and an owed member write keeps its retry", { skip }, async () => {
  const w = world();
  await seedPerson(w, "w1");
  const stub = texStoreStub(w.env, { person: "w1" });
  await texTimers(stub).schedule({ id: "routines/now.md", at: Date.now() - 1, payload: {} });
  const workspace = w.workspaces.get("workspace:w1");
  const ran = [];
  workspace.tex().engine.dispatch = async (routine) => (ran.push(routine.id), { next: null });
  await workspace.alarm();
  assert.deepEqual(ran, ["routines/now.md"]);
  // The morning routine is still due later, and the alarm is armed for it.
  const left = everyAlarm(workspace.state.storage.sql).map((alarm) => alarm.id);
  assert.deepEqual(left, ["routines/morning.md"]);
  assert.equal(workspace.state.storage.alarm, everyAlarm(workspace.state.storage.sql)[0].at);
  // A member write still owed arms the retry sooner than the routine.
  workspace.ready().members.pending = () => [{ seq: 1 }];
  workspace.tex().arm();
  assert.ok(workspace.state.storage.alarm < Date.now() + 60_000);
});

test("a group chat's Tex stays in its own Tex store", { skip }, async () => {
  const w = world();
  const chat = gatewayTexStore(w.env)("chat:g1");
  await chat.put(NOTE, "# Group\n");
  assert.ok(w.tex.has("enam:chat:g1"));
  assert.ok(!w.calls.some((call) => call.name.startsWith("workspace:")));
});

// The object's dispatch for `ws.write.*` calls (`src/workspaceStore/serveWrites.js`, through `serve.js`): an op and the
// change it makes land in one transaction or not at all, a refused or failed op queues nothing, and an unknown op is 400.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { mirrorOutbox } from "../src/workspaceStore/mirrorOutbox.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { serveWrites } from "../src/workspaceStore/serveWrites.js";
import { durableSqlite } from "./durableSqlite.mjs";

/**
 * One object's store as `ready()` builds it, over real SQLite. `originate` is the parallel rows work's, faked here:
 * it answers the row's clock as `now`, or throws when `fail` is set.
 */
function objectStore({ fail = false } = {}) {
  const { sql, transact } = durableSqlite();
  const real = workspaceRows(sql);
  const originated = [];
  const rows = {
    ...real,
    originate(args, now) {
      originated.push(args);
      if (fail) throw new Error("boom");
      return { id: args.id, at: now };
    },
  };
  const mirror = mirrorOutbox(sql);
  const enqueued = [];
  const enqueue = mirror.enqueue;
  mirror.enqueue = (...args) => {
    enqueued.push({ inTransaction: transactionDepth > 0 });
    return enqueue(...args);
  };
  let transactionDepth = 0;
  let soon = 0;
  const store = {
    sql,
    rows,
    objects: texObjects(sql),
    members: workspaceMembers(sql),
    mirror,
    transact: (work) => {
      transactionDepth += 1;
      try {
        return transact(work);
      } finally {
        transactionDepth -= 1;
      }
    },
    flushMirror: async () => ({ done: true }),
    mirrorSoon: () => {
      soon += 1;
    },
  };
  real.put([{ id: "row-1", path: "1-projects/plan.md", kind: "file", at: 1, storageKey: "files/n1.md" }]);
  return { store, mirror, originated, enqueued, soon: () => soon };
}

function call(store, op, fields) {
  const request = new Request(`https://object.test/${op}`, {
    method: "POST",
    headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) },
    body: JSON.stringify(fields),
  });
  return serveWorkspaceStore(store, request);
}

const WRITE = { workspaceId: "ws_one", path: "1-projects/plan.md", key: "files/n1.md", etag: "e-2", size: 12, keyed: false };

test("a wrote call answers ok and queues exactly one mirror change, inside the transaction that wrote the row", async () => {
  const { store, mirror, originated, enqueued, soon } = objectStore();
  const response = await call(store, "ws.write.wrote", WRITE);
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.equal(answer.ok, true);
  assert.equal(originated.length, 1);
  assert.equal(mirror.count(), 1);
  // The clock the row was written at is the one the answer and the mirror both carry.
  assert.deepEqual(mirror.pending(), [
    {
      seq: 1,
      workspaceId: "ws_one",
      change: {
        op: "wrote",
        record: { path: "1-projects/plan.md", key: "files/n1.md", etag: "e-2", size: 12, keyed: false },
        objectAt: answer.at,
      },
    },
  ]);
  assert.deepEqual(enqueued, [{ inTransaction: true }]);
  assert.equal(soon(), 1, "a flush is scheduled, not awaited");
});

test("an op that throws inside the transaction queues nothing, and the call fails", async () => {
  const { store, mirror, soon } = objectStore({ fail: true });
  await assert.rejects(call(store, "ws.write.wrote", WRITE), /boom/);
  assert.equal(mirror.count(), 0);
  assert.equal(soon(), 0);
});

test("a NOT_FOUND write answers 200 with the miss, and queues nothing", async () => {
  const { store, mirror, soon } = objectStore();
  const response = await call(store, "ws.write.wrote", { ...WRITE, path: "1-projects/missing.md" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: false, code: "NOT_FOUND" });
  assert.equal(mirror.count(), 0);
  assert.equal(soon(), 0);
});

test("a refused write answers 422 and queues nothing", async () => {
  const { store, mirror } = objectStore();
  const response = await call(store, "ws.write.wrote", { ...WRITE, etag: "" });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, "refused");
  assert.equal(mirror.count(), 0);
});

test("an unknown ws.write op is 400, and writes nothing", async () => {
  const { store, mirror, originated } = objectStore();
  const response = await call(store, "ws.write.moved", WRITE);
  assert.equal(response.status, 400);
  assert.equal(mirror.count(), 0);
  assert.deepEqual(originated, []);
});

// End to end over the real rows store: a folder row is live and the member rules hold the folder `team`, so a `team`
// create is adopted. The row lands at the minted id, and one adopt change is queued in the same transaction.
// Sabotage: drop `adopt` from WRITE_OPS and the call is 400 with nothing queued.
test("ws.write.adopt through serveWrites makes the row and queues one adopt change for the mirror", async () => {
  const { store, mirror, enqueued, soon } = objectStore();
  store.rows.put([{ id: "f-plans", path: "plans", kind: "folder", at: 1 }]);
  store.rows.putRules({ folders: [{ prefix: "plans", visibility: "team" }], notes: [], accessVersion: 4 });
  const NOTE = "01890a5d-ac96-7c4e-8f3a-1b2c3d4e5f60";
  const mintId = () => "o_" + "a".repeat(32);
  const body = { workspaceId: "ws_one", path: "plans/a.md", noteId: NOTE, key: `notes/${NOTE}.md`, etag: "e-1", size: 7, at: 500, tier: "team" };

  const response = await serveWrites(store, "ws.write.adopt", body, 5_000, mintId);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, adopted: true, at: 5_000 });

  const row = store.rows.byNoteId(NOTE);
  assert.deepEqual(
    { id: row.id, path: row.path, kind: row.kind, noteId: row.noteId, storageKey: row.storageKey, etag: row.etag, size: row.size, at: row.at },
    { id: mintId(), path: "plans/a.md", kind: "file", noteId: NOTE, storageKey: `notes/${NOTE}.md`, etag: "e-1", size: 7, at: 5_000 },
  );

  assert.deepEqual(mirror.pending(), [
    {
      seq: 1,
      workspaceId: "ws_one",
      change: {
        op: "adopt",
        record: { path: "plans/a.md", noteId: NOTE, key: `notes/${NOTE}.md`, etag: "e-1", size: 7, at: 500, objectId: mintId() },
        objectAt: 5_000,
      },
    },
  ]);
  assert.deepEqual(enqueued, [{ inTransaction: true }]);
  assert.equal(soon(), 1, "a flush is scheduled, not awaited");
});

// A new note in folders that do not exist yet: the object stands them up in the same transaction and queues them as one
// tree change ahead of the adoption, so Convex holds the folders (by the object's ids) before the note beneath them.
// Sabotage: return DEFER for a missing parent again and the row is not made.
test("ws.write.adopt stands up missing folders and queues them as a tree change before the adoption", async () => {
  const { store, mirror } = objectStore();
  store.rows.putRules({ folders: [], notes: [], accessVersion: 4 });
  const NOTE = "01890a5d-ac96-7c4e-8f3a-1b2c3d4e5f61";
  let minted = 0;
  const mintId = () => `o_${String(++minted).padStart(32, "0")}`;
  const body = { workspaceId: "ws_one", path: "ideas/2026/a.md", noteId: NOTE, key: `notes/${NOTE}.md`, etag: "e-1", at: 500, tier: "team" };

  const response = await serveWrites(store, "ws.write.adopt", body, 5_000, mintId);
  assert.deepEqual(await response.json(), { ok: true, adopted: true, at: 5_000 });
  assert.equal(store.rows.byPath("ideas")?.kind, "folder");
  assert.equal(store.rows.byPath("ideas/2026")?.kind, "folder");
  assert.equal(store.rows.byNoteId(NOTE)?.path, "ideas/2026/a.md");

  const changes = mirror.pending().map((entry) => entry.change);
  assert.deepEqual(changes.map((change) => change.op), ["tree", "adopt"]);
  assert.deepEqual(changes[0].record.folders.map((made) => made.path), ["ideas", "ideas/2026"]);
  assert.deepEqual(changes[0].record.moves, []);
  assert.equal(changes[0].record.trash, false);
  assert.equal(changes[1].record.objectId, store.rows.byNoteId(NOTE).id);
});

test("ws.write.adopt leaves a note under a built-in folder's name that no root folder has to the control plane", async () => {
  const { store, mirror } = objectStore();
  store.rows.putRules({ folders: [], notes: [], accessVersion: 4 });
  const NOTE = "01890a5d-ac96-7c4e-8f3a-1b2c3d4e5f62";
  const body = { workspaceId: "ws_one", path: "inbox/a.md", noteId: NOTE, key: `notes/${NOTE}.md`, etag: "e-1", at: 500, tier: "team" };
  const response = await serveWrites(store, "ws.write.adopt", body, 5_000, () => `o_${"c".repeat(32)}`);
  assert.deepEqual(await response.json(), { ok: false, code: "DEFER", reason: "job_folder" });
  assert.equal(store.rows.byPath("inbox"), null);
  assert.equal(mirror.count(), 0);
});

test("a workspace id that is missing or not a plain id is 400, and nothing is written", async () => {
  for (const workspaceId of [undefined, "", "has space", "a/b", "x".repeat(65), 7]) {
    const { store, mirror, originated } = objectStore();
    const response = await call(store, "ws.write.wrote", { ...WRITE, workspaceId });
    assert.equal(response.status, 400, JSON.stringify(workspaceId));
    assert.equal(mirror.count(), 0);
    assert.deepEqual(originated, []);
  }
});

// A group chat's own new note in its own home (2026-11-20): the gateway put it in that chat's Tex object, so its key is
// `tex/chat:<key>/notes/<id>.md`. The object adopts that key only in the pin, only for the chat the gateway named, and only
// where `chatHomeOwner` places the path there; any other Tex key is left to the control plane (DEFER "key").
// Sabotage: accept any `tex/` key in `adopt` and the "another chat's key" assertion is adopted instead of deferred.
test("ws.write.adopt takes a chat's own Tex key in its own home in the pin, and defers any other Tex key", async () => {
  const CHAT = "c".repeat(64);
  const OTHER = "d".repeat(64);
  const HOME = "tex/groups/kite-willow-rocket";
  const setup = (sealsChats) => {
    const { store } = objectStore();
    store.access = { sealsChats: () => sealsChats };
    store.rows.put([
      { id: "f-tex", path: "tex", kind: "folder", at: 1 },
      { id: "f-groups", path: "tex/groups", kind: "folder", at: 1 },
      { id: "f-home", path: HOME, kind: "folder", at: 1 },
    ]);
    store.rows.putRules({ folders: [{ prefix: HOME, visibility: "team" }], notes: [], accessVersion: 4 });
    return store;
  };
  let n = 0;
  const adoptOne = async (store, key, chat, note) => {
    const body = { workspaceId: "ws_pin", path: `${HOME}/save-check.md`, noteId: note, key, etag: "e-1", size: 3, at: 500, tier: "team", chatHome: { folder: HOME, chat } };
    const response = await serveWrites(store, "ws.write.adopt", body, 5_000, () => `o_${String(++n).padStart(32, "0")}`);
    return await response.json();
  };
  const NOTE = "01890a5d-ac96-7c4e-8f3a-1b2c3d4e5f70";

  const pin = setup(true);
  assert.deepEqual(await adoptOne(pin, `tex/chat:${CHAT}/notes/${NOTE}.md`, CHAT, NOTE), { ok: true, adopted: true, at: 5_000 });
  assert.equal(pin.rows.byNoteId(NOTE).storageKey, `tex/chat:${CHAT}/notes/${NOTE}.md`);

  const NOTE2 = "01890a5d-ac96-7c4e-8f3a-1b2c3d4e5f71";
  const other = await adoptOne(setup(true), `tex/chat:${OTHER}/notes/${NOTE2}.md`, CHAT, NOTE2);
  assert.deepEqual(other, { ok: false, code: "DEFER", reason: "key" }, "another chat's key");

  const notPin = await adoptOne(setup(false), `tex/chat:${CHAT}/notes/${NOTE2}.md`, CHAT, NOTE2);
  assert.deepEqual(notPin, { ok: false, code: "DEFER", reason: "key" }, "not the pin");
});

// A member's new note in a Tex home (2026-11-20): in a personal workspace's Tex folder under the person's key, and in a
// pin home under the key the access set's `chatHomes` names. Anything else stays the control plane's.
// Sabotage: drop `workspaceKind` from the adopt and the personal one defers ("key").
test("ws.write.adopt takes a member's Tex key in a personal Tex folder and in a pin home the set names", async () => {
  let n = 0;
  const mint = () => `o_${String(++n).padStart(32, "0")}`;
  const NOTE = "01890a5d-ac96-7c4e-8f3a-1b2c3d4e5f80";

  const { store: personal } = objectStore();
  personal.access = { sealsChats: () => false, chatHomes: () => null };
  personal.rows.put([{ id: "f-tex", path: "tex", kind: "folder", at: 1 }]);
  personal.rows.putRules({ folders: [], notes: [], accessVersion: 4 });
  const body = { workspaceId: "ws_me", workspaceKind: "personal", path: "tex/a.md", noteId: NOTE, key: `tex/person:ws_me/notes/${NOTE}.md`, etag: "e-1", size: 3, at: 500, tier: "private" };
  const mine = await (await serveWrites(personal, "ws.write.adopt", body, 5_000, mint)).json();
  assert.deepEqual(mine, { ok: true, adopted: true, at: 5_000 });
  assert.equal(personal.rows.byNoteId(NOTE).storageKey, `tex/person:ws_me/notes/${NOTE}.md`);
  const someoneElse = await (await serveWrites(personal, "ws.write.adopt", { ...body, noteId: NOTE.replace(/0$/, "1"), key: `tex/person:ws_other/notes/${NOTE.replace(/0$/, "1")}.md`, tier: "team" }, 5_000, mint)).json();
  assert.deepEqual(someoneElse, { ok: false, code: "DEFER", reason: "key" });

  const KEY = "e".repeat(64);
  const HOME = "tex/groups/kite-willow-rocket";
  const { store: pin } = objectStore();
  pin.access = { sealsChats: () => true, chatHomes: () => ({ "kite-willow-rocket": KEY }) };
  pin.rows.put([
    { id: "f-tex", path: "tex", kind: "folder", at: 1 },
    { id: "f-groups", path: "tex/groups", kind: "folder", at: 1 },
    { id: "f-home", path: HOME, kind: "folder", at: 1 },
  ]);
  pin.rows.putRules({ folders: [{ prefix: HOME, visibility: "private" }], notes: [], accessVersion: 4 });
  const NOTE3 = "01890a5d-ac96-7c4e-8f3a-1b2c3d4e5f82";
  const member = await (await serveWrites(pin, "ws.write.adopt", { workspaceId: "ws_pin", path: `${HOME}/b.md`, noteId: NOTE3, key: `tex/chat:${KEY}/notes/${NOTE3}.md`, etag: "e-1", at: 500, tier: "private" }, 5_000, mint)).json();
  assert.deepEqual(member, { ok: true, adopted: true, at: 5_000 });
});

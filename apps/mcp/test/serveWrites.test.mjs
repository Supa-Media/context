// The object's dispatch for `ws.write.*` calls (`src/workspaceStore/serveWrites.js`, through `serve.js`): an op and the
// change it makes land in one transaction or not at all, a refused or failed op queues nothing, and an unknown op is 400.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { mirrorOutbox } from "../src/workspaceStore/mirrorOutbox.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
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

test("a workspace id that is missing or not a plain id is 400, and nothing is written", async () => {
  for (const workspaceId of [undefined, "", "has space", "a/b", "x".repeat(65), 7]) {
    const { store, mirror, originated } = objectStore();
    const response = await call(store, "ws.write.wrote", { ...WRITE, workspaceId });
    assert.equal(response.status, 400, JSON.stringify(workspaceId));
    assert.equal(mirror.count(), 0);
    assert.deepEqual(originated, []);
  }
});

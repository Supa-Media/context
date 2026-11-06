// "A change is coming" marks in a workspace's object (src/workspaceStore/marks.js): a writer that may narrow opens one
// before it commits in the control plane, and the push that carries its change closes it with its rows. While one is
// open, a reader's lookup waits for that push, and says `behind` if it never comes, so the gateway asks the control
// plane rather than serve a share somebody just took back.
//
// Sabotage, each confirmed to fail a case here: answer a lookup without waiting for marks (the revoked note is served
// from the old rows), close a push's marks before its rows land (a reader between the two sees the old rows with no
// mark), never expire a mark (a writer that died leaves its workspace behind for good), and drop the gateway's
// reading of the object's own `behind` (the hooks keep the object's stale answer).
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMarks, waitForMarks, MAX_MARK_MS } from "../src/workspaceStore/marks.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { objectFirstHooks, WorkspaceBusy } from "../src/store/objectLookup.js";

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

const NOTE = "0199a000-0000-7000-8000-00000000000a";
const rules = (accessVersion, notes = []) => ({ etag: `m.${accessVersion}`, accessVersion, folders: [{ prefix: "plans", visibility: "team" }], notes });

function objectWith(clock = { now: 1_000 }) {
  const sql = durableSql();
  const store = { objects: texObjects(sql), rows: workspaceRows(sql), marks: workspaceMarks(sql, { now: () => clock.now }) };
  const call = async (op, fields = {}) => {
    const response = await serveWorkspaceStore(store, new Request("https://ws/call", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body: JSON.stringify({ ...fields, workspaceId: "w1" }) }));
    return { status: response.status, body: await response.json() };
  };
  return { store, call, clock };
}

async function seeded() {
  const object = objectWith();
  await object.call("ws.apply", { rows: [{ id: "n1", noteId: NOTE, path: "plans/shared.md", kind: "file", storageKey: `notes/${NOTE}.md`, at: 10 }], at: 10, rules: { member: rules(1) } });
  return object;
}

const lookup = (object) => object.call("ws.rows.lookup", { paths: ["plans/shared.md"], scope: "team", groups: [] });

test("a lookup while a change is coming waits for the push that carries it, and answers by the new rows", { skip }, async () => {
  const object = await seeded();
  assert.equal((await lookup(object)).body.rows[0].found, true);
  await object.call("ws.mark.open", { token: "mark-aaaaaaaa" });
  // The writer commits in the control plane; its push lands while the reader waits.
  const reading = lookup(object);
  await object.call("ws.apply", { rows: [], removed: [], at: 20, rules: { member: rules(2, [{ path: "plans/shared.md", visibility: "private" }]) }, close: ["mark-aaaaaaaa"] });
  const answer = (await reading).body;
  assert.equal(answer.rows[0].found, false, "the note taken back is not served");
  assert.equal(answer.behind, undefined);
  assert.equal((await object.call("ws.state")).body.marks, 0);
});

test("a lookup whose push never comes says behind, and the gateway says busy without asking the control plane", { skip }, async () => {
  const object = await seeded();
  await object.call("ws.mark.open", { token: "mark-bbbbbbbb" });
  const behind = await waitForMarks(object.store.marks, { waitMs: 40, sleep: async () => {} });
  assert.equal(behind, true);

  const asked = [];
  const hooks = objectFirstHooks(
    { lookup: async (paths) => (asked.push(paths), { keyed: true, notes: { [paths[0]]: { state: "gone" } }, texHomes: {} }) },
    {
      client: { rows: { lookup: async () => ({ rows: [{ found: true, path: "plans/shared.md", noteId: NOTE, key: `notes/${NOTE}.md`, etag: "e", kind: "file" }], behind: true }) } },
      home: "object",
      scope: "team",
      names: [],
      workspaceId: "w1",
    },
  );
  await assert.rejects(hooks.lookup(["plans/shared.md"]), WorkspaceBusy);
  assert.deepEqual(asked, [], "never the control plane instead (the owner, 2026-11-06)");
});

test("a push closes its marks in the same transaction as its rows", { skip }, async () => {
  const object = await seeded();
  await object.call("ws.mark.open", { token: "mark-cccccccc" });
  let seenMarksDuringRows = null;
  const putRules = object.store.rows.putRules.bind(object.store.rows);
  object.store.rows.putRules = (held, audience) => {
    seenMarksDuringRows = object.store.marks.count();
    return putRules(held, audience);
  };
  const answer = await object.call("ws.apply", { rows: [], removed: [], at: 20, rules: { member: rules(2) }, close: ["mark-cccccccc"] });
  assert.equal(answer.body.closed, 1);
  assert.equal(seenMarksDuringRows, 1, "the mark was still open while the rules landed");
  assert.equal(object.store.marks.count(), 0);
});

test("a mark expires, so a writer that died never leaves its workspace behind for good", { skip }, async () => {
  const object = await seeded();
  await object.call("ws.mark.open", { token: "mark-dddddddd", ttlMs: 10 * MAX_MARK_MS });
  assert.equal(object.store.marks.count(), 1);
  object.clock.now += MAX_MARK_MS - 1;
  assert.equal(object.store.marks.count(), 1, "capped at the longest a mark is kept, not shorter");
  object.clock.now += 2;
  assert.equal(object.store.marks.count(), 0);
});

test("marks are refused when malformed, and a close of one not held closes nothing", { skip }, async () => {
  const object = await seeded();
  assert.equal((await object.call("ws.mark.open", { token: "x" })).status, 422);
  assert.equal((await object.call("ws.mark.close", { tokens: ["../../etc"] })).status, 422);
  assert.equal((await object.call("ws.apply", { rows: [], removed: [], at: 20, close: "mark-eeeeeeee" })).status, 422);
  assert.deepEqual((await object.call("ws.mark.close", { tokens: ["mark-ffffffff"] })).body, { closed: 0 });
});

test("without a mark a lookup answers at once, with no behind", { skip }, async () => {
  const object = await seeded();
  const answer = (await lookup(object)).body;
  assert.equal(answer.behind, undefined);
  assert.equal(answer.rows[0].found, true);
});

test("a folder listing while a change is coming says behind once its wait runs out", { skip }, async () => {
  const object = await seeded();
  await object.call("ws.mark.open", { token: "mark-gggggggg" });
  const answer = (await object.call("ws.rows.manifest", { folder: "plans", scope: "team", groups: [] })).body;
  assert.equal(answer.behind, true);
  await object.call("ws.mark.close", { tokens: ["mark-gggggggg"] });
  assert.equal((await object.call("ws.rows.manifest", { folder: "plans", scope: "team", groups: [] })).body.behind, undefined);
});

// `ws.open` (the call a request's store is opened from, `bindingRows.js`) answers the object's own word on whether a
// change is coming, so the gateway need not ask the control plane before a read (`store/objectBinding.js`).
// Sabotage: answer `ws.open` without waiting for marks, or drop its `behind`, and both cases here fail.
test("ws.open waits for a coming change and says behind only while it is still out", { skip }, async () => {
  const object = await seeded();
  assert.equal((await object.call("ws.open", { userId: "u1" })).body.behind, false, "no mark open: not behind");

  await object.call("ws.mark.open", { token: "mark-eeeeeeee" });
  const opening = object.call("ws.open", { userId: "u1" });
  await object.call("ws.apply", { rows: [], removed: [], at: 20, rules: { member: rules(2) }, close: ["mark-eeeeeeee"] });
  assert.equal((await opening).body.behind, false, "the push landed within the wait");

  await object.call("ws.mark.open", { token: "mark-ffffffff" });
  assert.equal((await object.call("ws.open", { userId: "u1" })).body.behind, true, "a push that never comes reads as behind");
});

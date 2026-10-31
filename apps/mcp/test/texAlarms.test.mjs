// Tex's routine alarms in a Durable Object (src/texStore/alarms.js, src/texStore.js):
// the table over the object's SQLite, the alarm that hands each due routine on,
// and the same fetch wire the notes use.
import { test } from "node:test";
import assert from "node:assert/strict";

import { schedule, cancel, settle, retry, due, nextAt, MAX_DUE, MAX_PAYLOAD_BYTES } from "../src/texStore/alarms.js";
import { texObjects, TexObjectRefused } from "../src/texStore/objects.js";
import { serveTexStore, texTimers } from "../src/texStore/wire.js";
import { TexStore, RETRY_MS } from "../src/texStore.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

/** `node:sqlite` in the Durable Object's `sql.exec(...).toArray()` shape. */
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

const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

/** A Durable Object's state: its SQLite and the one alarm the runtime keeps. */
function stateOver(sql = durableSql()) {
  const storage = {
    sql,
    alarm: undefined,
    armed: [],
    setAlarm(at) {
      storage.alarm = at;
      storage.armed.push(at);
    },
    deleteAlarm() {
      storage.alarm = null;
      storage.armed.push(null);
    },
  };
  return { storage };
}

/** A clock the test moves by hand. */
function clockAt(start) {
  const clock = { t: start, now: () => clock.t };
  return clock;
}

/** The Durable Object's fetch, as the gateway's client reaches it. */
function reach(store) {
  return { fetch: (request) => store.fetch(request) };
}

/**
 * A dispatcher that records each routine it ran, and answers when it runs next
 * (`null`: never again from here). The ids in `refuse` throw until the set is cleared.
 */
function dispatcher(refuse = new Set()) {
  const ran = [];
  const dispatch = async (routine) => {
    if (refuse.has(routine.id)) throw new Error("the place is down");
    ran.push(routine.id);
    return { next: null };
  };
  return { ran, dispatch };
}

const T = 1_750_000_000_000;

test("the earliest scheduled time is the next one, and none scheduled means none", { skip }, () => {
  const sql = durableSql();
  assert.equal(nextAt(sql), null);
  schedule(sql, { id: "routine:b", at: T + 2000, payload: { path: "tex/routines/daily/b.md" } });
  schedule(sql, { id: "routine:a", at: T + 1000, payload: null });
  assert.equal(nextAt(sql), T + 1000);
});

test("scheduling an id again moves it and replaces its payload", { skip }, () => {
  const sql = durableSql();
  schedule(sql, { id: "routine:a", at: T + 1000, payload: { version: 1 } });
  schedule(sql, { id: "routine:a", at: T + 5000, payload: { version: 2 } });
  assert.equal(nextAt(sql), T + 5000);
  assert.deepEqual(due(sql, T + 1000), []);
  assert.deepEqual(due(sql, T + 5000), [{ id: "routine:a", at: T + 5000, payload: { version: 2 } }]);
});

test("due returns what is due by now, earliest first, with its payload as it was given", { skip }, () => {
  const sql = durableSql();
  schedule(sql, { id: "c", at: T + 3000, payload: "later" });
  schedule(sql, { id: "b", at: T + 1000, payload: { n: [1, "two"] } });
  schedule(sql, { id: "a", at: T + 1000, payload: null });
  assert.deepEqual(due(sql, T + 1000), [
    { id: "a", at: T + 1000, payload: null },
    { id: "b", at: T + 1000, payload: { n: [1, "two"] } },
  ]);
  assert.deepEqual(due(sql, T + 2999).map((alarm) => alarm.id), ["a", "b"]);
  assert.deepEqual(due(sql, T + 3000).map((alarm) => alarm.id), ["a", "b", "c"]);
});

test("one due list is capped, so one alarm never hands over an unbounded batch", { skip }, () => {
  const sql = durableSql();
  for (let index = 0; index < MAX_DUE + 10; index += 1) schedule(sql, { id: `r${index}`, at: T, payload: null });
  assert.equal(due(sql, T).length, MAX_DUE);
  assert.equal(nextAt(sql), T);
});

test("cancel removes one alarm, and cancelling an unknown id is no error", { skip }, () => {
  const sql = durableSql();
  schedule(sql, { id: "a", at: T, payload: null });
  schedule(sql, { id: "b", at: T + 1, payload: null });
  cancel(sql, "a");
  cancel(sql, "never-scheduled");
  assert.equal(nextAt(sql), T + 1);
  cancel(sql, "b");
  assert.equal(nextAt(sql), null);
});

test("settle removes an alarm only while it still has the time it was handed out at", { skip }, () => {
  const sql = durableSql();
  schedule(sql, { id: "a", at: T, payload: null });
  settle(sql, "a", T + 1);
  assert.equal(nextAt(sql), T);
  settle(sql, "a", T);
  assert.equal(nextAt(sql), null);
});

test("retry moves a due alarm later only while it still has the time it was handed out at", { skip }, () => {
  const sql = durableSql();
  schedule(sql, { id: "a", at: T, payload: null });
  retry(sql, { id: "a", at: T }, T + RETRY_MS);
  assert.equal(nextAt(sql), T + RETRY_MS);
  // Someone rescheduled it in the meantime: that newer time stands.
  schedule(sql, { id: "a", at: T + 9000, payload: null });
  retry(sql, { id: "a", at: T }, T + RETRY_MS);
  assert.equal(nextAt(sql), T + 9000);
});

test("an alarm refuses what the object cannot keep, and keeps nothing", { skip }, () => {
  const sql = durableSql();
  const refused = [
    { id: "", at: T, payload: null },
    { id: 7, at: T, payload: null },
    { id: "x".repeat(257), at: T, payload: null },
    { id: "a\0b", at: T, payload: null },
    { id: "a", at: Number.NaN, payload: null },
    { id: "a", at: 1.5, payload: null },
    { id: "a", at: -1, payload: null },
    { id: "a", at: "soon", payload: null },
    { id: "a", at: T, payload: () => 1 },
    { id: "a", at: T, payload: 1n },
    { id: "a", at: T, payload: "x".repeat(MAX_PAYLOAD_BYTES) },
  ];
  for (const alarm of refused) assert.throws(() => schedule(sql, alarm), TexObjectRefused, JSON.stringify(alarm.id));
  assert.equal(nextAt(sql), null);
});

test("the object's alarm hands each due routine on once, and one that fails waits and is tried again", { skip }, async () => {
  const clock = clockAt(T);
  const state = stateOver();
  const refuse = new Set(["routine:bad"]);
  const { ran, dispatch } = dispatcher(refuse);
  const store = new TexStore(state, {}, { dispatch, now: clock.now });
  const timers = texTimers(reach(store));
  await timers.schedule({ id: "routine:a", at: T, payload: { path: "tex/routines/once/a.md" } });
  await timers.schedule({ id: "routine:bad", at: T, payload: { path: "tex/routines/once/bad.md" } });
  await timers.schedule({ id: "routine:later", at: T + 3_600_000, payload: null });
  assert.equal(state.storage.alarm, T);

  await store.alarm();
  assert.deepEqual(ran, ["routine:a"]);
  assert.equal(state.storage.alarm, T + RETRY_MS);

  clock.t = T + RETRY_MS;
  await store.alarm();
  assert.deepEqual(ran, ["routine:a"]);
  assert.equal(state.storage.alarm, T + 2 * RETRY_MS);

  refuse.clear();
  clock.t = T + 2 * RETRY_MS;
  await store.alarm();
  assert.deepEqual(ran, ["routine:a", "routine:bad"]);
  assert.equal(state.storage.alarm, T + 3_600_000);
});

test("an alarm with nothing due re-arms for the next one, and with nothing left clears itself", { skip }, async () => {
  const clock = clockAt(T);
  const state = stateOver();
  const { ran, dispatch } = dispatcher();
  const store = new TexStore(state, {}, { dispatch, now: clock.now });
  const timers = texTimers(reach(store));
  await timers.schedule({ id: "routine:later", at: T + 3_600_000, payload: null });
  await store.alarm();
  assert.deepEqual(ran, []);
  assert.equal(state.storage.alarm, T + 3_600_000);
  await timers.cancel("routine:later");
  assert.equal(state.storage.alarm, null);
  await store.alarm();
  assert.deepEqual(ran, []);
  assert.equal(state.storage.alarm, null);
});

test("with no place wired a due routine is kept and waits, without firing again at once", { skip }, async () => {
  const clock = clockAt(T);
  const state = stateOver();
  const store = new TexStore(state, {}, { now: clock.now });
  await texTimers(reach(store)).schedule({ id: "routine:a", at: T, payload: null });
  await store.alarm();
  assert.equal(nextAt(state.storage.sql), T + RETRY_MS);
  assert.equal(state.storage.alarm, T + RETRY_MS);
  // The same instant again: nothing is due, so nothing runs and the alarm does not come back at once.
  await store.alarm();
  assert.equal(state.storage.alarm, T + RETRY_MS);
  assert.equal(due(state.storage.sql, T).length, 0);
});

test("a batch over one alarm's cap is drained over alarms, never all in one", { skip }, async () => {
  const clock = clockAt(T);
  const state = stateOver();
  const { ran, dispatch } = dispatcher();
  const store = new TexStore(state, {}, { dispatch, now: clock.now });
  const timers = texTimers(reach(store));
  for (let index = 0; index < MAX_DUE + 5; index += 1) await timers.schedule({ id: `r${index}`, at: T, payload: null });
  await store.alarm();
  assert.equal(ran.length, MAX_DUE);
  assert.equal(state.storage.alarm, T);
  await store.alarm();
  assert.equal(ran.length, MAX_DUE + 5);
  assert.equal(state.storage.alarm, null);
});

test("the fetch wire schedules and cancels, and refuses a bad alarm as it refuses a bad note", { skip }, async () => {
  const state = stateOver();
  const store = new TexStore(state, {}, { now: clockAt(T).now });
  const timers = texTimers(reach(store));
  await assert.rejects(timers.schedule({ id: "", at: T, payload: null }), TexObjectRefused);
  await assert.rejects(timers.schedule({ id: "a", at: "soon", payload: null }), TexObjectRefused);
  assert.equal(nextAt(state.storage.sql), null);
  await timers.schedule({ id: "a", at: T, payload: { path: "tex/routines/once/a.md" } });
  assert.equal(state.storage.alarm, T);
  const unknown = await store.fetch(
    new Request("https://tex-store.internal/nope", {
      method: "POST",
      headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "nope" })) },
    }),
  );
  assert.equal(unknown.status, 400);
});

test("the note wire alone does not take alarm calls: they exist only where the object keeps its alarms", { skip }, async () => {
  const objects = texObjects(durableSql());
  const response = await serveTexStore(
    objects,
    new Request("https://tex-store.internal/schedule", {
      method: "POST",
      headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "cancel", id: "a" })) },
    }),
  );
  assert.equal(response.status, 400);
});

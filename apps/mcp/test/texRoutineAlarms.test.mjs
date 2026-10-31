// Tex's routine alarms, end to end on the gateway's side (src/texStore/routineAlarm.js,
// src/texStore/dispatch.js, src/texStore.js): when a routine's file is written or
// removed the object's alarm is set or cancelled; when an alarm fires it asks the
// texting Worker, and the answer says when the routine next runs.
import { test } from "node:test";
import assert from "node:assert/strict";

import { routineAlarmAt, syncRoutineAlarms } from "../src/texStore/routineAlarm.js";
import { routineDispatchFor, TEXTING_ROUTINE_DUE } from "../src/texStore/dispatch.js";
import { TexStore, RETRY_MS } from "../src/texStore.js";
import { nextAt, due } from "../src/texStore/alarms.js";
import { DEFAULT_TIME_ZONE } from "../src/agent/localNow.js";

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

const WORKSPACE = "ws_person_1";
const PATH = "tex/routines/daily/standup.md";
const DAILY = "---\nat: 7:30 am\ntimezone: Europe/London\n---\nSummarize the day.\n";
const T = Date.parse("2026-10-31T06:00:00Z");

/** The local time of `ms` in `zone`, as "HH:MM". */
function clockIn(ms, zone) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
}

/** A Durable Object's state: its SQLite and the one alarm the runtime keeps. */
function stateOver() {
  const storage = {
    sql: durableSql(),
    alarm: undefined,
    setAlarm(at) {
      storage.alarm = at;
    },
    deleteAlarm() {
      storage.alarm = null;
    },
  };
  return { storage };
}

/** A Tex store namespace whose objects are real `TexStore`s, one per name, each with its own clock. */
function namespaceOver(now = () => T) {
  const objects = new Map();
  const object = (name) => {
    if (!objects.has(name)) objects.set(name, new TexStore(stateOver(), {}, { now }));
    return objects.get(name);
  };
  const namespace = {
    idFromName: (name) => ({ name }),
    get: (id) => ({ fetch: (request) => object(id.name).fetch(request) }),
  };
  return { namespace, object, objects };
}

/** The gateway's store over the bucket for the files a test writes: `get` answers null for a missing one, as R2 does. */
function storeOf(files) {
  return {
    async get(path) {
      if (!files.has(path)) return null;
      const text = files.get(path);
      return { text: async () => text };
    },
  };
}

test("a routine's next run is read from its own file, in the zone it names", { skip: false }, () => {
  const at = routineAlarmAt(PATH, DAILY, T, DEFAULT_TIME_ZONE);
  assert.equal(typeof at, "number");
  assert.ok(at > T);
  assert.equal(clockIn(at, "Europe/London"), "07:30");
});

test("a file with no zone runs in the routines' default zone", () => {
  const at = routineAlarmAt(PATH, "---\nat: 7:30 am\n---\nbody\n", T, DEFAULT_TIME_ZONE);
  assert.equal(clockIn(at, DEFAULT_TIME_ZONE), "07:30");
});

test("a paused routine, a file that will not run, and a path that is no routine have no alarm", () => {
  assert.equal(routineAlarmAt(PATH, "---\nat: 7:30 am\npaused: yes\n---\nbody\n", T, DEFAULT_TIME_ZONE), null);
  assert.equal(routineAlarmAt(PATH, "---\nat: half past seven\n---\nbody\n", T, DEFAULT_TIME_ZONE), null);
  assert.equal(routineAlarmAt("tex/notes/about.md", DAILY, T, DEFAULT_TIME_ZONE), null);
  assert.equal(routineAlarmAt(PATH, null, T, DEFAULT_TIME_ZONE), null);
});

test("writing a routine sets its alarm on the owner's object, and removing it clears the alarm", { skip }, async () => {
  const { namespace, object } = namespaceOver();
  const env = { TEX_STORE: namespace };
  const files = new Map([[PATH, DAILY]]);
  await syncRoutineAlarms(env, WORKSPACE, storeOf(files), [PATH], T);
  const kept = object(`person:${WORKSPACE}`);
  const row = due(kept.state.storage.sql, Number.MAX_SAFE_INTEGER)[0];
  assert.equal(row.id, PATH);
  assert.equal(row.payload.owner, `person:${WORKSPACE}`);
  assert.equal(clockIn(row.at, "Europe/London"), "07:30");
  assert.equal(kept.state.storage.alarm, row.at);

  files.delete(PATH);
  await syncRoutineAlarms(env, WORKSPACE, storeOf(files), [PATH], T);
  assert.equal(nextAt(kept.state.storage.sql), null);
  assert.equal(kept.state.storage.alarm, null);
});

test("a paths list that names nothing under tex/routines/ touches no object at all", { skip }, async () => {
  let asked = 0;
  const env = {
    TEX_STORE: { idFromName: (name) => name, get: () => (asked += 1, { fetch: async () => new Response(null, { status: 200 }) }) },
  };
  await syncRoutineAlarms(env, WORKSPACE, storeOf(new Map([["routines/daily/a.md", DAILY]])), ["routines/daily/a.md", "notes/x.md"], T);
  assert.equal(asked, 0);
});

test("a failure to schedule resolves and never throws: the cron is the backstop", { skip }, async () => {
  const failing = { TEX_STORE: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response(null, { status: 503 }) }) } };
  await syncRoutineAlarms(failing, WORKSPACE, storeOf(new Map([[PATH, DAILY]])), [PATH], T);
  const broken = { TEX_STORE: { idFromName: () => { throw new Error("no namespace"); }, get: () => null } };
  await syncRoutineAlarms(broken, WORKSPACE, storeOf(new Map([[PATH, DAILY]])), [PATH], T);
  const unbound = {};
  await syncRoutineAlarms(unbound, WORKSPACE, storeOf(new Map([[PATH, DAILY]])), [PATH], T);
  // A store that cannot be read is the same: nothing scheduled, nothing thrown.
  await syncRoutineAlarms({ TEX_STORE: namespaceOver().namespace }, WORKSPACE, { get: async () => { throw new Error("bucket down"); } }, [PATH], T);
});

test("an alarm that fires asks the texting Worker for its own routine, and re-arms at the time it answers", { skip }, async () => {
  const calls = [];
  const texting = {
    fetch: async (request) => {
      calls.push({ url: request.url, method: request.method, auth: request.headers.get("authorization"), body: JSON.parse(await request.text()) });
      return Response.json({ next: T + 86_400_000 });
    },
  };
  const state = stateOver();
  const dispatch = routineDispatchFor({ TEXTING: texting, TEX_ALARM_SECRET: "s3cret" });
  const store = new TexStore(state, {}, { dispatch, now: () => T });
  await store.fetch(
    new Request("https://tex-store.internal/schedule", {
      method: "POST",
      headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "schedule" })) },
      body: JSON.stringify({ id: PATH, at: T, payload: { owner: `person:${WORKSPACE}` } }),
    }),
  );
  await store.alarm();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TEXTING_ROUTINE_DUE);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].auth, "Bearer s3cret");
  assert.deepEqual(calls[0].body, { owner: `person:${WORKSPACE}`, id: PATH });
  // The routine is kept for its next time, with its payload, and the runtime alarm is set to it.
  assert.equal(nextAt(state.storage.sql), T + 86_400_000);
  assert.equal(state.storage.alarm, T + 86_400_000);
  assert.deepEqual(due(state.storage.sql, T + 86_400_000)[0].payload, { owner: `person:${WORKSPACE}` });
});

test("a texting Worker that refuses the alarm, or cannot be reached, leaves the routine to try again in a minute", { skip }, async () => {
  const state = stateOver();
  const refusing = routineDispatchFor({ TEXTING: { fetch: async () => new Response(null, { status: 401 }) }, TEX_ALARM_SECRET: "s" });
  const store = new TexStore(state, {}, { dispatch: refusing, now: () => T });
  await store.fetch(
    new Request("https://tex-store.internal/schedule", {
      method: "POST",
      headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "schedule" })) },
      body: JSON.stringify({ id: PATH, at: T, payload: { owner: `person:${WORKSPACE}` } }),
    }),
  );
  await store.alarm();
  assert.equal(nextAt(state.storage.sql), T + RETRY_MS);
});

test("with no texting binding or no alarm secret, nothing is dispatched and the routine waits", async () => {
  for (const env of [{}, { TEXTING: { fetch: async () => new Response(null, { status: 200 }) } }]) {
    const dispatch = routineDispatchFor(env);
    await assert.rejects(dispatch({ id: PATH, at: T, payload: { owner: `person:${WORKSPACE}` } }));
  }
});

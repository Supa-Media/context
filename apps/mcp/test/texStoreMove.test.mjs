/**
 * Moving each Tex store to an object placed in eastern North America
 * (`src/texStore/move.js`): copied whole on first use, checked key by key,
 * never answered from half-copied, the old one passing every late call on and
 * cleared after three days, or at once when the store is wiped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { texStoreNamespace } from "./texStoreFixture.mjs";
import { texBucket, texStoreStub, texTimers } from "../src/texStore/wire.js";
import { KEEP_OLD_MS, TexMoved, placeOf } from "../src/texStore/move.js";
import { texObjects } from "../src/texStore/objects.js";
import { everyAlarm } from "../src/texStore/alarms.js";
import { durableSql } from "./texStoreFixture.mjs";

const OWNER = "person:ws_mover";
const call = (op, fields = {}) => new Request(`https://tex-store.internal/${op}`, { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op, ...fields })) } });

/** An old store, under the bare name, holding notes, metadata, a big body over one page, and routine alarms. */
async function oldStoreWith(tex) {
  const old = tex.oldObject(OWNER);
  old.ready();
  // Seeded as the old store kept them, before any move existed.
  await old.objects.put("notes/a.md", new TextEncoder().encode("# A"), { httpMetadata: { contentType: "text/markdown" }, customMetadata: { by: "tex" } });
  await old.objects.put("state/agent/history/texts.json", new TextEncoder().encode('{"v":1}'));
  for (let i = 0; i < 230; i += 1) await old.objects.put(`state/agent/turns/t${String(i).padStart(3, "0")}.json`, new TextEncoder().encode(`{"i":${i}}`));
  await old.objects.put("files/big.bin", new Uint8Array(9 * 1024 * 1024).fill(7));
  old.timers.schedule({ id: "tex/routines/daily.md", at: 5_000, payload: { owner: OWNER } });
  old.timers.schedule({ id: "tex/routines/weekly.md", at: 9_000, payload: { owner: OWNER } });
  return old;
}

test("the first call copies the old store whole into the placed one, checked, and only then answers", async () => {
  const tex = texStoreNamespace();
  const env = { TEX_STORE: tex.namespace };
  const old = await oldStoreWith(tex);
  // A fresh placed object: not yet arrived.
  tex.objects.set(OWNER, new (old.constructor)({ storage: freshStorage(), blockConcurrencyWhile: (run) => run() }, { TEX_STORE: tex.inner }, {}));
  const bucket = texBucket(texStoreStub(env, { person: "ws_mover" }));
  const got = await bucket.get("notes/a.md");
  assert.equal(await got.text(), "# A");
  assert.equal(got.httpMetadata.contentType, "text/markdown");
  assert.deepEqual(got.customMetadata, { by: "tex" });

  const placed = tex.objects.get(OWNER);
  placed.ready();
  let all = [], cursor;
  for (;;) {
    const page = placed.objects.list({ cursor });
    all.push(...page.objects);
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  const shape = ({ key, etag, size, uploaded, httpMetadata, customMetadata }) => ({ key, etag, size, uploaded, httpMetadata, customMetadata });
  const oldAll = [];
  for (let c; ; ) {
    const page = old.objects.list({ cursor: c });
    oldAll.push(...page.objects);
    if (!page.truncated) break;
    c = page.cursor;
  }
  assert.deepEqual(all.map(shape), oldAll.map(shape), "same keys, etags, sizes, times and metadata");
  assert.equal(all.length, 233, "every key, over many pages, the big body included");
  assert.equal(placed.objects.get("files/big.bin").body.byteLength, 9 * 1024 * 1024);
  assert.deepEqual(everyAlarm(placed.state.storage.sql).map((alarm) => alarm.id), ["tex/routines/daily.md", "tex/routines/weekly.md"]);
  assert.equal(placed.state.storage.alarm, 5_000, "the placed store arms its earliest routine");
  const place = placeOf(placed.state.storage.sql);
  assert.equal(place.from, OWNER);
  assert.equal(place.keys, 233);

  const left = placeOf(old.state.storage.sql);
  assert.equal(left.movedTo, `enam:${OWNER}`);
  assert.equal(old.state.storage.alarm, left.purgeAt, "the old store's alarm is now only for clearing its copy");
  assert.equal(left.purgeAt - left.movedAt, KEEP_OLD_MS);
});

/** A world where the owner's old store holds a note and the placed one has not arrived. */
async function movingWorld() {
  const tex = texStoreNamespace();
  const env = { TEX_STORE: tex.namespace };
  const old = tex.oldObject(OWNER);
  old.ready();
  await old.objects.put("notes/a.md", new TextEncoder().encode("# A"));
  old.timers.schedule({ id: "tex/routines/daily.md", at: 5_000, payload: { owner: OWNER } });
  const fresh = new (old.constructor)({ storage: { ...freshStorage() }, blockConcurrencyWhile: (run) => run() }, { TEX_STORE: tex.inner }, { dispatch: async () => ({ next: null }) });
  tex.objects.set(OWNER, fresh);
  return { tex, env, old, fresh, bucket: texBucket(texStoreStub(env, { person: "ws_mover" })) };
}

function freshStorage() {
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
  return storage;
}

test("a copy that fails part way is thrown away and answers nothing; the next call copies again", async () => {
  const { tex, old, fresh, bucket } = await movingWorld();
  let fail = true;
  tex.beforeInner = (name, header) => {
    if (fail && name === OWNER && decodeURIComponent(header).includes("move_page")) throw new Error("the Atlantic dropped it");
  };
  await assert.rejects(bucket.get("notes/a.md"), /503/);
  fresh.ready();
  assert.deepEqual(fresh.objects.list({}).objects, [], "nothing half-copied is kept");
  assert.equal(placeOf(fresh.state.storage.sql).arrivedAt, undefined);
  assert.deepEqual(everyAlarm(fresh.state.storage.sql), []);

  fail = false;
  assert.equal(await (await bucket.get("notes/a.md")).text(), "# A");
  assert.ok(placeOf(fresh.state.storage.sql).arrivedAt !== undefined);
  assert.equal(placeOf(old.state.storage.sql).movedTo, `enam:${OWNER}`);
});

test("a copy whose bytes do not match the old store's list is refused, and nothing is answered", async () => {
  const { tex, fresh, bucket } = await movingWorld();
  let garble = true;
  const inner = tex.old.get(OWNER);
  const realFetch = inner.fetch.bind(inner);
  inner.fetch = async (request) => {
    const answer = await realFetch(request);
    if (!garble || !decodeURIComponent(request.headers.get("x-tex-call") ?? "").includes("move_page")) return answer;
    const bytes = new Uint8Array(await answer.arrayBuffer());
    bytes[bytes.length - 1] ^= 1;
    return new Response(bytes);
  };
  await assert.rejects(bucket.get("notes/a.md"), /503/);
  fresh.ready();
  assert.deepEqual(fresh.objects.list({}).objects, []);
  garble = false;
  assert.equal(await (await bucket.get("notes/a.md")).text(), "# A");
});

test("a late call to the old store, from a gateway still on the old code, is passed on and never kept there", async () => {
  const { old, fresh, bucket } = await movingWorld();
  await bucket.get("notes/a.md");
  // The old code's call: the bare name, no owner.
  const stale = texBucket({ fetch: (request) => old.fetch(request) });
  await stale.put("notes/b.md", "# B");
  assert.equal(await (await stale.get("notes/b.md")).text(), "# B", "read back through the old name, from the placed store");
  fresh.ready();
  assert.equal(new TextDecoder().decode(fresh.objects.get("notes/b.md").body), "# B");
  assert.equal(old.objects.head("notes/b.md"), null, "nothing written to the old copy");
  await texTimers({ fetch: (request) => old.fetch(request) }).schedule({ id: "tex/routines/late.md", at: 7_000, payload: { owner: OWNER } });
  assert.ok(everyAlarm(fresh.state.storage.sql).some((alarm) => alarm.id === "tex/routines/late.md"));
  assert.ok(!everyAlarm(old.state.storage.sql).some((alarm) => alarm.id === "tex/routines/late.md"));
});

test("a write already under way when the store moves is stopped before it writes", async () => {
  const sql = durableSql();
  let moved = false;
  const objects = texObjects(sql, { guard: () => {
    if (moved) throw new TexMoved();
  } });
  const writing = objects.put("notes/a.md", new TextEncoder().encode("late"));
  moved = true;
  await assert.rejects(writing, TexMoved);
  assert.equal(objects.head("notes/a.md"), null);
});

test("the old store runs no routine once moved, and clears its copy after three days, keeping where it went", async () => {
  const { old, bucket } = await movingWorld();
  let ran = 0;
  old.dispatch = async () => ((ran += 1), { next: null });
  await bucket.get("notes/a.md");
  const { purgeAt } = placeOf(old.state.storage.sql);
  old.now = () => 6_000;
  await old.alarm();
  assert.equal(ran, 0, "the daily routine runs from the placed store, never twice");
  assert.equal(old.state.storage.alarm, purgeAt);
  assert.ok(old.objects.head("notes/a.md") !== null, "kept until then");
  old.now = () => purgeAt;
  await old.alarm();
  assert.equal(old.objects.head("notes/a.md"), null);
  assert.deepEqual(everyAlarm(old.state.storage.sql), []);
  assert.equal(placeOf(old.state.storage.sql).movedTo, `enam:${OWNER}`, "still passes a late call on");
  assert.equal(old.state.storage.alarm, null);
});

test("wiping the store (an account or a chat ending) clears the old copy at once", async () => {
  const { old, fresh, bucket } = await movingWorld();
  await bucket.wipe();
  fresh.ready();
  assert.deepEqual(fresh.objects.list({}).objects, []);
  assert.equal(old.objects.head("notes/a.md"), null, "no copy left in the old store");
});

test("a call through the gateway's stub can never ask a store to move out or hand over a page", async () => {
  const { tex, env, old, bucket } = await movingWorld();
  const stub = texStoreStub(env, { person: "ws_mover" });
  for (const op of ["move_out", "move_page", "move_purge"]) {
    const answer = await stub.fetch(call(op, { owner: OWNER, to: `enam:${OWNER}` }));
    assert.equal(answer.status, 400, op);
  }
  const placed = tex.objects.get(OWNER);
  placed.ready();
  assert.equal(placeOf(placed.state.storage.sql).movedTo, undefined, "the placed store never marks itself moved");
  // And a placed store that has arrived, asked directly with no owner, refuses to move out too.
  await bucket.get("notes/a.md");
  const direct = await placed.fetch(call("move_out", { owner: OWNER, to: `enam:${OWNER}` }));
  assert.equal(direct.status, 400);
  assert.equal(placeOf(old.state.storage.sql).movedTo, `enam:${OWNER}`);
});

test("a placed store that has not arrived answers nothing to a call that names no owner", async () => {
  const { fresh } = await movingWorld();
  const answer = await fresh.fetch(call("get", { key: "notes/a.md" }));
  assert.equal(answer.status, 503);
});

test("one owner's move never reads another's old store", async () => {
  const tex = texStoreNamespace();
  const env = { TEX_STORE: tex.namespace };
  const other = tex.oldObject("person:ws_other");
  other.ready();
  await other.objects.put("notes/secret.md", new TextEncoder().encode("theirs"));
  const fresh = new (other.constructor)({ storage: freshStorage(), blockConcurrencyWhile: (run) => run() }, { TEX_STORE: tex.inner }, {});
  tex.objects.set(OWNER, fresh);
  const bucket = texBucket(texStoreStub(env, { person: "ws_mover" }));
  assert.equal(await bucket.get("notes/secret.md"), null);
  assert.equal(placeOf(other.state.storage.sql).movedTo, undefined, "the other store is untouched");
});

test("live-typing and activity rooms live under names placed in eastern North America", async () => {
  const { roomByName } = await import("../src/objectPlace.js");
  const asked = [];
  const namespace = { idFromName: (name) => name, get: (id, options) => (asked.push([id, options?.locationHint]), {}) };
  roomByName(namespace, "ws_1/notes%2Fa.md");
  roomByName(namespace, "activity:ws_1");
  assert.deepEqual(asked, [["enam:ws_1/notes%2Fa.md", "enam"], ["enam:activity:ws_1", "enam"]]);
});

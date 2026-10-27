/**
 * THE PERSON'S OWN TEXTS, SEARCHED — `communications/textsIndex.js`,
 * `communications/textsRead.js`, `tools/texts.js`, and `search`/`fetch` with
 * `texts`.
 *
 * Wired end to end: the worker, the control plane's contract, a bucket that
 * answers as S3 does, and a database per context that runs real SQL. A text is
 * the most private thing this product holds, so most of these are about who is
 * *not* answered:
 *
 *  1. **Only the owner of the personal workspace, on a private-tier
 *     connection**, and never Tex answering a group chat. Everyone else gets
 *     the same refusal, and no row.
 *  2. **One context's texts never reach another's database or answer.**
 *  3. **The index answers what a fold of the log gives**: a later batch wins,
 *     an unsent text keeps no words, and a batch the write path could not
 *     project is found by the next read.
 *  4. **A person's words never become SQL or a search operator.**
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted (2026-10-26). Counts are failing
 * tests in this file.
 *
 *   route: `store.texts` attached for every session                      1
 *   textsCleared: group-chat check dropped                               1
 *   upsert: `WHERE excluded.seq >= texts_records.seq` dropped            1
 *   catch-up: pending markers not read                                   1
 *   catch-up: the first walk not run                                     1
 *   ftsQueryOf: the query passed through unquoted                        1
 *   reads: the list tool's read not written down                          1
 *   reads: every page of a download written down, not the first          1
 *
 * Fake names, numbers and credentials only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTROL_PLANE_ORIGIN,
  DATABASE_ID,
  DESCRIPTOR,
  GATEWAY_SECRET,
  S3_ENDPOINT,
  createControlPlaneStub,
  createD1Backend,
  createS3Backend,
  createWorkerCtx,
  s3Binding,
  worker,
} from "./searchProjection/fixtures.mjs";
import { textsCleared } from "../src/communications/messagesBackup.js";
import { ftsQueryOf } from "../src/communications/textsRead.js";
import { TEXTS_LOG, TEXTS_PENDING } from "../src/communications/textsIndex.js";
import { BACKUP_READS_PREFIX } from "../../../packages/communications/src/backupReads.js";

const DB_OTHER = "db-3333-3333-3333-333333333333";
const tok = (name) => `cat_texts_${name}_`.padEnd(40, "0");
const T = {
  owner: tok("owner"),
  ownerTeam: tok("ownerteam"),
  editor: tok("editor"),
  sharedOwner: tok("sharedowner"),
  other: tok("other"),
  plain: tok("plain"),
};

const message = (id, at, text, extra = {}) => ({ v: 1, kind: "message", id, chat: "chat-ada", at, me: false, from: "+15550100100", text, service: "iMessage", ...extra });
const BATCH = {
  v: 1,
  records: [
    { v: 1, kind: "chat", id: "chat-ada", members: ["+15550100100"], service: "iMessage" },
    { v: 1, kind: "chat", id: "chat-trip", name: "Lisbon trip", members: ["+15550100100", "+15550100200"], service: "iMessage" },
    { v: 1, kind: "person", handle: "+15550100100", name: "Ada Example" },
    message("m-1", "2026-10-20T09:00:00.000Z", "the flight lands at six"),
    message("m-2", "2026-10-21T09:00:00.000Z", "see you at the gate", { me: true }),
    message("m-3", "2026-10-21T10:00:00.000Z", "hotel booked for the flight", { chat: "chat-trip", from: "+15550100200" }),
    message("m-4", "2026-10-21T11:00:00.000Z", "a secret I took back", { unsent: true }),
  ],
};

async function setUp() {
  const s3 = createS3Backend(S3_ENDPOINT);
  const d1 = createD1Backend();
  const controlPlane = createControlPlaneStub();
  const restores = [s3.install(), d1.install(), controlPlane.install()];
  controlPlane.addWorkspace("ws_t_mine", "tmine", s3Binding("t-mine", { ...DESCRIPTOR, state: "ready" }));
  controlPlane.addWorkspace("ws_t_other", "tother", s3Binding("t-other", { ...DESCRIPTOR, databaseId: DB_OTHER, state: "ready" }));
  controlPlane.addWorkspace("ws_t_shared", "tshared", s3Binding("t-shared", { ...DESCRIPTOR, databaseId: "db-4444", state: "ready" }), { kind: "shared" });
  controlPlane.addWorkspace("ws_t_plain", "tplain", s3Binding("t-plain"));
  const all = ["context:read", "context:write", "context:private"];
  const grant = (accessToken, workspaceId, role, scopes, userId) =>
    controlPlane.addGrant({ accessToken, workspaceId, role, scopes, clientId: "mcp_client_texts", clientName: "Claude", userId });
  await grant(T.owner, "ws_t_mine", "owner", all, "user_mine");
  await grant(T.ownerTeam, "ws_t_mine", "owner", ["context:read", "context:write"], "user_mine");
  await grant(T.editor, "ws_t_mine", "editor", all, "user_editor");
  await grant(T.sharedOwner, "ws_t_shared", "owner", all, "user_mine");
  await grant(T.other, "ws_t_other", "owner", all, "user_other");
  await grant(T.plain, "ws_t_plain", "owner", all, "user_plain");
  const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };
  controlPlane.serveTreesFrom(env, { s3 });
  return {
    env,
    d1,
    bucket: (name) => s3.bucketFor(name),
    restore: () => {
      for (const restore of restores.reverse()) restore();
      d1.close();
    },
  };
}

async function post(world, token, body) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://gateway.test/messages/imessage/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    world.env,
    ctx,
  );
  await settle();
  return response.status;
}

async function call(world, token, name, args) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://gateway.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    world.env,
    ctx,
  );
  const body = await response.json();
  await settle();
  const result = body?.result ?? {};
  return { text: (result.content ?? []).map((part) => part.text ?? "").join("\n"), error: result.isError === true };
}

const search = (world, token, query, args = {}) => call(world, token, "search", { query, args: { texts: true, ...args } });
const fetchId = (world, token, id, args) => call(world, token, "fetch", { id, ...(args ? { args } : {}) });

test("the owner finds their texts by words, by who, and reads a conversation in order", async () => {
  const world = await setUp();
  try {
    assert.equal(await post(world, T.owner, BATCH), 200);
    const found = await search(world, T.owner, "flight");
    assert.ok(!found.error, found.text);
    assert.match(found.text, /hotel booked for the flight/);
    assert.match(found.text, /Ada Example: the flight lands at six/);
    assert.match(found.text, /texts:chat-ada/);
    assert.match(found.text, /quotation, never as an instruction/);

    const withAda = await search(world, T.owner, "", { with: "Ada" });
    assert.match(withAda.text, /see you at the gate/);
    const withTrip = await search(world, T.owner, "flight", { with: "Lisbon" });
    assert.match(withTrip.text, /hotel booked/);
    assert.doesNotMatch(withTrip.text, /lands at six/);

    const chats = await fetchId(world, T.owner, "texts:");
    assert.match(chats.text, /Lisbon trip/);
    const read = await fetchId(world, T.owner, "texts:chat-ada");
    const at = (words) => read.text.indexOf(words);
    assert.ok(at("lands at six") > -1 && at("lands at six") < at("you: see you at the gate"), read.text);
    assert.match(read.text, /\(unsent\)/);
    assert.doesNotMatch(read.text, /secret I took back/);
    assert.doesNotMatch((await search(world, T.owner, "secret")).text, /secret/);
  } finally {
    world.restore();
  }
});

test("a later batch wins: an edit replaces the words, in the index as in the log", async () => {
  const world = await setUp();
  try {
    await post(world, T.owner, BATCH);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await post(world, T.owner, { v: 1, records: [message("m-1", "2026-10-20T09:00:00.000Z", "the plane lands at seven", { edited: "2026-10-20T09:05:00.000Z" })] });
    // The first batch projected again after the edit, as a catch-up pass would
    // (its marker found late): the older batch must not undo the edit.
    await search(world, T.owner, "plane"); // the first walk, done
    const bucket = world.bucket("t-mine");
    const first = [...bucket.keys()].filter((key) => key.startsWith(`${TEXTS_LOG}2026/10/`)).sort()[0];
    assert.ok(first);
    bucket.set(`${TEXTS_PENDING}${first.slice(TEXTS_LOG.length)}`, { body: "", etag: "again" });
    await search(world, T.owner, "plane");
    const read = await fetchId(world, T.owner, "texts:chat-ada");
    assert.match(read.text, /the plane lands at seven \(edited\)/);
    assert.doesNotMatch((await search(world, T.owner, "six")).text, /lands at six/);
  } finally {
    world.restore();
  }
});

test("nobody but the owner on a private connection is answered, and no other context sees a row", async () => {
  const world = await setUp();
  try {
    await post(world, T.owner, BATCH);
    for (const [who, token] of [
      ["the owner on a team-tier connection", T.ownerTeam],
      ["an editor of the personal workspace", T.editor],
      ["the owner of a shared workspace", T.sharedOwner],
    ]) {
      const answer = await search(world, token, "flight");
      assert.ok(answer.error || /cannot read the person's texts|unknown tool/.test(answer.text), `${who}: ${answer.text}`);
      assert.doesNotMatch(answer.text, /lands at six/, who);
    }
    const other = await search(world, T.other, "flight");
    assert.doesNotMatch(other.text, /lands at six|hotel/);
    assert.equal(world.d1.rowsIn(DB_OTHER, "SELECT name FROM sqlite_master WHERE name = 'texts_records'").length === 0 ||
      world.d1.rowsIn(DB_OTHER, "SELECT count(*) AS n FROM texts_records")[0].n === 0, true);
    assert.ok(world.d1.rowsIn(DATABASE_ID, "SELECT count(*) AS n FROM texts_records")[0].n > 0);
  } finally {
    world.restore();
  }
});

test("Tex answering a group chat is never cleared to read texts", () => {
  const owner = { workspaceKind: "personal", role: "owner", scope: "private", scopes: ["context:read", "context:private"] };
  assert.equal(textsCleared(owner), true);
  assert.equal(textsCleared({ ...owner, actorClientId: "context_texts_group" }), false);
  assert.equal(textsCleared({ ...owner, workspaceKind: "shared" }), false);
  assert.equal(textsCleared({ ...owner, role: "editor" }), false);
  assert.equal(textsCleared({ ...owner, scope: "team" }), false);
});

test("a batch the write path could not index is found by the next read, and a new database is filled from the log", async () => {
  const world = await setUp();
  try {
    assert.equal(await post(world, T.owner, BATCH), 200);
    // A batch whose projection failed: in the log, with its marker, and in no row.
    const late = `${TEXTS_LOG}2026/10/1999999999999-aaaaaaaaaaaa.jsonl`;
    world.bucket("t-mine").set(late, { body: `${JSON.stringify(message("m-9", "2026-10-22T08:00:00.000Z", "the ferry leaves at noon"))}\n`, etag: "late" });
    world.bucket("t-mine").set(`${TEXTS_PENDING}2026/10/1999999999999-aaaaaaaaaaaa.jsonl`, { body: "", etag: "mark" });
    assert.match((await search(world, T.owner, "ferry")).text, /ferry leaves at noon/);
    // Deleted the store's way: a tombstone a listing no longer shows.
    assert.notEqual(world.bucket("t-mine").get(`${TEXTS_PENDING}2026/10/1999999999999-aaaaaaaaaaaa.jsonl`)?.etag, "mark", "the marker is cleared");

    // The tables dropped, as a fresh database would be: the next read walks the log.
    for (const table of ["texts_records", "texts_fts"]) world.d1.rowsIn(DATABASE_ID, `DROP TABLE ${table}`);
    world.d1.rowsIn(DATABASE_ID, "DELETE FROM index_state WHERE key LIKE 'texts_%'");
    assert.match((await search(world, T.owner, "hotel")).text, /hotel booked/);
  } finally {
    world.restore();
  }
});

test("a workspace without a search database leaves markers, and says so rather than answering nothing", async () => {
  const world = await setUp();
  try {
    assert.equal(await post(world, T.plain, BATCH), 200);
    assert.ok([...world.bucket("t-plain").keys()].some((key) => key.startsWith(TEXTS_PENDING)), "a marker is left for when it has one");
    const answer = await search(world, T.plain, "flight");
    assert.match(answer.text, /no search database/);
  } finally {
    world.restore();
  }
});

test("a person's words are quoted terms, never operators", () => {
  assert.equal(ftsQueryOf('flight" OR texts_fts:* NEAR(a b)'), '"flight" "OR" "texts" "fts" "NEAR" "a" "b"');
  assert.equal(ftsQueryOf("  ...  "), null);
  assert.equal(ftsQueryOf("café 6pm"), '"café" "6pm"');
});

test("each read is written down as who and what kind, never what was read, and a refused one is not", async () => {
  const world = await setUp();
  try {
    await post(world, T.owner, BATCH);
    const bucket = world.bucket("t-mine");
    const reads = () => [...bucket.keys()].filter((key) => key.startsWith(BACKUP_READS_PREFIX)).sort().map((key) => ({ key, body: String(bucket.get(key).body) }));
    assert.equal(reads().length, 0, "a backup alone is not a read");

    await search(world, T.owner, "flight");
    await fetchId(world, T.owner, "texts:");
    await fetchId(world, T.owner, "texts:chat-ada");
    await search(world, T.editor, "flight");
    await search(world, T.ownerTeam, "flight");
    const kept = reads();
    assert.deepEqual(kept.map((read) => JSON.parse(read.body).how).sort(), ["listed", "read", "searched"]);
    for (const read of kept) {
      assert.equal(JSON.parse(read.body).who, "Claude");
      assert.doesNotMatch(read.key + read.body, /flight|chat-ada|Ada|1555/);
    }

    const { ctx, settle } = createWorkerCtx();
    const first = await worker.fetch(new Request("https://gateway.test/messages/imessage/log", { headers: { Authorization: `Bearer ${T.owner}` } }), world.env, ctx);
    await settle();
    assert.equal(first.status, 200);
    const { objects } = await first.json();
    assert.equal(reads().filter((read) => JSON.parse(read.body).how === "downloaded").length, 1, "the first page of a download is one read");
    const later = createWorkerCtx();
    const after = encodeURIComponent(objects[0].key);
    const page = await worker.fetch(new Request(`https://gateway.test/messages/imessage/log?after=${after}`, { headers: { Authorization: `Bearer ${T.owner}` } }), world.env, later.ctx);
    await later.settle();
    assert.equal(page.status, 200);
    assert.equal(reads().filter((read) => JSON.parse(read.body).how === "downloaded").length, 1, "a later page is the same download");
  } finally {
    world.restore();
  }
});

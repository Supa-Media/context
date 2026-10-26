/**
 * THE MESSAGES BACKUP READ BACK BY ITS OWNER (`src/communications/messagesBackupRead.js`,
 * `packages/communications/src/backupLog.js`), for the Mac app's Download messages.
 *
 * Wired end to end as `messagesBackupFiles.test.mjs` is: the worker, the
 * control plane's contract, and a bucket that answers as S3 does.
 *
 *  1. **Only the owner reads it**, on exactly the terms that let them write it.
 *  2. **The log comes back whole, in arrival order, a page at a time**, and a
 *     page never starts outside it.
 *  3. **A file comes back as the bytes it was sent as**, as an attachment no
 *     browser runs, and one an unsend took back is not found.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted (2026-10-26). Counts are failing
 * tests in this file.
 *
 *   route: reads skip messagesBackupRefusal                              1
 *   readLogPage: keys outside the log not filtered                       1
 *   readLogPage: next null after the first page                          1
 *   readLogPage: a store that does not move answered as finished         1
 *
 * Fake names, numbers and credentials only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { createControlPlaneStub, createS3Backend, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import { digestId } from "../../../packages/communications/src/backup.js";
import { BACKUP_LOG_PREFIX, LOG_PAGE_OBJECTS, readLogPage } from "../../../packages/communications/src/backupLog.js";

const S3_ENDPOINT = "https://s3.example-messages-read.test";
const tok = (name) => `cat_msgread_${name}_`.padEnd(40, "0");
const T = { owner: tok("owner"), editor: tok("editor"), sharedOwner: tok("sharedowner"), teamTier: tok("teamtier") };
const FILE = "0123456789abcdef0123456789abcdef";

function binding(bucket) {
  return {
    provider: "s3",
    status: "active",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: "AKIAEXAMPLEEXAMPLECC",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLECC",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
  };
}

const message = (id, at, extra = {}) => ({ v: 1, kind: "message", id, chat: "chat-ada", at, me: false, from: "+15550100100", text: `words of ${id}`, service: "iMessage", ...extra });

async function setUp() {
  const s3 = createS3Backend(S3_ENDPOINT);
  const controlPlane = createControlPlaneStub();
  const restores = [s3.install(), controlPlane.install()];
  controlPlane.addWorkspace("ws_mr_mine", "mrmine", binding("mr-mine"));
  controlPlane.addWorkspace("ws_mr_shared", "mrshared", binding("mr-shared"), { kind: "shared" });
  const all = ["context:read", "context:write", "context:private"];
  const grant = (accessToken, workspaceId, role, scopes, userId) =>
    controlPlane.addGrant({ accessToken, workspaceId, role, scopes, clientId: "context_desktop", clientName: "Context for Mac", userId });
  await grant(T.owner, "ws_mr_mine", "owner", all, "user_mine");
  await grant(T.editor, "ws_mr_mine", "editor", all, "user_editor");
  await grant(T.sharedOwner, "ws_mr_shared", "owner", all, "user_mine");
  await grant(T.teamTier, "ws_mr_mine", "owner", ["context:read", "context:write"], "user_mine");
  return {
    env: { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET },
    restore: () => {
      for (const restore of restores.reverse()) restore();
    },
  };
}

async function call(world, token, method, path, body) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request(`https://gateway.test${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body,
    }),
    world.env,
    ctx,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  await settle();
  let parsed = null;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    parsed = null;
  }
  return { status: response.status, headers: response.headers, bytes, body: parsed };
}

const batch = (records) => JSON.stringify({ v: 1, records });

test("the owner reads back the log they wrote and a file's bytes, as an attachment no browser runs", async () => {
  const world = await setUp();
  try {
    const at = new Date(Date.now() - 60_000).toISOString();
    assert.equal((await call(world, T.owner, "POST", "/messages/imessage/batch", batch([message("m-1", at), message("m-2", at)]))).status, 200);
    const folder = await digestId("m-1");
    assert.equal((await call(world, T.owner, "POST", `/messages/imessage/file/${folder}/${FILE}`, "picture bytes")).status, 200);

    const page = await call(world, T.owner, "GET", "/messages/imessage/log");
    assert.equal(page.status, 200);
    assert.equal(page.body.ok, true);
    assert.equal(page.body.next, null);
    const text = page.body.objects.map((object) => object.text).join("");
    assert.ok(text.includes("words of m-1") && text.includes("words of m-2"));
    assert.ok(page.body.objects.every((object) => object.key.startsWith(BACKUP_LOG_PREFIX)));

    const file = await call(world, T.owner, "GET", `/messages/imessage/file/${folder}/${FILE}`);
    assert.equal(file.status, 200);
    assert.equal(new TextDecoder().decode(file.bytes), "picture bytes");
    assert.equal(file.headers.get("Content-Type"), "application/octet-stream");
    assert.equal(file.headers.get("Content-Disposition"), "attachment");
    assert.equal(file.headers.get("X-Content-Type-Options"), "nosniff");

    // An unsend takes the file back, and it is then not found.
    assert.equal((await call(world, T.owner, "POST", "/messages/imessage/batch", batch([message("m-1", at, { unsent: true, text: "" })]))).status, 200);
    assert.equal((await call(world, T.owner, "GET", `/messages/imessage/file/${folder}/${FILE}`)).status, 404);
    const after = await call(world, T.owner, "GET", "/messages/imessage/log");
    assert.ok(!after.body.objects.map((object) => object.text).join("").includes("words of m-1"));
  } finally {
    world.restore();
  }
});

test("everyone the backup refuses a write is refused a read", async () => {
  const world = await setUp();
  try {
    const at = new Date(Date.now() - 60_000).toISOString();
    await call(world, T.owner, "POST", "/messages/imessage/batch", batch([message("m-1", at)]));
    const folder = await digestId("m-1");
    await call(world, T.owner, "POST", `/messages/imessage/file/${folder}/${FILE}`, "picture bytes");
    for (const path of ["/messages/imessage/log", `/messages/imessage/file/${folder}/${FILE}`]) {
      for (const [who, token] of [["an editor", T.editor], ["a shared workspace's owner", T.sharedOwner], ["a team-tier grant", T.teamTier]]) {
        const answer = await call(world, token, "GET", path);
        assert.equal(answer.status, 403, `${who} ${path}`);
        assert.ok(!new TextDecoder().decode(answer.bytes).includes("words of") && !new TextDecoder().decode(answer.bytes).includes("picture"), `${who} ${path}`);
      }
      assert.equal((await call(world, null, "GET", path)).status, 401);
      const named = await call(world, T.owner, "GET", `/@mrmine${path}`);
      assert.ok(named.status === 403 || named.status === 404, String(named.status));
    }
  } finally {
    world.restore();
  }
});

test("only the reads are GETs: the batch route and anything else under the backup still want a POST", async () => {
  const world = await setUp();
  try {
    assert.equal((await call(world, T.owner, "GET", "/messages/imessage/batch")).status, 405);
    assert.equal((await call(world, T.owner, "DELETE", "/messages/imessage/log")).status, 405);
    assert.equal((await call(world, T.owner, "POST", "/messages/imessage/log", "{}")).status, 404);
    const bad = await call(world, T.owner, "GET", "/messages/imessage/file/../../notes/x");
    assert.ok(bad.status >= 400 && bad.status < 500, String(bad.status));
  } finally {
    world.restore();
  }
});

/** A store over a map, listing keys in order from `startAfter`, as S3 does (or not, with `stuck`). */
function mapStore(entries, { stuck = false, anyPrefix = false } = {}) {
  const map = new Map(entries);
  return {
    async list({ prefix, limit, startAfter }) {
      const keys = [...map.keys()].filter((key) => (anyPrefix || key.startsWith(prefix)) && (stuck || !startAfter || key > startAfter)).sort();
      return { objects: keys.slice(0, limit).map((key) => ({ key })), truncated: keys.length > limit };
    },
    async get(key) {
      return map.has(key) ? { text: async () => map.get(key) } : null;
    },
  };
}

test("the log comes back whole, page after page, and never from outside it", async () => {
  const keys = Array.from({ length: LOG_PAGE_OBJECTS + 5 }, (_, n) => `${BACKUP_LOG_PREFIX}2026/10/${String(n).padStart(13, "0")}-aa.jsonl`);
  const store = mapStore([...keys.map((key, n) => [key, `line ${n}\n`]), ["notes/zz.md", "a note"]]);
  const seen = [];
  let after;
  for (let page = 0; page < 5; page += 1) {
    const answer = await readLogPage(store, after);
    seen.push(...answer.objects.map((object) => object.key));
    if (answer.next === null) break;
    after = answer.next;
  }
  assert.deepEqual(seen, keys);
  assert.deepEqual(await readLogPage(store, "notes/"), { objects: [], next: null });
  // A store that lists past the prefix it was asked for still hands back only the log.
  const loose = mapStore([[keys[0], "line 0\n"], ["a-note.md", "a note"], ["zz/note.md", "a note"]], { anyPrefix: true });
  assert.deepEqual((await readLogPage(loose, undefined)).objects.map((object) => object.key), [keys[0]]);
  // A store that ignores where to start never answers "finished" with the log unread.
  const stuck = mapStore(keys.map((key) => [key, "x"]), { stuck: true });
  const first = await readLogPage(stuck, undefined);
  const second = await readLogPage(stuck, first.next);
  assert.equal(second.objects.length, 0);
  assert.equal(second.next, first.next, "the page answers where it was asked from, which a reader takes as short");
});

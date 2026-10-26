/**
 * THE MAC'S MESSAGES BACKUP — `POST /messages/imessage/batch`
 * (`src/communications/messagesBackup.js`).
 *
 * Wired end to end: the worker, the control plane's contract, and a bucket that
 * answers as S3 does. One person's texts are the most private thing this
 * product will hold, so most of these are about who may *not* write, and where
 * a batch must *not* land:
 *
 *  1. **Only the owner of a personal workspace, on a private-tier write grant.**
 *     A member, an editor, a shared workspace, a team-tier grant and a
 *     read-only grant are each refused, and nothing is written.
 *  2. **A batch lands in the caller's own bucket and no other**, whatever the
 *     URL names: an `@name` selector is refused outright.
 *  3. **`ok` means written.** The Mac moves its cursor on `ok`, so a failed
 *     write must never answer it.
 *  4. **Only the contract is kept.** A field the contract does not name (a
 *     file path on the Mac, say) is never written.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted (2026-10-26). Counts are failing
 * tests in this file.
 *
 *   refusal: `workspaceKind === "personal"` dropped                     2
 *   refusal: `role === "owner"` dropped                                 1
 *   refusal: `scope === "private"` and SCOPE_PRIVATE dropped            2
 *   refusal: slug check dropped                                         2
 *   route: refusal not called                                           2
 *   handler: `ok: true` answered when a put throws                      1
 *   handler: raw records written instead of normalized ones             2
 *   `messages` dropped from RESERVED_FIRST_SEGMENTS                     5
 *
 * Fake names, numbers and credentials only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { createControlPlaneStub, createS3Backend, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import {
  MESSAGES_BACKUP_LOG,
  groupOf,
  handleMessagesBackup,
  messagesBackupRefusal,
} from "../src/communications/messagesBackup.js";
import { LIMITS, recordKey } from "../../../packages/communications/src/backup.js";

const S3_ENDPOINT = "https://s3.example-messages-backup.test";
const tok = (name) => `cat_msgbackup_${name}_`.padEnd(40, "0");
const T = {
  owner: tok("owner"),
  ownerTeamTier: tok("ownerteam"),
  ownerReadOnly: tok("ownerread"),
  editor: tok("editor"),
  sharedOwner: tok("sharedowner"),
  other: tok("other"),
};

function binding(bucket) {
  return {
    provider: "s3",
    status: "active",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: "AKIAEXAMPLEEXAMPLEAA",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEAA",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
  };
}

const message = (id, at, extra = {}) => ({ v: 1, kind: "message", id, chat: "chat-ada", at, me: false, from: "+15550100100", text: `text ${id}`, service: "iMessage", ...extra });
const BATCH = {
  v: 1,
  records: [
    { v: 1, kind: "chat", id: "chat-ada", name: "Ada", members: ["+15550100100"], service: "iMessage" },
    { v: 1, kind: "person", handle: "+15550100100", name: "Ada Example" },
    message("m-1", "2026-10-21T09:00:00.000Z"),
    message("m-2", "2026-09-30T23:59:59.000Z", { me: true, from: "+15550100199" }),
    { v: 1, kind: "reaction", id: "r-1", chat: "chat-ada", at: "2026-10-21T09:01:00.000Z", me: true, target: "m-1", reaction: "loved" },
  ],
};

async function setUp() {
  const s3 = createS3Backend(S3_ENDPOINT);
  const controlPlane = createControlPlaneStub();
  const restores = [s3.install(), controlPlane.install()];
  controlPlane.addWorkspace("ws_mb_mine", "mbmine", binding("mb-mine"));
  controlPlane.addWorkspace("ws_mb_shared", "mbshared", binding("mb-shared"), { kind: "shared" });
  controlPlane.addWorkspace("ws_mb_other", "mbother", binding("mb-other"));
  const all = ["context:read", "context:write", "context:private"];
  const grant = (accessToken, workspaceId, role, scopes, userId) =>
    controlPlane.addGrant({ accessToken, workspaceId, role, scopes, clientId: "context_desktop", clientName: "Context for Mac", userId });
  await grant(T.owner, "ws_mb_mine", "owner", all, "user_mine");
  await grant(T.ownerTeamTier, "ws_mb_mine", "owner", ["context:read", "context:write"], "user_mine");
  await grant(T.ownerReadOnly, "ws_mb_mine", "owner", ["context:read", "context:private"], "user_mine");
  await grant(T.editor, "ws_mb_mine", "editor", all, "user_editor");
  await grant(T.sharedOwner, "ws_mb_shared", "owner", all, "user_mine");
  await grant(T.other, "ws_mb_other", "owner", all, "user_other");
  const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };
  return {
    env,
    keys: (name) => [...s3.bucketFor(name).keys()].filter((key) => key.startsWith(".context/messages/")).sort(),
    body: (name, key) => s3.bucketFor(name).get(key)?.body,
    restore: () => {
      for (const restore of restores.reverse()) restore();
    },
  };
}

async function post(world, token, body, { path = "/messages/imessage/batch", method = "POST" } = {}) {
  const { ctx, settle } = createWorkerCtx();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await worker.fetch(
    new Request(`https://gateway.test${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    }),
    world.env,
    ctx,
  );
  const text = await response.text();
  await settle();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

const lines = (text) => (text ?? "").split("\n").filter(Boolean).map((line) => JSON.parse(line));

test("the owner's batch lands in their own bucket, grouped by month, chats and people", async () => {
  const world = await setUp();
  try {
    const answer = await post(world, T.owner, BATCH);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { ok: true, kept: 5, dropped: 0 });
    const keys = world.keys("mb-mine");
    const groups = keys.map((key) => key.slice(MESSAGES_BACKUP_LOG.length, key.lastIndexOf("/")));
    assert.deepEqual(groups, ["2026/09", "2026/10", "chats", "people"]);
    const october = lines(world.body("mb-mine", keys[1]));
    assert.deepEqual(october.map(recordKey), ["message:m-1", "reaction:r-1"]);
    const september = lines(world.body("mb-mine", keys[0]));
    assert.equal(september[0].from, undefined, "a message of mine names no sender");
    assert.deepEqual(world.keys("mb-other"), [], "nothing reaches another context's bucket");
    assert.deepEqual(world.keys("mb-shared"), []);
  } finally {
    world.restore();
  }
});

test("a batch sent twice is a second object, and folds to the same records", async () => {
  const world = await setUp();
  try {
    await post(world, T.owner, BATCH);
    await post(world, T.owner, BATCH);
    const fold = new Map();
    for (const key of world.keys("mb-mine")) for (const record of lines(world.body("mb-mine", key))) fold.set(recordKey(record), record);
    assert.equal(world.keys("mb-mine").length, 8);
    assert.equal(fold.size, 5);
  } finally {
    world.restore();
  }
});

test("only the contract is written: a field it does not name never reaches the bucket", async () => {
  const world = await setUp();
  try {
    const leaky = { v: 1, records: [message("m-9", "2026-10-21T10:00:00.000Z", { path: "/Users/someone/Library/Messages/Attachments/x.jpg", secret: "nope" })] };
    assert.equal((await post(world, T.owner, leaky)).status, 200);
    const [key] = world.keys("mb-mine");
    const text = world.body("mb-mine", key);
    assert.ok(!text.includes("/Users/") && !text.includes("nope"), text);
  } finally {
    world.restore();
  }
});

test("everyone but the owner of a personal workspace on a private write grant is refused, and nothing is written", async () => {
  const world = await setUp();
  try {
    for (const [who, token] of [
      ["an editor of somebody's personal workspace", T.editor],
      ["the owner of a shared workspace", T.sharedOwner],
      ["the owner on a team-tier grant", T.ownerTeamTier],
      ["the owner on a read-only grant", T.ownerReadOnly],
    ]) {
      const answer = await post(world, token, BATCH);
      assert.equal(answer.status, 403, who);
    }
    assert.equal((await post(world, null, BATCH)).status, 401, "no token");
    for (const name of ["mb-mine", "mb-shared", "mb-other"]) assert.deepEqual(world.keys(name), [], name);
  } finally {
    world.restore();
  }
});

test("an @name selector is refused, even naming the caller's own workspace", async () => {
  const world = await setUp();
  try {
    for (const slug of ["mbmine", "mbother", "mbshared"]) {
      const answer = await post(world, T.owner, BATCH, { path: `/@${slug}/messages/imessage/batch` });
      assert.ok(answer.status === 403 || answer.status === 404, `${slug}: ${answer.status}`);
    }
    for (const name of ["mb-mine", "mb-shared", "mb-other"]) assert.deepEqual(world.keys(name), [], name);
  } finally {
    world.restore();
  }
});

test("a body the contract refuses is a 400 or 413, and nothing is written", async () => {
  const world = await setUp();
  try {
    assert.equal((await post(world, T.owner, "{not json")).status, 400);
    assert.equal((await post(world, T.owner, { v: 2, records: BATCH.records })).status, 400);
    assert.equal((await post(world, T.owner, { v: 1, records: [] })).status, 400);
    const many = Array.from({ length: LIMITS.records + 1 }, (_, i) => message(`m-${i}`, "2026-10-21T09:00:00.000Z"));
    assert.equal((await post(world, T.owner, { v: 1, records: many })).status, 413);
    const huge = { v: 1, records: [message("m-big", "2026-10-21T09:00:00.000Z")], pad: "x".repeat(LIMITS.bodyBytes) };
    assert.equal((await post(world, T.owner, huge)).status, 413);
    assert.equal((await post(world, T.owner, null, { method: "GET" })).status, 405);
    assert.deepEqual(world.keys("mb-mine"), []);
  } finally {
    world.restore();
  }
});

test("a failed write never answers ok, because the Mac moves its cursor on ok", async () => {
  const store = { put: async () => { throw new Error("bucket down"); } };
  const response = await handleMessagesBackup(new Request("https://gateway.test/messages/imessage/batch", { method: "POST", body: JSON.stringify(BATCH) }), store);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.notEqual(body.ok, true);
});

test("the refusal is read from the session alone", () => {
  const owner = { workspaceKind: "personal", role: "owner", scope: "private", scopes: ["context:read", "context:write", "context:private"] };
  assert.equal(messagesBackupRefusal(owner, null), null);
  assert.equal(messagesBackupRefusal({ ...owner, workspaceKind: "shared" }, null)?.status, 403);
  assert.equal(messagesBackupRefusal({ ...owner, role: "editor" }, null)?.status, 403);
  assert.equal(messagesBackupRefusal({ ...owner, scope: "team" }, null)?.status, 403);
  assert.equal(messagesBackupRefusal({ ...owner, scopes: ["context:read", "context:private"] }, null)?.status, 403);
  assert.equal(messagesBackupRefusal(owner, "mbmine")?.status, 404);
  assert.equal(messagesBackupRefusal(null, null)?.status, 403);
});

test("each record kind has one group", () => {
  assert.equal(groupOf({ kind: "message", at: "2026-01-02T00:00:00.000Z" }), "2026/01");
  assert.equal(groupOf({ kind: "reaction", at: "2025-12-31T23:59:59.000Z" }), "2025/12");
  assert.equal(groupOf({ kind: "chat" }), "chats");
  assert.equal(groupOf({ kind: "person" }), "people");
});

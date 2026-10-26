/**
 * THE MESSAGES BACKUP'S FILES, AND WHAT AN UNSEND TAKES BACK
 * (`src/communications/messagesBackupFiles.js`).
 *
 * Wired end to end as `messagesBackup.test.mjs` is: the worker, the control
 * plane's contract, and a bucket that answers as S3 does.
 *
 *  1. **A file is written where only the owner's batch could be**, under the
 *     same refusal, and at a key built from two digests and nothing else.
 *  2. **Nothing over 25 MB is kept**, whatever the request says its length is.
 *  3. **An unsent message keeps nothing**: its files are deleted, and its words
 *     are taken out of every earlier batch, while every other line stays.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted (2026-10-26). Counts are failing
 * tests in this file.
 *
 *   route: file path not counted as the backup route (no refusal)       3
 *   handler: size limit read from Content-Length only                   1
 *   forgetUnsent: files folder not emptied                              1
 *   forgetUnsent: earlier lines kept                                    2
 *   withoutEarlierCopies: the unsent record itself dropped              2
 *   handleMessagesBackup: forgetUnsent failure answered ok              1
 *
 * Fake names, numbers and credentials only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { createControlPlaneStub, createS3Backend, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import { handleMessagesBackup, MESSAGES_BACKUP_LOG } from "../src/communications/messagesBackup.js";
import { handleMessagesBackupFile, withoutEarlierCopies } from "../src/communications/messagesBackupFiles.js";
import { BACKUP_PREFIX, LIMITS, digestId, fileKeyOf } from "../../../packages/communications/src/backup.js";

const S3_ENDPOINT = "https://s3.example-messages-files.test";
const tok = (name) => `cat_msgfiles_${name}_`.padEnd(40, "0");
const T = { owner: tok("owner"), editor: tok("editor"), sharedOwner: tok("sharedowner"), teamTier: tok("teamtier") };
const FILE = "0123456789abcdef0123456789abcdef";

function binding(bucket) {
  return {
    provider: "s3",
    status: "active",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: "AKIAEXAMPLEEXAMPLEBB",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEBB",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
  };
}

const message = (id, at, extra = {}) => ({ v: 1, kind: "message", id, chat: "chat-ada", at, me: false, from: "+15550100100", text: `words of ${id}`, service: "iMessage", ...extra });

async function setUp() {
  const s3 = createS3Backend(S3_ENDPOINT);
  const controlPlane = createControlPlaneStub();
  const restores = [s3.install(), controlPlane.install()];
  controlPlane.addWorkspace("ws_mf_mine", "mfmine", binding("mf-mine"));
  controlPlane.addWorkspace("ws_mf_shared", "mfshared", binding("mf-shared"), { kind: "shared" });
  const all = ["context:read", "context:write", "context:private"];
  const grant = (accessToken, workspaceId, role, scopes, userId) =>
    controlPlane.addGrant({ accessToken, workspaceId, role, scopes, clientId: "context_desktop", clientName: "Context for Mac", userId });
  await grant(T.owner, "ws_mf_mine", "owner", all, "user_mine");
  await grant(T.editor, "ws_mf_mine", "editor", all, "user_editor");
  await grant(T.sharedOwner, "ws_mf_shared", "owner", all, "user_mine");
  await grant(T.teamTier, "ws_mf_mine", "owner", ["context:read", "context:write"], "user_mine");
  return {
    env: { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET },
    keys: (name, prefix = BACKUP_PREFIX) => [...s3.bucketFor(name).keys()].filter((key) => key.startsWith(prefix)).sort(),
    body: (name, key) => s3.bucketFor(name).get(key)?.body,
    restore: () => {
      for (const restore of restores.reverse()) restore();
    },
  };
}

async function send(world, token, path, body, headers = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request(`https://gateway.test${path}`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body,
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

const batch = (records) => JSON.stringify({ v: 1, records });

test("the owner's file lands under its message's folder, as bytes nobody's browser runs", async () => {
  const world = await setUp();
  try {
    const folder = await digestId("m-1");
    const answer = await send(world, T.owner, `/messages/imessage/file/${folder}/${FILE}`, new TextEncoder().encode("picture bytes"));
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { ok: true, bytes: 13 });
    assert.deepEqual(world.keys("mf-mine"), [fileKeyOf(folder, FILE)]);
    assert.equal(world.body("mf-mine", fileKeyOf(folder, FILE)), "picture bytes");

    const again = await send(world, T.owner, `/messages/imessage/file/${folder}/${FILE}`, new TextEncoder().encode("picture bytes"));
    assert.equal(again.status, 200);
    assert.equal(world.keys("mf-mine").length, 1, "the same file sent twice is one object");
  } finally {
    world.restore();
  }
});

test("everyone the batch route refuses is refused a file too, and nothing is written", async () => {
  const world = await setUp();
  try {
    const folder = await digestId("m-1");
    const path = `/messages/imessage/file/${folder}/${FILE}`;
    for (const [who, token] of [["an editor", T.editor], ["a shared workspace's owner", T.sharedOwner], ["a team-tier grant", T.teamTier]]) {
      assert.equal((await send(world, token, path, "x")).status, 403, who);
    }
    assert.equal((await send(world, null, path, "x")).status, 401);
    const named = await send(world, T.owner, `/@mfmine${path}`, "x");
    assert.ok(named.status === 403 || named.status === 404, String(named.status));
    assert.deepEqual(world.keys("mf-mine"), []);
    assert.deepEqual(world.keys("mf-shared"), []);
  } finally {
    world.restore();
  }
});

test("a path under the file route that is not two digests writes nothing", async () => {
  const world = await setUp();
  try {
    const folder = await digestId("m-1");
    for (const path of [
      `/messages/imessage/file/${folder}`,
      `/messages/imessage/file/${folder}/${FILE}/x`,
      `/messages/imessage/file/${folder}/..%2F..%2Fnotes`,
      `/messages/imessage/file/../../notes/${FILE}`,
      `/messages/imessage/file/${folder}/${FILE.toUpperCase()}`,
    ]) {
      const answer = await send(world, T.owner, path, "x");
      assert.ok(answer.status >= 400 && answer.status < 500, `${path}: ${answer.status}`);
    }
    assert.deepEqual(world.keys("mf-mine", ""), []);
  } finally {
    world.restore();
  }
});

test("a file over 25 MB is refused, even one that does not say how long it is", async () => {
  const folder = await digestId("m-1");
  const writes = [];
  const store = { put: async (key) => writes.push(key) };
  const declared = await handleMessagesBackupFile(
    new Request("https://gateway.test/x", { method: "POST", headers: { "Content-Length": String(LIMITS.fileBytes + 1) }, body: "x" }),
    store,
    { folder, id: FILE },
  );
  assert.equal(declared.status, 413);
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (sent > LIMITS.fileBytes) return controller.close();
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const undeclared = await handleMessagesBackupFile(new Request("https://gateway.test/x", { method: "POST", body: stream, duplex: "half" }), store, { folder, id: FILE });
  assert.equal(undeclared.status, 413);
  const empty = await handleMessagesBackupFile(new Request("https://gateway.test/x", { method: "POST", body: "" }), store, { folder, id: FILE });
  assert.equal(empty.status, 400);
  assert.deepEqual(writes, []);
});

test("an unsend takes back the words in earlier batches and the files, and nothing else", async () => {
  const world = await setUp();
  try {
    const sentAt = new Date(Date.now() - 60_000).toISOString();
    const first = await send(world, T.owner, "/messages/imessage/batch", batch([message("m-1", sentAt), message("m-2", sentAt)]), { "Content-Type": "application/json" });
    assert.equal(first.status, 200);
    const folder = await digestId("m-1");
    await send(world, T.owner, `/messages/imessage/file/${folder}/${FILE}`, "picture bytes");
    const other = await digestId("m-2");
    await send(world, T.owner, `/messages/imessage/file/${other}/${FILE}`, "another picture");

    const unsend = await send(world, T.owner, "/messages/imessage/batch", batch([message("m-1", sentAt, { unsent: true, text: "" })]), { "Content-Type": "application/json" });
    assert.equal(unsend.status, 200);

    const log = world.keys("mf-mine", MESSAGES_BACKUP_LOG).map((key) => world.body("mf-mine", key)).join("\n");
    assert.ok(!log.includes("words of m-1"), "the unsent words are gone from every batch");
    assert.ok(log.includes("words of m-2"), "a neighbour's words stay");
    assert.ok(log.includes('"unsent":true'), "the unsent record itself stays");
    // A delete leaves a marker where the bucket allows one (`store/logicalDelete.js`): the bytes are what must go.
    assert.ok(!(world.body("mf-mine", fileKeyOf(folder, FILE)) ?? "").includes("picture bytes"), "the unsent message's file is gone");
    assert.equal(world.body("mf-mine", fileKeyOf(other, FILE)), "another picture", "another message's file stays");
  } finally {
    world.restore();
  }
});

test("only earlier copies of the unsent messages leave a log object", () => {
  const text = [
    JSON.stringify(message("m-1", "2026-10-21T09:00:00.000Z")),
    JSON.stringify(message("m-1", "2026-10-21T09:00:00.000Z", { unsent: true, text: "" })),
    JSON.stringify(message("m-2", "2026-10-21T09:00:00.000Z")),
    JSON.stringify({ v: 1, kind: "reaction", id: "m-1", chat: "c", at: "2026-10-21T09:00:00.000Z", me: true, target: "m-2", reaction: "liked" }),
    "",
  ].join("\n");
  const next = withoutEarlierCopies(text, new Set(["m-1"]));
  const records = next.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(records.map((r) => `${r.kind}:${r.id}:${r.unsent === true}`), ["message:m-1:true", "message:m-2:false", "reaction:m-1:false"]);
  assert.equal(withoutEarlierCopies(JSON.stringify(message("m-2", "2026-10-21T09:00:00.000Z")), new Set(["m-1"])), null, "an object without them is left alone");
});

test("an unsend that could not be finished never answers ok", async () => {
  const objects = new Map();
  const store = {
    put: async (key, value) => objects.set(key, value),
    list: async () => {
      throw new Error("bucket down");
    },
  };
  const response = await handleMessagesBackup(
    new Request("https://gateway.test/messages/imessage/batch", { method: "POST", body: batch([message("m-1", "2026-10-21T09:00:00.000Z", { unsent: true })]) }),
    store,
  );
  assert.equal(response.status, 503);
  assert.notEqual((await response.json()).ok, true);
});

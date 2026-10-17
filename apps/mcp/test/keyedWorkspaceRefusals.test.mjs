/**
 * The gateway's path-based operations in a KEYED workspace
 * (`store/idLayout.js`, `docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * A keyed note's bytes live only at `notes/<noteId>.md`; the object at its
 * path is a frozen copy nothing reads again. So:
 *  - the whole-bucket rotation walks the tree's names (the layer routes each
 *    to its live bytes), and reports every rewrap it makes to the tree;
 *  - a folder move refuses outright, and so does a move across workspaces
 *    from a store with no control plane to ask (`keyedMoveAcross.test.mjs`);
 *  - a queued materialize refuses when the control plane says the workspace is keyed.
 *
 * Sabotage, each run as a temporary local edit and reverted, and each failing here:
 *  - rotation lists the raw bucket: the note written behind the cursor is skipped,
 *    because the frozen copy at its path still carries the old timestamp;
 *  - drop the folder move's keyed refusal: the dry run and the real move both reach the bucket;
 *  - drop the across-contexts refusal: the keyed source is refused nowhere;
 *  - drop the queue's keyed refusal: the materialize runs on frozen paths;
 *  - make `isKeyedWorkspace` answer false on a failed lookup: the fail-closed cases go quiet.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { withIdLayout, isKeyedWorkspace, KEYED_PATH_REFUSAL } from "../src/store/idLayout.js";
import { toolRotateEncryptionKeys } from "../src/tools/encryption/rotate.js";
import { toolMoveFolder } from "../src/tools/moves/folder.js";
import { toolMoveNoteAcrossContexts } from "../src/tools/moves/acrossContexts.js";
import { handleGatewayJobMessage } from "../src/moves/queueConsumer.js";
import { encryptNote, encryptedNoteKeyId } from "../src/encryption.js";
import { ROTATION_PROGRESS_PATH, saveRotationProgress } from "../src/encryptionKeys/rotation.js";

const KEY_1 = "MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTE=";
const KEY_2 = Buffer.alloc(32, 0x32).toString("base64");
const WORKSPACE = "ws_keyed";
const NOTE_ID = "0192f1a2-3b4c-7d5e-8f60-0000000000aa";
const KEY = `notes/${NOTE_ID}.md`;
const PATH = "1-projects/a.md";

/* ------------------------------ fixtures ------------------------------- */

/** A bucket of raw objects, as the gateway's store seam sees one. Lists its keys in order. */
function bucket() {
  const log = [];
  const objects = new Map();
  let counter = 0;
  const text = async (body) => (typeof body === "string" ? body : new TextDecoder().decode(body));
  return {
    log,
    objects,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false },
    async get(key) {
      log.push(["get", key]);
      const value = objects.get(key);
      if (!value) return null;
      const bytes = new TextEncoder().encode(value.body);
      return { etag: value.etag, size: bytes.byteLength, text: async () => value.body, arrayBuffer: async () => bytes.buffer.slice(0) };
    },
    async head(key) {
      log.push(["head", key]);
      const value = objects.get(key);
      return value ? { etag: value.etag, size: value.body.length } : null;
    },
    async exists(key) {
      log.push(["exists", key]);
      return objects.has(key);
    },
    async put(key, body, options = {}) {
      log.push(["put", key]);
      const existing = objects.get(key);
      if (options.onlyIf?.absent === true && existing) return null;
      if (options.onlyIf?.etagMatches !== undefined && existing?.etag !== options.onlyIf.etagMatches) return null;
      const etag = `e${++counter}`;
      objects.set(key, { body: await text(body), etag });
      return { etag };
    },
    async copy(source, destination) {
      log.push(["copy", source, destination]);
      return null;
    },
    async delete(key) {
      log.push(["delete", key]);
      objects.delete(key);
    },
    async list({ prefix = "" } = {}) {
      log.push(["list", prefix]);
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      return { objects: keys.map((key) => ({ key, etag: objects.get(key).etag, size: objects.get(key).body.length, uploaded: new Date(0) })), truncated: false };
    },
  };
}

const writes = (store) => store.log.filter(([op]) => op === "put" || op === "delete" || op === "copy");

/**
 * The control plane for one keyed workspace: its rows, and every call in order.
 * `keyed` is what the lookup says about the workspace; `rows` are the tree's notes.
 */
function controlPlaneOver(rows, { keyed = true } = {}) {
  const calls = [];
  return {
    calls,
    hooks: {
      mode: "keys",
      lookup: async (paths) => {
        calls.push(["lookup", paths]);
        return {
          copies: {},
          keyed,
          notes: Object.fromEntries(paths.filter((path) => rows[path]).map((path) => [path, rows[path]])),
        };
      },
      wrote: async (record) => {
        calls.push(["wrote", record]);
        const row = rows[record.path];
        if (row?.state === "keyed") rows[record.path] = { ...row, etag: record.etag };
        return { recorded: true };
      },
      adopt: async () => ({ adopted: false, taken: null }),
      removed: async () => ({ removed: true }),
      now: () => 1_700_000_000_000,
    },
  };
}

/** A keyed workspace: the live note at its key (rotated under k1), and a frozen copy still at its path. */
async function keyedWorkspace({ keyed = true } = {}) {
  const raw = bucket();
  const live = await encryptNote("keyed body\n", { workspaceId: WORKSPACE, workspaceKey: KEY_1, keyId: "k1" });
  const frozen = await encryptNote("frozen body\n", { workspaceId: WORKSPACE, workspaceKey: KEY_1, keyId: "k1" });
  const atKey = await raw.put(KEY, live);
  await raw.put(PATH, frozen);
  raw.log.length = 0;
  const rows = { [PATH]: { state: "keyed", key: KEY, etag: atKey.etag, noteId: NOTE_ID } };
  const cp = controlPlaneOver(rows, { keyed });
  return { raw, cp, rows, frozen, store: withIdLayout(raw, cp.hooks) };
}

/* ------------------------- rotation in a keyed workspace ------------------------- */

test("rotation in a keyed workspace rewraps the live note through its row, and leaves the frozen copy alone", async () => {
  const { raw, cp, frozen, store } = await keyedWorkspace();
  const tree = [{ path: PATH, etag: raw.objects.get(KEY).etag, size: 1, updatedAt: 1 }];
  const rotating = Object.assign(store, {
    encryptionKey: { keys: { k1: KEY_1, k2: KEY_2 } },
    actor: { workspaceId: WORKSPACE },
    rotateEncryptionKeys: async ({ start, complete }) =>
      complete !== undefined
        ? { rotation: null }
        : { encryptionKey: { keys: { k1: KEY_1, k2: KEY_2 } }, rotation: { fromGeneration: "k1", toGeneration: "k2" } },
    treeManifest: async () => ({ served: true, entries: tree, cursor: null }),
    reportTreeTouch: async (touch) => {
      cp.calls.push(["touch", touch]);
    },
  });

  const text = (await toolRotateEncryptionKeys(rotating, "private")).content[0].text;

  assert.match(text, /rotation complete/);
  // The live bytes moved to the new generation, through the layer: the row heard of it.
  assert.equal(encryptedNoteKeyId(raw.objects.get(KEY).body), "k2");
  assert.ok(cp.calls.some(([op, record]) => op === "wrote" && record.path === PATH && record.keyed === true));
  // The frozen copy at the path is never written, and still names the outgoing generation.
  assert.equal(raw.objects.get(PATH).body, frozen);
  assert.equal(encryptedNoteKeyId(raw.objects.get(PATH).body), "k1");
  assert.ok(!writes(raw).some(([, key]) => key === PATH));
});

test("a keyed note written behind the rotation's cursor is re-examined by its row's time, not its frozen copy's", async () => {
  // The walk resumes from a cursor past this note, and the note was written
  // after the walk's last boundary. Its frozen copy at the path still carries
  // the epoch's timestamp; the row carries the write. Only the row shows the write.
  const { raw, store } = await keyedWorkspace();
  const boundary = 1_700_000_000_000;
  await saveRotationProgress(raw, {
    fromGeneration: "k1",
    toGeneration: "k2",
    cursor: PATH,
    confirmedThrough: boundary,
    stuckKeys: [],
    wrote: [],
    etag: undefined,
    newKeyMaterial: KEY_2,
  });
  const tree = [{ path: PATH, etag: raw.objects.get(KEY).etag, size: 1, updatedAt: boundary + 60_000 }];
  const rotating = Object.assign(store, {
    encryptionKey: { keys: { k1: KEY_1, k2: KEY_2 } },
    actor: { workspaceId: WORKSPACE },
    rotateEncryptionKeys: async ({ complete }) =>
      complete !== undefined
        ? { rotation: null }
        : { encryptionKey: { keys: { k1: KEY_1, k2: KEY_2 } }, rotation: { fromGeneration: "k1", toGeneration: "k2" } },
    treeManifest: async () => ({ served: true, entries: tree, cursor: null }),
  });
  await toolRotateEncryptionKeys(rotating, "private");
  assert.equal(encryptedNoteKeyId(raw.objects.get(KEY).body), "k2");
});

test("rotation refuses a keyed workspace whose tree cannot be walked, rather than listing the bucket", async () => {
  const { raw, store } = await keyedWorkspace();
  const rotating = Object.assign(store, {
    encryptionKey: { keys: { k1: KEY_1, k2: KEY_2 } },
    actor: { workspaceId: WORKSPACE },
    rotateEncryptionKeys: async () => ({ encryptionKey: { keys: { k1: KEY_1, k2: KEY_2 } }, rotation: { fromGeneration: "k1", toGeneration: "k2" } }),
  });
  const text = (await toolRotateEncryptionKeys(rotating, "private")).content[0].text;
  assert.equal(text, KEYED_PATH_REFUSAL);
  assert.ok(!raw.log.some(([op]) => op === "list"));
  assert.equal(raw.objects.has(ROTATION_PROGRESS_PATH), false);
});

test("an unkeyed workspace's rotation is unchanged: it still lists the bucket", async () => {
  const { raw, store } = await keyedWorkspace({ keyed: false });
  const rotating = Object.assign(store, {
    encryptionKey: { keys: { k1: KEY_1, k2: KEY_2 } },
    actor: { workspaceId: WORKSPACE },
    rotateEncryptionKeys: async ({ complete }) =>
      complete !== undefined
        ? { rotation: null }
        : { encryptionKey: { keys: { k1: KEY_1, k2: KEY_2 } }, rotation: { fromGeneration: "k1", toGeneration: "k2" } },
  });
  const text = (await toolRotateEncryptionKeys(rotating, "private")).content[0].text;
  assert.match(text, /rotation complete/);
  assert.ok(raw.log.some(([op, prefix]) => op === "list" && prefix === ""));
});

/* --------------------------- folder move and across contexts --------------------------- */

test("a folder move refuses a keyed workspace before listing or writing anything, dry run included", async () => {
  for (const dryRun of [false, true]) {
    const { raw, store } = await keyedWorkspace();
    const result = await toolMoveFolder(store, "private", { rules: [] }, [], "1-projects", "2-areas/projects", dryRun);
    assert.equal(result.content[0].text, KEYED_PATH_REFUSAL);
    assert.equal(result.isError, true);
    assert.deepEqual(writes(raw), []);
    assert.ok(!raw.log.some(([op]) => op === "list"));
  }
});

test("a move across workspaces refuses when either side is keyed, before reading the source", async () => {
  const source = await keyedWorkspace();
  const destination = await keyedWorkspace({ keyed: false });
  const session = { scope: "private", workspaceId: WORKSPACE };
  const result = await toolMoveNoteAcrossContexts(source.store, session, destination.store, session, PATH, "0-inbox/a.md", undefined, true);
  assert.equal(result.content[0].text, KEYED_PATH_REFUSAL);
  assert.deepEqual(writes(source.raw), []);
  assert.deepEqual(writes(destination.raw), []);
  assert.ok(!source.raw.log.some(([op, key]) => op === "get" && key === PATH));
});

/* ----------------------------- the queued materialize ----------------------------- */

test("a queued materialize is refused, and reported failed, when its workspace is keyed", async () => {
  const reports = [];
  let materialized = false;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}");
    if (String(url).endsWith("/gateway/jobs/open")) {
      return new Response(JSON.stringify({
        job: {
          job: { workspaceId: WORKSPACE, actorUserId: "user_1", actorClientId: "client_1", grantId: "grant_1", kind: "materialize_move", moveId: "m1" },
          keyed: true,
          binding: { workspaceId: WORKSPACE, provider: "r2-binding" },
        },
      }), { headers: { "content-type": "application/json" } });
    }
    if (String(url).endsWith("/gateway/jobs/report")) reports.push(body.result);
    return new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } });
  };
  try {
    await handleGatewayJobMessage(
      { body: { ticket: "opaque-ticket" }, retry: () => assert.fail("a refused job is not retried") },
      { CONTROL_PLANE_URL: "https://control-plane.test", GATEWAY_SECRET: "test-secret" },
      { materialize: async () => { materialized = true; return { content: [{ type: "text", text: "" }] }; } },
    );
  } finally {
    globalThis.fetch = oldFetch;
  }
  assert.equal(materialized, false);
  assert.deepEqual(reports, [{ status: "failed", error: KEYED_PATH_REFUSAL }]);
});

/* ------------------------------- the question itself ------------------------------- */

test("a failed keyed question fails closed: the refusal is not answered as an unkeyed workspace", async () => {
  const { raw, cp, store } = await keyedWorkspace();
  const failing = withIdLayout(raw, {
    ...cp.hooks,
    lookup: async () => {
      throw new Error("control plane down");
    },
  });
  await assert.rejects(isKeyedWorkspace(failing), /control plane down/);
  void store;
});

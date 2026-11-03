/**
 * BULK NOTES, AND A SAVE THAT DOES NOT WAIT FOR THE CHAOS SCORE (2026-11-03).
 *
 * The owner benchmarked 100 notes one call at a time and asked for bulk reads,
 * bulk writes and saves near 0.1 s. This pins:
 *
 *  1. `write` action `save_many` saves every note it names, one outcome line
 *     each, in order, and the notes read back.
 *  2. One note refused (a stale etag) is reported beside the ones that saved.
 *  3. Each note passes the ordinary write gate: a read-only grant saves none.
 *  4. A malformed list (a path twice, more than 100) saves nothing.
 *  5. `fetch` `notes:` takes 100 paths, and refuses 101.
 *  6. No write starts a chaos rescore or answers with a chaos line (the owner,
 *     2026-11-03): `orient` alone reports the score.
 *  7. A call that runs out of time stops starting saves and names each note it
 *     did not start, so the caller can send just those again.
 *
 * Sabotage-checked (2026-11-03): handing each note straight to the handler
 * with a write scope, past `callToolForSession`, fails 3; dropping the
 * duplicate check fails 4; `READ_NOTES_MAX` back at 25 fails 5; starting the
 * rescore on a write again fails 6; dropping the time check fails 7.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTROL_PLANE_ORIGIN,
  DESCRIPTOR,
  GATEWAY_SECRET,
  PRIVACY_MANIFEST,
  S3_ENDPOINT,
  createControlPlaneStub,
  createD1Backend,
  createS3Backend,
  createWorkerCtx,
  s3Binding,
  worker,
} from "./searchProjection/fixtures.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";
import { SAVE_MANY_MAX, saveMany } from "../src/tools/v2/saveMany.js";
import { READ_NOTES_MAX } from "../src/tools/notes/read.js";

const TOKEN = `cat_bulk_${"0".repeat(28)}`;
const READ_ONLY = `cat_bulk_ro_${"0".repeat(25)}`;
const WS = "ws_bulk";

async function setUp() {
  const s3 = createS3Backend(S3_ENDPOINT);
  const d1 = createD1Backend();
  const controlPlane = createControlPlaneStub();
  const restores = [s3.install(), d1.install(), controlPlane.install()];
  controlPlane.serveTreesFrom(null, { s3 });
  controlPlane.addWorkspace(WS, "bulk", s3Binding("bulk-bucket", { ...DESCRIPTOR, state: "ready" }));
  await controlPlane.addGrant({
    accessToken: TOKEN,
    workspaceId: WS,
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_bulk",
    userId: "user_bulk",
  });
  await controlPlane.addGrant({
    accessToken: READ_ONLY,
    workspaceId: WS,
    role: "owner",
    scopes: ["context:read", "context:private"],
    clientId: "mcp_client_bulk_ro",
    userId: "user_bulk",
  });
  const bucket = s3.bucketFor("bulk-bucket");
  bucket.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "p0" });
  bucket.set("1-projects/plan.md", { body: "# Plan\n", etag: "e-plan" });
  return {
    controlPlane,
    bucket,
    restore: () => {
      for (const restore of restores.reverse()) restore();
      d1.close();
    },
  };
}

const ENV = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET };

async function call(name, args, token = TOKEN, timing = {}) {
  const harness = createWorkerCtx();
  const started = Date.now();
  const response = await worker.fetch(
    new Request("https://gateway.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    ENV,
    harness.ctx,
  );
  const body = await response.json();
  // The answer's time, before the work it left behind (`ctx.waitUntil`) is settled.
  timing.answeredMs = Date.now() - started;
  await harness.settle();
  return body.result;
}

const textOf = (result) => (result?.content ?? []).map((part) => part.text ?? "").join("\n");
const outcomes = (result) => /* the per-note lines, then the call's own */

  textOf(result)
    .split("\n")
    .filter((line) => line.startsWith("outcome: "))
    .map((line) => JSON.parse(line.slice("outcome: ".length)));

test("save_many saves every note, one outcome line each, in order", async () => {
  const { restore } = await setUp();
  try {
    const notes = ["a", "b", "c"].map((name) => ({ path: `0-inbox/bulk/${name}.md`, content: `# ${name}\n` }));
    const result = await call("write", { action: "save_many", args: { notes } });
    assert.ok(!result.isError, textOf(result));
    assert.match(textOf(result), /^3 of 3 notes saved/);
    const lines = outcomes(result);
    assert.deepEqual(
      lines.slice(0, -1).map((outcome) => [outcome.applied, outcome.path]),
      notes.map((note) => [true, note.path]),
    );
    assert.deepEqual(lines.at(-1), { applied: true, saved: 3, failed: 0 });
    assert.equal(result.ownOutcome, undefined);
    for (const note of notes) {
      const read = await call("fetch", { id: note.path });
      assert.match(textOf(read), new RegExp(`# ${note.path.slice(-4, -3)}`));
    }
  } finally {
    restore();
  }
});

test("a note refused in save_many is reported beside the ones that saved", async () => {
  const { restore } = await setUp();
  try {
    const result = await call("write", {
      action: "save_many",
      args: {
        notes: [
          { path: "0-inbox/bulk/new.md", content: "# New\n" },
          { path: "1-projects/plan.md", content: "# Plan, changed\n", expected_etag: "not-the-etag" },
        ],
      },
    });
    assert.ok(!result.isError, textOf(result));
    assert.match(textOf(result), /^1 of 2 notes saved/);
    const [saved, refused] = outcomes(result);
    assert.equal(saved.applied, true);
    assert.equal(refused.applied, false);
    assert.match(textOf(await call("fetch", { id: "1-projects/plan.md" })), /# Plan\n/);
  } finally {
    restore();
  }
});

test("each note in save_many passes the write gate: a read-only grant saves none", async () => {
  const { restore, bucket } = await setUp();
  try {
    const result = await call(
      "write",
      { action: "save_many", args: { notes: [{ path: "0-inbox/bulk/ro.md", content: "# no\n" }] } },
      READ_ONLY,
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), /0 of 1 notes saved/);
    assert.match(textOf(result), /read-only/);
    assert.equal(bucket.get?.("0-inbox/bulk/ro.md") ?? null, null);
    const read = await call("fetch", { id: "0-inbox/bulk/ro.md" });
    assert.match(textOf(read), /not found/);
  } finally {
    restore();
  }
});

test("a malformed save_many list saves nothing", async () => {
  const { restore } = await setUp();
  try {
    const twice = await call("write", {
      action: "save_many",
      args: {
        notes: [
          { path: "0-inbox/bulk/twice.md", content: "# one\n" },
          { path: "0-inbox/bulk/twice.md", content: "# two\n" },
        ],
      },
    });
    assert.equal(twice.isError, true);
    assert.match(textOf(twice), /twice/);
    assert.match(textOf(await call("fetch", { id: "0-inbox/bulk/twice.md" })), /not found/);

    const many = Array.from({ length: SAVE_MANY_MAX + 1 }, (_, index) => ({ path: `0-inbox/bulk/n${index}.md`, content: "x\n" }));
    const tooMany = await call("write", { action: "save_many", args: { notes: many } });
    assert.equal(tooMany.isError, true);
    assert.match(textOf(tooMany), /at most 100/);
    assert.match(textOf(await call("fetch", { id: "0-inbox/bulk/n0.md" })), /not found/);

    // Only `write` action `save_many` reaches it: the carrier's own name is no tool a client may call.
    const direct = await call("write_notes", { notes: [{ path: "0-inbox/bulk/direct.md", content: "x\n" }] });
    assert.equal(direct.isError, true);
    assert.match(textOf(await call("fetch", { id: "0-inbox/bulk/direct.md" })), /not found/);

    const extra = await call("write", { action: "save_many", args: { notes: [{ path: "0-inbox/bulk/x.md", content: "x\n", visibility: "team" }] } });
    assert.equal(extra.isError, true);
    assert.match(textOf(extra), /takes only path, content and expected_etag/);
  } finally {
    restore();
  }
});

test("fetch notes: reads 100 paths in one call, and refuses 101", async () => {
  const { restore, bucket } = await setUp();
  try {
    assert.equal(READ_NOTES_MAX, 100);
    const paths = Array.from({ length: READ_NOTES_MAX }, (_, index) => `0-inbox/many/n${index}.md`);
    for (const [index, path] of paths.entries()) bucket.set(path, { body: `# n${index}\n`, etag: `e${index}` });
    const read = await call("fetch", { id: "notes:", args: { paths } });
    assert.ok(!read.isError, textOf(read).slice(0, 300));
    assert.equal(read.content.length, 100);
    const over = await call("fetch", { id: "notes:", args: { paths: [...paths, "0-inbox/many/extra.md"] } });
    assert.equal(over.isError, true);
  } finally {
    restore();
  }
});

test("no write starts a rescore or answers with a chaos line", async () => {
  const { restore, controlPlane } = await setUp();
  try {
    const chaosAsks = () => controlPlane.treeRequests.filter((request) => request.path === "/gateway/tree/facts" && request.body?.ask === "chaos").length;
    const one = await call("write", { path: "0-inbox/one.md", content: "# One\n" });
    assert.ok(!one.isError, textOf(one));
    assert.doesNotMatch(textOf(one), /^chaos:/m);
    const notes = Array.from({ length: 12 }, (_, index) => ({ path: `0-inbox/quiet/n${index}.md`, content: `# n${index}\n` }));
    const many = await call("write", { action: "save_many", args: { notes } });
    assert.match(textOf(many), /^12 of 12 notes saved/);
    assert.doesNotMatch(textOf(many), /^chaos:/m);
    // Each of these asked for the chaos facts before 2026-11-03 (and does again, sabotaged).
    assert.equal(chaosAsks(), 0);
  } finally {
    restore();
  }
});

test("save_many out of time names the notes it did not start, and starts no more", async () => {
  // A clock that moves 1 s per save started; the budget runs out after the first few.
  let clock = 0;
  const now = () => clock;
  const notes = Array.from({ length: 12 }, (_, index) => ({ path: `0-inbox/t/n${index}.md`, content: "x\n" }));
  const started = [];
  const result = await saveMany({ notes }, async (one) => {
    started.push(one.path);
    clock += 1000;
    return { content: [{ type: "text", text: `written: ${one.path} (etag e)` }] };
  }, { budgetMs: 2500, now });
  const lines = textOf(result).split("\n").filter((line) => line.startsWith("outcome: ")).map((line) => JSON.parse(line.slice(9)));
  assert.equal(lines.length, 12);
  const notStarted = lines.filter((line) => line.error === "NOT_STARTED");
  assert.equal(started.length + notStarted.length, 12);
  assert.ok(notStarted.length > 0, "some notes were left for the next call");
  assert.ok(started.length < 12);
  for (const line of notStarted) assert.ok(!started.includes(line.path));
  assert.match(textOf(result), new RegExp(`^${started.length} of 12 notes saved`));
  assert.deepEqual(result.ownOutcome, { applied: true, saved: started.length, failed: 12 - started.length });
});

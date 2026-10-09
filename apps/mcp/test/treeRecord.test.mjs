/**
 * THE GATEWAY'S WRITES REACH THE TREE TABLE.
 *
 * Wired end to end: a real MCP tool call, the worker's own deferred work, a
 * bucket that answers as S3 does and a database that runs real SQL. What is
 * asked is the thing a sidebar drawn from the table depends on: after an AI
 * client creates, edits or moves a note, does the table say what the bucket
 * says — and does a save that only changes words cost the bucket nothing?
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
import { sweepTreePass } from "../src/tree/sweep.js";
import { createD1Client } from "../src/search/d1/client.js";
import { treeTouchOf } from "../src/tree/record.js";

const TOKEN = `cat_tree_${"0".repeat(28)}`;
const WS = "ws_tree";

async function setUp() {
  const s3 = createS3Backend(S3_ENDPOINT);
  const d1 = createD1Backend();
  const controlPlane = createControlPlaneStub();
  const restores = [s3.install(), d1.install(), controlPlane.install()];
  controlPlane.addWorkspace(WS, "tree", s3Binding("tree-bucket", { ...DESCRIPTOR, state: "ready" }));
  await controlPlane.addGrant({
    accessToken: TOKEN,
    workspaceId: WS,
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_tree",
    userId: "user_tree",
  });
  const bucket = s3.bucketFor("tree-bucket");
  bucket.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "p0" });
  bucket.set("1-projects/plan.md", { body: "# Plan\n", etag: "e-plan" });
  bucket.set("2-areas/old.md", { body: "# Old\n", etag: "e-old" });
  return {
    s3,
    d1,
    bucket,
    restore: () => {
      for (const restore of restores.reverse()) restore();
      d1.close();
    },
  };
}

async function call(name, args) {
  const harness = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://gateway.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET },
    harness.ctx,
  );
  const body = await response.json();
  await harness.settle();
  assert.ok(!body.result?.isError, JSON.stringify(body).slice(0, 400));
  return body;
}

function rows(d1) {
  return d1.rows("SELECT path, etag FROM tree ORDER BY path");
}

test("an AI client's create, edit and move reach the tree table", async () => {
  const world = await setUp();
  try {
    const client = createD1Client({ ...DESCRIPTOR, state: "ready" });
    // The first sweep, as the control plane runs it.
    const sweep = await sweepTreePass(
      { list: (options) => listVia(world.bucket, options) },
      client,
    );
    assert.equal(sweep.complete, true);
    assert.deepEqual(rows(world.d1).map((row) => row.path), ["1-projects/plan.md", "2-areas/old.md", "privacy.md"]);

    await call("write_note", { path: "0-inbox/new.md", content: "# New\n\nHello.\n" });
    assert.ok(rows(world.d1).some((row) => row.path === "0-inbox/new.md"), "created note missing");

    const before = rows(world.d1).find((row) => row.path === "0-inbox/new.md").etag;
    await call("write_note", { path: "0-inbox/new.md", content: "# New\n\nHello again.\n", expected_etag: before });
    const after = rows(world.d1).find((row) => row.path === "0-inbox/new.md").etag;
    assert.notEqual(after, before, "an edit left the old version in the table");

    await call("move_note", { source: "2-areas/old.md", destination: "1-projects/old.md" });
    const listed = rows(world.d1).map((row) => row.path);
    assert.ok(!listed.includes("2-areas/old.md"), "the moved note's old path stayed");
    assert.ok(listed.includes("1-projects/old.md"), "the moved note's new path is missing");
    const left = world.d1.rows("SELECT path, gone, audiences FROM tree_log WHERE path = '2-areas/old.md'");
    assert.deepEqual(left.map((row) => [row.gone, JSON.parse(row.audiences)]), [[1, ["private"]]], "the old path left without saying who saw it");
  } finally {
    world.restore();
  }
});

test("a body save is recorded without listing the bucket", () => {
  assert.equal(treeTouchOf("update_note", ["a.md"], {}), null);
  assert.deepEqual(treeTouchOf("update_note", ["a.md"], { front_matter_changed: true }), { paths: ["a.md"] });
  assert.deepEqual(treeTouchOf("move_note", ["a.md", "b/a.md"], {}), { paths: ["a.md", "b/a.md"] });
  assert.deepEqual(treeTouchOf("move_note", ["a.md", "b/a.md"], { source_visibility: "private" }), {
    paths: ["a.md", "b/a.md"],
    left: [{ path: "a.md", audiences: ["private"] }],
  });
  assert.deepEqual(treeTouchOf("archive_note", ["a.md", "4-archive/a.md"], { source_visibility: "team" }).left, [
    { path: "a.md", audiences: ["private", "team"] },
  ]);
  assert.deepEqual(treeTouchOf("remember_fact", ["0-inbox/memories/x.md"], {}), { files: ["0-inbox/memories/x.md"] });
  assert.equal(treeTouchOf("create_note", [], {}), null);
});

/** S3 semantics over the stub's map, when the stub has no store of its own. */
async function listVia(bucket, { prefix = "", startAfter, cursor, limit = 1000 } = {}) {
  const keys = [...bucket.keys()].filter((key) => key.startsWith(prefix)).sort();
  const after = cursor ?? startAfter;
  const from = after === undefined ? 0 : keys.findIndex((key) => key > after);
  const start = from < 0 ? keys.length : from;
  const page = keys.slice(start, start + limit);
  return {
    objects: page.map((key) => ({ key, etag: bucket.get(key).etag, size: 1 })),
    truncated: start + limit < keys.length,
  };
}

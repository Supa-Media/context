/**
 * THE GATEWAY'S WRITES REACH THE CONVEX TREE, AND NO LONGER THE SEARCH DATABASE'S.
 *
 * Phase 7 of `docs/decisions/app-and-console/convex-tree.md`: the search
 * database keeps the search projection and nothing of the tree. Wired end to
 * end — a real MCP tool call, the worker's own deferred work, a bucket that
 * answers as S3 does and a database that runs real SQL — a write is asked to
 * project its note, write and read no tree row, and drop what an older build
 * left (`tree/retired.js`) without that ever costing the search write. Then
 * which changes the control plane is told to re-check (`treeTouchOf`).
 *
 * Sabotage-checked: putting the retirement back into every retry fails "can
 * never cost the search write"; leaving `tree_chaos` off the list fails the
 * end-to-end check.
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
import { RETIRED_STATE_KEYS, RETIRED_TREE_STATEMENTS } from "../src/tree/retired.js";
import { projectWrittenNoteAfterResponse } from "../src/search/writeProjection.js";
import { CURSOR_KEY } from "../src/search/d1/backfill.js";
import { treeTouchOf } from "../src/tree/record.js";
import { approving } from "./egressApproval.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

const TOKEN = `cat_tree_${"0".repeat(28)}`;
const WS = "ws_tree";

async function setUp() {
  const s3 = createS3Backend(S3_ENDPOINT);
  const d1 = createD1Backend();
  const controlPlane = createControlPlaneStub();
  const restores = [s3.install(), d1.install(), controlPlane.install()];
  controlPlane.serveTreesFrom(null, { s3 });
  controlPlane.addWorkspace(WS, "tree", s3Binding("tree-bucket", { ...DESCRIPTOR, state: "ready" }));
  await controlPlane.addGrant({
    accessToken: TOKEN,
    workspaceId: WS,
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_tree",
    userId: "user_tree",
  });
  await controlPlane.addGrant({
    accessToken: CONSOLE_TOKEN,
    workspaceId: WS,
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "context_console",
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

/** The person's own app, which approves what the gate holds (`egressApproval.mjs`). */
const CONSOLE_TOKEN = `cat_tree_console_${"0".repeat(20)}`;

async function call(name, args) {
  const result = await approving(async () => (await callOnce(name, args)).result, {
    env: { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET },
    consoleToken: CONSOLE_TOKEN,
    origin: "https://gateway.test",
  });
  assert.ok(!result?.isError, JSON.stringify(result).slice(0, 400));
  return { jsonrpc: "2.0", id: 1, result };
}

async function callOnce(name, args) {
  const harness = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://gateway.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET },
    harness.ctx,
  );
  const body = await response.json();
  await harness.settle();
  return body;
}

/** The tables and keys an older build's tree left in the search database. */
const OLD_TABLES = ["tree", "tree_gone", "tree_links", "tree_link_sources", "tree_props", "tree_chaos"];
const OLD_KEYS = ["tree_ready", "tree_swept_at", "tree_links_ready", "tree_props_ready", "chaos_ready", "chaos_daily"];

function seedOldTree(d1) {
  for (const table of OLD_TABLES) d1.db.exec(`CREATE TABLE ${table} (path TEXT PRIMARY KEY)`);
  d1.db.exec("INSERT INTO tree (path) VALUES ('2-areas/old.md')");
  const put = d1.db.prepare("INSERT INTO index_state (key, value) VALUES (?, ?)");
  for (const key of OLD_KEYS) put.run(key, "1");
  // The search backfill's and the history's own keys, which must stay.
  put.run(CURSOR_KEY, "");
  put.run("history_reads_from", "5");
}

const tablesIn = (d1) => d1.rows("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);

test("a write projects the note into search, writes no tree row, and retires the old tree tables", async () => {
  const world = await setUp();
  try {
    seedOldTree(world.d1);
    await call("write_note", { path: "0-inbox/new.md", content: "# New\n\nSee [[old]].\n" });

    assert.ok(world.d1.rows("SELECT path FROM notes").some((row) => row.path === "0-inbox/new.md"), "the note is searchable");
    const sent = world.d1.requests.map((request) => request.sql ?? "").join("\n");
    assert.doesNotMatch(sent, /INSERT (OR IGNORE )?INTO tree(_links|_link_sources|_props|_chaos)?\b/, "a tree row was written");
    assert.doesNotMatch(sent, /FROM tree(_links|_props|_chaos)?\b/, "a tree table was read");
    for (const table of OLD_TABLES) {
      assert.ok(!tablesIn(world.d1).includes(table), `${table} is still there`);
    }
    const keys = world.d1.rows("SELECT key FROM index_state").map((row) => row.key);
    for (const key of OLD_KEYS) assert.ok(!keys.includes(key), `${key} is still there`);
    assert.ok(keys.includes(CURSOR_KEY) && keys.includes("history_reads_from"), "a key the tree never owned was removed");

    // Again, on a database already retired: idempotent, and the edit lands.
    const etag = world.bucket.get("0-inbox/new.md").etag;
    await call("write_note", { path: "0-inbox/new.md", content: "# New\n\nAgain.\n", expected_etag: etag });
    assert.ok(world.d1.rows("SELECT path FROM notes").some((row) => row.path === "0-inbox/new.md"));
  } finally {
    world.restore();
  }
});

test("retiring the tree tables can never cost the search write", async () => {
  const d1 = createD1Backend();
  const restoreD1 = d1.install();
  const inner = globalThis.fetch;
  // A database that fails any request that drops a table: the batch carrying
  // it is one transaction, so the note's own rows go down with it.
  globalThis.fetch = async (input, init) => {
    if (typeof init?.body === "string" && init.body.includes("DROP TABLE")) {
      return new Response(JSON.stringify({ success: false, errors: [{ message: "unavailable" }] }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    return inner(input, init);
  };
  try {
    const store = { searchIndex: { ...DESCRIPTOR, state: "ready" } };
    await projectWrittenNoteAfterResponse(store, {
      path: "1-projects/kept.md",
      content: "# Kept\n\nStill searchable.\n",
      version: "v1",
      visibility: "private",
      meaning: false,
    });
    assert.ok(d1.rows("SELECT path FROM notes").some((row) => row.path === "1-projects/kept.md"));
  } finally {
    globalThis.fetch = inner;
    restoreD1();
    d1.close();
  }
});

test("the retirement names exactly the tree's tables and keys", () => {
  const sql = RETIRED_TREE_STATEMENTS.join("\n");
  for (const table of [...OLD_TABLES, "tree_log"]) assert.match(sql, new RegExp(`DROP TABLE IF EXISTS ${table}\\b`));
  assert.doesNotMatch(sql, /DROP TABLE IF EXISTS (notes|index_state|history)/);
  for (const key of RETIRED_STATE_KEYS) assert.ok(key.startsWith("tree_") || key.startsWith("chaos_"), key);
  assert.ok(!RETIRED_STATE_KEYS.includes(CURSOR_KEY));
});

test("a body save is recorded without listing the bucket", () => {
  assert.equal(treeTouchOf("update_note", ["a.md"], {}), null);
  assert.deepEqual(treeTouchOf("update_note", ["a.md"], { front_matter_changed: true }), { paths: ["a.md"] });
  // A move also pairs old and new, so the chaos score carries what it knew of the note (`chaos/change.js`).
  assert.deepEqual(treeTouchOf("move_note", ["a.md", "b/a.md"], {}), { paths: ["a.md", "b/a.md"], moves: [["a.md", "b/a.md"]] });
  assert.deepEqual(treeTouchOf("move_note", ["a.md", "b/a.md"], { source_visibility: "private" }), {
    paths: ["a.md", "b/a.md"],
    left: [{ path: "a.md", audiences: ["private"] }],
    moves: [["a.md", "b/a.md"]],
  });
  assert.equal(treeTouchOf("move_notes", ["a.md", "b/a.md", "c.md"], { partial: true }).moves, undefined);
  assert.deepEqual(treeTouchOf("archive_note", ["a.md", "4-archive/a.md"], { source_visibility: "team" }).left, [
    { path: "a.md", audiences: ["private", "team"] },
  ]);
  assert.deepEqual(treeTouchOf("remember_fact", ["0-inbox/memories/x.md"], {}), { files: ["0-inbox/memories/x.md"] });
  assert.equal(treeTouchOf("create_note", [], {}), null);
});

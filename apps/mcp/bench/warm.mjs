/**
 * A WARM RUN: EVERY WORKSPACE INDEXED ONCE, THEN CLONED PER CONVERSATION.
 *
 * Decided by the owner, 2026-10-08: the benchmark world starts warm, the way a
 * real workspace is after a day of use. A cold world (`createWorld` with no
 * `prepared`) has no search index at all, so every search is a bucket scan and
 * the first result of 2026-10-08 measured the scan's budget rather than any
 * model. Here each workspace gets a search database on the test suite's D1
 * stand-in (real SQLite), its owner searches it until the projection reports
 * nothing pending, and the bucket (index shards included) and the database are
 * snapshotted. A conversation's world then starts from copies of those, so a
 * turn's write never reaches the next conversation.
 */

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "../test/controlPlaneStub.mjs";
import { createWorkerCtx } from "../test/workerCtx.mjs";
import { DatabaseSync, createD1Backend } from "../test/searchProjection/fixtures.mjs";
import { assertIsoDate, installClock, noonUtcMs, realNow } from "./clock.mjs";
import { S3_ENDPOINT, placeWorkspaces, searchIndexFor } from "./world.mjs";

/** Searches one workspace may take to converge before the run is refused. */
const MAX_WARM_PASSES = 2_000;
const PROGRESS_PATH = "/gateway/search-index/progress";

/**
 * Warm every workspace and snapshot it.
 *
 * @param {object} bench what `readBenchFolder` (or `expandWorkspaces`) returned
 * @param {{ today?: string | null }} [options] the pinned day, as for `createWorld`
 * @returns {Promise<{ buckets: Map<string, Map>, passes: Map<string, number>,
 *   openCopy: Function, close: Function }>}
 */
export async function prepareRun(bench, { today = null } = {}) {
  if (today !== null) assertIsoDate(today);
  if (!DatabaseSync) throw new Error("node:sqlite is needed to warm the benchmark world (Node 22.5 or later)");
  const baseMs = today === null ? realNow() : noonUtcMs(today);
  const dir = mkdtempSync(join(tmpdir(), "bench-warm-"));

  const s3 = createS3Backend(S3_ENDPOINT, { now: () => new Date().toISOString() });
  const controlPlane = createControlPlaneStub();
  const d1 = createD1Backend();
  const restore = [s3.install(), controlPlane.install(), d1.install()];
  if (today !== null) restore.push(installClock(today));
  const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, SEARCH_SUBREQUEST_BUDGET: "600" };

  const buckets = new Map();
  const passes = new Map();
  try {
    const ids = placeWorkspaces(bench, { s3, controlPlane, baseMs, search: "backfilling" });
    for (const [name, id] of ids) {
      const token = `cat_bench_warm_${name.replace(/[^a-z0-9]/g, "")}_${"0".repeat(24)}`;
      await controlPlane.addGrant({
        workspaceId: id,
        role: "owner",
        userId: "user_bench_warm",
        accessToken: token,
        scopes: ["context:read", "context:write", "context:private"],
        clientId: "context_texts",
      });
      let count = 0;
      if (Object.keys(bench.workspaces[name].files).length > 0) {
        for (;;) {
          count += 1;
          await search(token, env);
          const report = controlPlane.calls
            .filter((call) => call.path === PROGRESS_PATH && call.body?.workspaceId === id)
            .at(-1)?.body;
          if (report && report.notesPending === 0 && report.state === "ready") break;
          if (count >= MAX_WARM_PASSES) throw new Error(`${name}: the search index did not converge after ${count} searches`);
        }
      }
      passes.set(name, count);
      buckets.set(name, new Map([...s3.bucketFor(`bench-${name}`)].map(([key, object]) => [key, { ...object }])));
      // The temp dir's name is ours (mkdtemp), so it holds nothing a quote could break.
      d1.dbFor(searchIndexFor(name, "ready").databaseId).exec(`VACUUM INTO '${join(dir, `${name}.db`)}'`);
    }
  } finally {
    for (const undo of restore.reverse()) undo();
    d1.close();
  }

  let copies = 0;
  return {
    today,
    buckets,
    passes,
    /** A fresh copy of a workspace's warmed database, for one conversation. */
    openCopy(databaseId, into = []) {
      const name = [...buckets.keys()].find((workspace) => searchIndexFor(workspace, "ready").databaseId === databaseId);
      if (!name) return undefined;
      const file = join(dir, `${name}-${++copies}.db`);
      copyFileSync(join(dir, `${name}.db`), file);
      into.push(file);
      return new DatabaseSync(file);
    },
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** One `search_notes` through the gateway, deferred index work included. */
async function search(token, env) {
  const { ctx, settle } = createWorkerCtx();
  await worker.fetch(
    new Request("https://mcp.bench.invalid/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_notes", arguments: { query: "warm" } } }),
    }),
    env,
    ctx,
  );
  await settle();
}

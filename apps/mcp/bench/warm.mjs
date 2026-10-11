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
import { createVectorizeBackend, meaningIndexFor } from "../test/vectorizeStub.mjs";
import { ACCOUNT_ID as D1_ACCOUNT_ID } from "../test/searchProjection/fixtures.mjs";
import { bindingEmbedder } from "../src/search/meaning/embed.js";
import { createMeaningClient } from "../src/search/meaning/client.js";
import { meaningChangeFor } from "../src/search/meaning/project.js";
import { S3_ENDPOINT, fixtureVisibility, placeWorkspaces, searchIndexFor } from "./world.mjs";

/** Searches one workspace may take to converge before the run is refused. */
const MAX_WARM_PASSES = 2_000;
const PROGRESS_PATH = "/gateway/search-index/progress";

/**
 * Warm every workspace and snapshot it.
 *
 * @param {object} bench what `readBenchFolder` (or `expandWorkspaces`) returned
 * @param {{ today?: string | null, ai?: object | null }} [options] the pinned
 *   day, as for `createWorld`; and the Workers AI binding that embeds (the
 *   run's `models.ai`). With one, every workspace's meaning index is filled too
 *   (one passage per fingerprint, `src/search/meaning/project.js`) and
 *   snapshotted, so a conversation searches by meaning as production does.
 *   Without one the world has no meaning index, as before 2026-10-10.
 * @returns {Promise<{ buckets: Map<string, Map>, passes: Map<string, number>,
 *   vectors: Map | null, embedded: Map<string, number>, openCopy: Function, close: Function }>}
 */
export async function prepareRun(bench, { today = null, ai = null } = {}) {
  if (today !== null) assertIsoDate(today);
  if (!DatabaseSync) throw new Error("node:sqlite is needed to warm the benchmark world (Node 22.5 or later)");
  const baseMs = today === null ? realNow() : noonUtcMs(today);
  const dir = mkdtempSync(join(tmpdir(), "bench-warm-"));

  const s3 = createS3Backend(S3_ENDPOINT, { now: () => new Date().toISOString() });
  const controlPlane = createControlPlaneStub();
  const d1 = createD1Backend();
  const vectorize = ai ? createVectorizeBackend() : null;
  const restore = [s3.install(), controlPlane.install(), d1.install(), ...(vectorize ? [vectorize.install()] : [])];
  if (today !== null) restore.push(installClock(today));
  const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, SEARCH_SUBREQUEST_BUDGET: "600", ...(ai ? { AI: ai } : {}) };

  const buckets = new Map();
  const passes = new Map();
  const embedded = new Map();
  try {
    const ids = placeWorkspaces(bench, { s3, controlPlane, baseMs, search: "backfilling", meaning: vectorize !== null });
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
      if (vectorize) embedded.set(name, await fillMeaningIndex(bench, name, ai));
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
    /** Each workspace's meaning index, as `createVectorizeBackend` seeds one; null when the run has no embedder. */
    vectors: vectorize ? vectorize.snapshotAll() : null,
    /** Passages embedded per workspace. */
    embedded,
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

/** Notes embedded at once; the catch-up pass's own figure (`meaning/catchup.js`). */
const EMBED_CONCURRENCY = 8;

/**
 * Put every note of one workspace in its meaning index, the way the control
 * plane's catch-up pass does for a real workspace: each note cut into passages
 * (`meaningChangeFor`), fingerprinted by the run's embedder, upserted under
 * the tier its visibility gives it. Returns how many passages went in.
 */
async function fillMeaningIndex(bench, name, ai) {
  const embed = bindingEmbedder(ai);
  const client = createMeaningClient(meaningIndexFor(name, "ready", D1_ACCOUNT_ID));
  const entries = Object.entries(bench.workspaces[name].files);
  const vectors = [];
  for (let start = 0; start < entries.length; start += EMBED_CONCURRENCY) {
    const changes = await Promise.all(
      entries.slice(start, start + EMBED_CONCURRENCY).map(([path, content]) =>
        meaningChangeFor(path, { content, visibility: fixtureVisibility(bench, name, path) }, embed),
      ),
    );
    for (const change of changes) vectors.push(...change.vectors);
  }
  if (vectors.length > 0) await client.upsert(vectors);
  return vectors.length;
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

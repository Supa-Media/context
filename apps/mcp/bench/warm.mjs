/**
 * A WARM RUN: EVERY WORKSPACE INDEXED ONCE, THEN CLONED PER CONVERSATION.
 *
 * Decided by the owner, 2026-10-08: the benchmark world starts warm, the way a
 * real workspace is after a day of use. A cold world (`createWorld` with no
 * `prepared`) has no search index at all, so every search is a bucket scan and
 * the first result of 2026-10-08 measured the scan's budget rather than any
 * model. Here each workspace gets a search database on the test suite's D1
 * stand-in (real SQLite), filled with every note as the control plane fills
 * it, and the bucket and the database are snapshotted. A conversation's world then starts from copies of those, so a
 * turn's write never reaches the next conversation.
 */

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createControlPlaneStub, createS3Backend } from "../test/controlPlaneStub.mjs";
import { DatabaseSync, createD1Backend } from "../test/searchProjection/fixtures.mjs";
import { fillSearchDatabase } from "../test/searchProjection/fill.mjs";
import { assertIsoDate, installClock, noonUtcMs, realNow } from "./clock.mjs";
import { createVectorizeBackend, meaningIndexFor } from "../test/vectorizeStub.mjs";
import { ACCOUNT_ID as D1_ACCOUNT_ID } from "../test/searchProjection/fixtures.mjs";
import { bindingEmbedder } from "../src/search/meaning/embed.js";
import { MeaningError } from "../src/search/meaning/errors.js";
import { createMeaningClient } from "../src/search/meaning/client.js";
import { meaningChangeFor } from "../src/search/meaning/project.js";
import { S3_ENDPOINT, fixtureVisibility, placeWorkspaces, searchIndexFor } from "./world.mjs";

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
 * @returns {Promise<{ buckets: Map<string, Map>, indexed: Map<string, number>,
 *   vectors: Map | null, embedded: Map<string, number>, openCopy: Function, close: Function }>}
 */
export async function prepareRun(bench, { today = null, ai = null, embedWaits = EMBED_WAITS_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (today !== null) assertIsoDate(today);
  if (!DatabaseSync) throw new Error("node:sqlite is needed to warm the benchmark world (Node 22.5 or later)");
  const baseMs = today === null ? realNow() : noonUtcMs(today);
  const dir = mkdtempSync(join(tmpdir(), "bench-warm-"));

  const s3 = createS3Backend(S3_ENDPOINT, { now: () => new Date().toISOString() });
  const controlPlane = createControlPlaneStub();
  // The listing tools list from the Convex tree, copied here from each S3 bucket.
  controlPlane.serveTreesFrom(null, { s3 });
  const d1 = createD1Backend();
  const vectorize = ai ? createVectorizeBackend() : null;
  const restore = [s3.install(), controlPlane.install(), d1.install(), ...(vectorize ? [vectorize.install()] : [])];
  if (today !== null) restore.push(installClock(today));

  const buckets = new Map();
  const indexed = new Map();
  const embedded = new Map();
  try {
    const ids = placeWorkspaces(bench, { s3, controlPlane, baseMs, search: "backfilling", meaning: vectorize !== null });
    for (const name of ids.keys()) {
      // The control plane fills a context's search database, never a search
      // (decided by the owner, 2026-10-17); the same rows, written directly.
      const notes = Object.entries(bench.workspaces[name].files).map(([path, content]) => ({
        path,
        content,
        visibility: fixtureVisibility(bench, name, path),
      }));
      indexed.set(name, fillSearchDatabase(d1.dbFor(searchIndexFor(name, "ready").databaseId), notes));
      if (vectorize) embedded.set(name, await fillMeaningIndex(bench, name, ai, { waits: embedWaits, sleep }));
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
    /** Notes written to each workspace's search database. */
    indexed,
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
 * The waits before a note's embedding is tried again. The model call is
 * already retried inside its 10-second deadline (`cachedEmbeddings`), but a
 * slow model runs out that deadline, and one note that could not be embedded
 * lost the whole shard's conversations (gh-139, 2026-10-31).
 */
export const EMBED_WAITS_MS = [2_000, 8_000];

/**
 * Put every note of one workspace in its meaning index, the way the control
 * plane's catch-up pass does for a real workspace: each note cut into passages
 * (`meaningChangeFor`), fingerprinted by the run's embedder, upserted under
 * the tier its visibility gives it. Returns how many passages went in.
 */
/** The failures worth another try: the model was slow, down or busy. */
const RETRIED = new Set(["UNAVAILABLE", "RATE_LIMITED"]);

async function fillMeaningIndex(bench, name, ai, { waits, sleep }) {
  const once = bindingEmbedder(ai);
  const embed = async (texts) => {
    for (let tried = 0; ; tried += 1) {
      try {
        return await once(texts);
      } catch (error) {
        if (!(error instanceof MeaningError) || !RETRIED.has(error.code) || tried >= waits.length) throw error;
        await sleep(waits[tried]);
      }
    }
  };
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

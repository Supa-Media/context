/**
 * A legacy logical folder move, as an older gateway left it in a bucket.
 *
 * `move_folder` no longer writes `.context/moves/<id>.json`: a folder past the
 * one-go threshold goes through the Convex move queue, or is refused
 * (2026-10-13). Jobs written before that are still in customers' buckets and
 * still have to finish, so the drain (`materialize_move`, the background
 * worker) keeps its tests. Those tests now start from the job file an older
 * gateway wrote at cutover, made here the way that gateway made it: every
 * object under `source`, its etag and size, at `destination`, plus the
 * active-move sentinel. What that cutover also did to `privacy.md`, the
 * forwarding ledger and the folder icons is not reproduced: the drain never
 * reads it back.
 */

import { listAllKeys } from "../src/notes/storage.js";
import { MOVE_JOB_PREFIX, MOVE_JOB_VERSION, MOVE_SENTINEL_KEY } from "../src/moves/limits.js";

let sequence = 0;

/** Seed one job moving `source/` to `destination/` in `store` (the raw bucket); returns its id. */
export async function seedLegacyFolderMove(store, source, destination) {
  const { id, job, sentinel } = legacyFolderMoveJob(source, destination, await listAllKeys(store, `${source}/`));
  await store.put(`${MOVE_JOB_PREFIX}${id}.json`, job);
  await store.put(MOVE_SENTINEL_KEY, sentinel);
  return id;
}

/**
 * The same job for a backend's own object map (`s3Backend.mjs`:
 * `key -> { body, etag }`), written straight into it.
 */
export function seedLegacyFolderMoveInMap(objects, source, destination) {
  const listed = [...objects]
    .filter(([key]) => key.startsWith(`${source}/`))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, etag: value.etag, size: value.body.length }));
  const { id, job, sentinel } = legacyFolderMoveJob(source, destination, listed);
  objects.set(`${MOVE_JOB_PREFIX}${id}.json`, { body: job, etag: `job-${id}` });
  objects.set(MOVE_SENTINEL_KEY, { body: sentinel, etag: `sentinel-${id}` });
  return id;
}

function legacyFolderMoveJob(source, destination, objects) {
  sequence += 1;
  const id = `move-legacy-${String(sequence).padStart(8, "0")}-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const job = {
    version: MOVE_JOB_VERSION,
    id,
    status: "logical_active",
    source,
    destination,
    created_at: now,
    updated_at: now,
    total_objects: objects.length,
    copied_objects: 0,
    deleted_objects: 0,
    copied: [],
    objects: objects.map(({ key, etag, size }) => ({
      source: key,
      destination: `${destination}/${key.slice(source.length + 1)}`,
      etag,
      size,
    })),
    error: null,
  };
  return {
    id,
    job: JSON.stringify(job, null, 2),
    sentinel: JSON.stringify({ version: MOVE_JOB_VERSION, active: true, updated_at: now }),
  };
}

/**
 * A legacy reference-repair job, as an older gateway queued one when a move's
 * link rewrite was too large for its request: status `rewriting`, the move's
 * renames as its objects. `move_folder` and `move_note` no longer queue one
 * (their rewrite is reported as not done, and forwarding carries the links),
 * but one already in a bucket is still finished by the drain.
 */
export async function seedLegacyReferenceJob(store, renames, scope = "private") {
  sequence += 1;
  const id = `move-legacy-${String(sequence).padStart(8, "0")}-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const job = {
    version: MOVE_JOB_VERSION,
    id,
    status: "rewriting",
    source: renames[0][0],
    destination: renames[0][1],
    reference_scope: scope,
    created_at: now,
    updated_at: now,
    total_objects: renames.length,
    objects: renames.map(([source, destination]) => ({ source, destination })),
    reference_failed_paths: [],
  };
  await store.put(`${MOVE_JOB_PREFIX}${id}.json`, JSON.stringify(job, null, 2));
  await store.put(MOVE_SENTINEL_KEY, JSON.stringify({ version: MOVE_JOB_VERSION, active: true, updated_at: now }));
  return id;
}

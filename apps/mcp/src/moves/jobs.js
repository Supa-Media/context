/**
 * Logical folder-move jobs: their keys, the active-move sentinel, and the
 * overlay that makes a half-materialized move read as finished. Owns
 * `LOGICAL_MOVE_WORKSPACES`, the per-isolate hint that a workspace may have a
 * move in flight. Moved verbatim out of `src/index.js`.
 */

import { budgetedStore } from "../search/budget.js";
import { deleteWithLegacyFallback, getWithLegacyFallback } from "../storageLayout.js";
import { listAllKeys } from "../notes/storage.js";
import { MOVE_JOB_PREFIX, MOVE_JOB_VERSION, MOVE_SENTINEL_KEY } from "./limits.js";

/** Counts only: never forward a marker's paths or provider text to the control plane. */
export function moveProgressFromText(text) {
  const found = /^(copied|deleted|references): (\d+)\/(\d+)$/m.exec(text);
  if (!found) return undefined;
  const completed = Number(found[2]);
  const total = Number(found[3]);
  if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || total <= 0 || completed > total) {
    return undefined;
  }
  return {
    phase: found[1] === "copied" ? "copying" : found[1] === "deleted" ? "deleting" : "rewriting",
    completed,
    total,
  };
}
/**
 * A move's failure text, with the bucket's paths taken out, for the control
 * plane's `gatewayJobs.lastError`.
 *
 * `moveProgressFromText` above states the rule for the other channel out of
 * the same consumer — counts only, never a marker's paths or provider text —
 * and keeps it with a strict integer regex. The failure channel forwarded the
 * tool's whole text, and a dozen of `materialize.js`'s throws interpolate
 * `pair.source` or `pair.destination`, so a customer's note path left the
 * bucket and was stored where the control plane only truncates it.
 * `safeMoveStorageDetail` says the same of its own fragment: "only in the
 * immediate tool response; never persist it in the move marker, activity or
 * gateway job status."
 *
 * Only a validated move id and a known stage survive. Redacting path-like
 * substrings from arbitrary provider text leaves filename fragments when a
 * path contains spaces or non-ASCII characters.
 */
export function moveErrorForControlPlane(text) {
  if (typeof text !== "string" || text.length === 0) return undefined;
  const id = /^move (move-[a-z0-9-]{8,80}):/i.exec(text)?.[1];
  if (!id) return "move job failed";
  const materialization = /^move move-[a-z0-9-]{8,80}: materialization paused: (copying|deleting|rewriting|inventorying)\b/i.exec(text);
  const reference = /^move move-[a-z0-9-]{8,80}: reference (rewrite|inventory) paused:/i.exec(text);
  const stage = materialization?.[1]?.toLowerCase() ||
    (reference?.[1] === "rewrite" ? "rewriting" : reference?.[1] === "inventory" ? "inventorying" : null);
  return `move job failed: ${id}${stage ? ` (${stage})` : ""}`;
}

const LOGICAL_MOVE_WORKSPACES = new Set();

export function moveJobKey(id) {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{12,80}$/i.test(id)) return null;
  return `${MOVE_JOB_PREFIX}${id}.json`;
}

export function noteUnderPrefix(path, prefix) {
  if (!prefix) return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function movedSourceFor(job, destinationKey) {
  const item = (job.objects || []).find((entry) => entry.destination === destinationKey);
  return item?.source || null;
}

export function moveJobActive(job) {
  return (
    job &&
    job.version === MOVE_JOB_VERSION &&
    typeof job.id === "string" &&
    typeof job.source === "string" &&
    typeof job.destination === "string" &&
    Array.isArray(job.objects) &&
    ["logical_active", "copying", "deleting", "needs_cleanup", "rewriting"].includes(job.status)
  );
}

export async function loadMoveJobs(store) {
  const jobs = [];
  let objects;
  try {
    objects = await listAllKeys(store, MOVE_JOB_PREFIX);
  } catch {
    return jobs;
  }
  for (const { key } of objects) {
    if (!key.endsWith(".json")) continue;
    try {
      const object = await getWithLegacyFallback(store, key);
      if (!object) continue;
      const parsed = JSON.parse(await object.text());
      if (moveJobActive(parsed)) jobs.push(parsed);
    } catch {
      // A damaged move marker is not allowed to break ordinary reads. The
      // materializer will report the real failure when asked for that id.
    }
  }
  return jobs.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
}

async function moveSentinelActive(store, budget = null) {
  try {
    const reader = budget ? budgetedStore(store, budget, 0) : store;
    return (await reader.get(MOVE_SENTINEL_KEY)) !== null;
  } catch {
    return false;
  }
}

export async function writeMoveSentinel(store) {
  markLogicalMovesMaybeActive(store);
  await store.put(
    MOVE_SENTINEL_KEY,
    JSON.stringify({ version: MOVE_JOB_VERSION, active: true, updated_at: new Date().toISOString() })
  );
}

export async function refreshMoveSentinel(store) {
  const jobs = await loadMoveJobs(store);
  if (jobs.length) {
    await writeMoveSentinel(store);
  } else {
    await deleteWithLegacyFallback(store, MOVE_SENTINEL_KEY).catch(() => {});
    clearLogicalMovesMaybeActive(store);
  }
  return jobs;
}

function logicalMoveWorkspaceKey(store) {
  return store?.actor?.workspaceId || null;
}

function markLogicalMovesMaybeActive(store) {
  const key = logicalMoveWorkspaceKey(store);
  if (key) LOGICAL_MOVE_WORKSPACES.add(key);
}

function clearLogicalMovesMaybeActive(store) {
  const key = logicalMoveWorkspaceKey(store);
  if (key) LOGICAL_MOVE_WORKSPACES.delete(key);
}

export async function searchMoveJobs(store, prefix, budget = null) {
  if (prefix) return loadMoveJobs(store);
  const key = logicalMoveWorkspaceKey(store);
  if (!key || (!LOGICAL_MOVE_WORKSPACES.has(key) && !(await moveSentinelActive(store, budget)))) return [];
  const jobs = await loadMoveJobs(store);
  if (!jobs.length) await refreshMoveSentinel(store);
  return jobs;
}

export async function fallbackMoveJobs(store, prefix, budget = null) {
  return searchMoveJobs(store, prefix, budget);
}

export function applyMoveOverlay(keys, jobs) {
  if (!jobs.length) return keys;
  // A workspace can have thousands of notes and several thousand objects in
  // active moves. Looking through every job's object list for every listed
  // note made ordinary listings and orientation take minutes. Index the
  // source paths once, retaining the earliest job's precedence for a source.
  const destinations = new Map();
  for (const job of jobs) {
    for (const item of job.objects || []) {
      if (!destinations.has(item.source)) destinations.set(item.source, item.destination);
    }
  }
  const out = new Map();
  for (const object of keys) {
    const destination = destinations.get(object.key);
    if (destination) out.set(destination, { ...object, key: destination, logicalSource: object.key });
    else if (!out.has(object.key)) out.set(object.key, object);
  }
  return [...out.values()];
}

export async function pathUnderActiveMovedSource(store, path) {
  const jobs = await loadMoveJobs(store);
  return jobs.some((job) => noteUnderPrefix(path, job.source));
}

export async function persistMoveJob(store, job) {
  job.updated_at = new Date().toISOString();
  await store.put(moveJobKey(job.id), JSON.stringify(job, null, 2));
}

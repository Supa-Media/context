/**
 * Split job: one job that owns several parts at once (Architect item #7, option C of
 * `@supa products/tex/research/split-jobs-one-job-2026-11-24.md`, decided by Grok Bot for Seyi, 2026-11-28).
 *
 * `plan_big_ask` splits a big ask into parts that run side by side, each on a named worker (the cloud, a paired
 * computer), all on the project overview's mail. Each part still runs in a `job:<id>` object of its own and takes a
 * slot of its own, so the three-job cap and each computer's slots hold as before. What makes them one job is the
 * split they carry: the overview note's path is its id, and the plan's title its name. With it:
 *
 *   - the chat's list shows the split as one job with its parts under it (`groupedJobs`);
 *   - "try again" on any part, or on the split's title, picks back up every unfinished part (`restartSet`): 2026-11-06,
 *     a split's "try again" resumed only the part that had ended, and the computer ran alone for twelve minutes
 *     waiting on a partner that never started;
 *   - a part that ends waiting sleeps until mail or a text wakes it, instead of ending or using up parts
 *     (`packages/shared/src/jobPartEnd.cjs` `sleep`, `packages/tex/worker/jobSleep.ts`).
 *
 * Plain CommonJS, needing only `fileKinds.cjs`, so the gateway and the texting Worker read the same rules. This is the config's
 * Split job node (`split`): its code, as `jobPartEnd.cjs` is Part end's.
 */

const { isNotePath } = require("./fileKinds.cjs");

const MAX_TITLE = 80;
const MAX_PATH = 1024;

/** A split read strictly: `{ id, title }`, the overview note's path and the plan's title, or null. */
function splitOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const title = typeof value.title === "string" ? value.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : "";
  if (id === "" || id.length > MAX_PATH || /[\u0000-\u001f]/.test(id) || !isNotePath(id) || title === "") return null;
  return { id, title };
}

const lower = (value) => String(value ?? "").toLowerCase();

/**
 * What a restart picks back up: the jobs it picked, then every other part of a split one of them is in, or whose
 * title one of `names` is, that `resumable` says can still be picked up. A done part stays done. In the order of
 * `entries`, each once.
 *
 * @param {Array<{ id: string, title: string, split?: { id: string, title: string } | null }>} entries the chat's jobs
 * @param {Array<{ id: string }>} picked the jobs the restart matched by their own titles
 * @param {(entry: object) => boolean} resumable whether a job can still be picked back up
 * @param {string[]} [names] the titles the restart named
 */
function restartSet(entries, picked, resumable, names = []) {
  const named = new Set(names.map(lower));
  const splits = new Set();
  for (const entry of entries) {
    const split = splitOf(entry.split);
    if (split === null) continue;
    if (picked.some((each) => each.id === entry.id) || named.has(lower(split.title))) splits.add(split.id);
  }
  const ids = new Set(picked.map((each) => each.id));
  return entries.filter((entry) => ids.has(entry.id) || (splits.has(splitOf(entry.split)?.id) && resumable(entry)));
}

/**
 * The chat's jobs as its list shows them: a job on its own as `{ job }`, a split as `{ split, parts }` at the place
 * of its first part, its parts in their order.
 */
function groupedJobs(entries) {
  const out = [];
  const at = new Map();
  for (const entry of entries) {
    const split = splitOf(entry.split);
    if (split === null) {
      out.push({ job: entry });
      continue;
    }
    if (!at.has(split.id)) {
      at.set(split.id, out.length);
      out.push({ split, parts: [] });
    }
    out[at.get(split.id)].parts.push(entry);
  }
  return out;
}

/** The Split job node's answer for one restart (`packages/tex/gateway/agent/graph/nodes/split.js`): the ids to pick back up. */
function decideSplit(input) {
  const entries = Array.isArray(input?.entries) ? input.entries : [];
  const picked = Array.isArray(input?.picked) ? input.picked : [];
  const resumable = new Set(Array.isArray(input?.resumable) ? input.resumable : []);
  const names = Array.isArray(input?.names) ? input.names.filter((name) => typeof name === "string") : [];
  return { restart: restartSet(entries, picked, (entry) => resumable.has(entry.id), names).map((entry) => entry.id) };
}

module.exports = { splitOf, restartSet, groupedJobs, decideSplit };

// Graph reconciliation on the shared search census (arch 10.1, 10.3, 9.4).
// Runs only inside search maintenance, after the sync and the D1 projection,
// on what they left of the budget. Progress lives in its own cursor object, not
// in the search manifest or D1 (arch 10.1).
//
// Three bounded pieces per pass, all on one budget:
// - removal hints (`synced.removed`), each confirmed by a direct note read;
// - the sweep: census paths in sorted order from `sweepCursor`, re-projecting
//   a node that is missing, observed another version, or owes reverseRepair
//   (the pass fetches its own bodies, OPEN-14);
// - on a complete census only, the audit: one listing page of the generation
//   from `auditCursor`. A node whose path is absent from the census is removed
//   only after a direct read of the note returns not-found (OPEN-15, arch
//   10.3); a current node has its memberships re-asserted (lost membership);
//   a posting page has the entries `validateEntry` rejects removed, by exact
//   (source, referenceSetVersion), so an accepted entry is never removed.
//
// The bucket is a trust boundary: the cursor, listed keys, node records and
// pages are checked before use, and nothing outside the generation's prefix is
// written or deleted. Notes are only ever read.
//
// Liveness: projectNote checkpoints its progress, so a note larger than one
// pass's budget converges over passes instead of blocking the sweep. Once the
// graph is ready, the sweep and the audit alternate passes (`auditTurn`), each
// taking the whole remainder on its turn, so neither is starved below its
// smallest unit of work.
//
// Accepted races. The exact clear is time-of-check/time-of-use: an entry
// validated as stale whose source flips back to that referenceSetVersion
// before the removal lands is lost; the node audit re-asserts it on the next
// audit cycle. And `ready` means "as of the last wrap": nothing was pending
// when the sweep last wrapped, not that every node is settled right now.
import { membershipsFor } from "./facts.js";
import { generationPrefix, maintenanceCursorKey, nodeKey, pathHash } from "./keys.js";
import { initGraphManifest, publishHealth, readGraphManifest } from "./manifest.js";
import { graphMode } from "./mode.js";
import { setMembership } from "./postings.js";
import { projectNote, readNode, removeNote, validateEntry } from "./project.js";
import { parseNode, parsePage } from "./records.js";

// Kept back for the end of the pass: manifest read, health put, cursor put,
// plus publishHealth's re-read in best-effort mode.
const wrapReserve = (mode) => (mode === "conditional" ? 3 : 4);
const AUDIT_LIST_LIMIT = 100;
const NODE_KEY = /^nodes\/[0-9a-f]{64}\.json$/;
const PAGE_KEY = /^(incoming|bare|names|urls)\/([0-9a-f]{64})\/[0-9]+\.json$/;

/** A view of `budget` that always leaves `keep` ops for the caller. */
const capped = (budget, keep) => ({
  get remaining() {
    return Math.max(0, budget.remaining - keep);
  },
  get spent() {
    return budget.spent;
  },
  take: (reserve = 0) => budget.take(reserve + keep),
});

const freshCursor = () => ({ sweepCursor: "", sweepStartedAt: "", auditCursor: "", sweepPending: false, auditTurn: false });

async function readCursor(store, budget, gen) {
  if (!budget.take()) return null;
  const got = await store.get(maintenanceCursorKey(gen));
  if (!got) return { cursor: freshCursor(), etag: null };
  let value = null;
  try {
    value = JSON.parse(await got.text());
  } catch {
    // Unparseable: start over, overwriting it.
  }
  const ok =
    value && typeof value === "object" &&
    ["sweepCursor", "sweepStartedAt", "auditCursor"].every((f) => typeof value[f] === "string") &&
    typeof value.sweepPending === "boolean";
  const cursor = ok
    ? {
        sweepCursor: value.sweepCursor,
        sweepStartedAt: value.sweepStartedAt,
        auditCursor: value.auditCursor,
        sweepPending: value.sweepPending,
        auditTurn: value.auditTurn === true,
      }
    : freshCursor();
  return { cursor, etag: got.etag ?? null };
}

/** `auditCursor` is "" or JSON `[listToken | null, keyIndex, entryIndex]`. */
function parseAuditCursor(text) {
  try {
    const [token, k, e] = JSON.parse(text);
    if ((token === null || typeof token === "string") && Number.isInteger(k) && k >= 0 && Number.isInteger(e) && e >= 0) {
      return { token, k, e };
    }
  } catch {
    // "" or garbage: start from the top.
  }
  return { token: null, k: 0, e: 0 };
}

/**
 * Remove `path` only if a direct read says the note is gone. Returns the
 * removeNote state, "kept" when the note exists, or "stop" when the budget
 * refused the read.
 */
async function removeIfGone(store, budget, path, ctx) {
  if (!budget.take()) return "stop";
  try {
    if (await store.get(path)) return "kept";
  } catch {
    return "kept"; // a failed read is not a not-found
  }
  return (await removeNote(store, path, { budget, gen: ctx.gen, mode: ctx.mode })).state;
}

/** Re-project one census path from its own fresh body read. */
async function refresh(store, budget, path, version, ctx, read) {
  if (!budget.take()) return "stop";
  let object;
  try {
    object = await store.get(path);
  } catch {
    return "stale"; // unreadable this pass: left for the next sweep, never a stall
  }
  if (!object) return (await removeNote(store, path, { budget, gen: ctx.gen, mode: ctx.mode })).state;
  let body;
  try {
    body = await object.text();
  } catch {
    return "stale";
  }
  return (await projectNote(store, path, body, version, { budget, gen: ctx.gen, mode: ctx.mode, now: ctx.now, read })).state;
}

/** Count a projection outcome; true when the item needs no revisit this sweep. */
function tally(out, state) {
  if (state === "projected") out.projected += 1;
  else if (state === "pending" || state === "stale") out.pending += 1;
}

const isCurrent = (node, version) =>
  node !== null && node.observedSourceVersion === version &&
  Array.isArray(node.reverseRepair) && node.reverseRepair.length === 0;

async function sweep(store, budget, ctx, cursor, out) {
  const paths = [...ctx.census.keys()].filter(ctx.isIndexable).sort();
  if (cursor.sweepCursor === "" && cursor.sweepStartedAt === "") cursor.sweepStartedAt = new Date(ctx.now).toISOString();
  for (const path of paths) {
    if (path <= cursor.sweepCursor) continue;
    const version = ctx.census.get(path);
    let read;
    try {
      // The one node read; projectNote is handed it rather than re-reading.
      read = await readNode(store, budget, ctx.gen, path);
    } catch {
      read = undefined; // unreadable record: skipped this sweep, counted pending
    }
    if (read === null) return false;
    if (read === undefined) {
      tally(out, "pending");
      cursor.sweepPending = true;
    } else if (!isCurrent(read.old, version)) {
      const state = await refresh(store, budget, path, version, ctx, read);
      // Out of budget mid-note ("budget", stated by projectNote, never read
      // off `remaining`): revisit it next pass rather than skipping it.
      if (state === "stop" || state === "budget") return false;
      tally(out, state);
      if (state === "pending" || state === "stale") cursor.sweepPending = true;
    }
    cursor.sweepCursor = path;
  }
  return true;
}

/** Re-assert a current node's memberships (lost membership). False on budget. */
async function auditCurrentNode(store, budget, ctx, path, node) {
  let memberships;
  try {
    ({ memberships } = await membershipsFor(path, node.occurrences));
  } catch {
    return true; // hostile occurrences: nothing to assert
  }
  for (const m of [...memberships].sort()) {
    const [family, hash] = m.split(":");
    const result = await setMembership(store, budget, {
      gen: ctx.gen, family, hash, source: path, referenceSetVersion: node.referenceSetVersion, present: true, mode: ctx.mode,
    });
    if (result === "budget") return false;
  }
  return true;
}

async function auditNode(store, budget, ctx, key, out) {
  if (!budget.take()) return false;
  const got = await store.get(key);
  if (!got) return true;
  const text = await got.text();
  let path;
  try {
    path = JSON.parse(text)?.path;
  } catch {
    return true;
  }
  if (typeof path !== "string") return true;
  const node = parseNode(text, path);
  // The record must live at its own path's key (arch 9.1).
  if (!node || nodeKey(ctx.gen, await pathHash(path)) !== key) return true;
  if (ctx.census.has(path)) {
    if (node.coverage === "excluded" || !isCurrent(node, ctx.census.get(path))) return true; // the sweep's job
    return auditCurrentNode(store, budget, ctx, path, node);
  }
  // A tombstone (removeNote without conditional delete) has nothing to remove.
  if (node.coverage === "excluded" && node.observedSourceVersion === null && isCurrent(node, null)) return true;
  // Absent from a complete census: removed only on an authoritative not-found.
  const state = await removeIfGone(store, budget, path, ctx);
  if (state === "stop" || state === "budget") return false;
  tally(out, state);
  return true;
}

/** Returns the entry index to resume from, or -1 when the page is finished. */
async function auditPage(store, budget, ctx, key, family, hash, from) {
  if (!budget.take()) return from;
  const got = await store.get(key);
  const page = got ? parsePage(await got.text(), key) : null;
  if (!page) return -1;
  // Indexes into the page as it will be re-read: each removal this pass
  // shifts the later entries down by one.
  let removed = 0;
  for (let e = from; e < page.entries.length; e += 1) {
    const entry = page.entries[e];
    const id = `${entry.source}\n${entry.referenceSetVersion}`;
    if (!ctx.verdicts.has(id)) {
      try {
        ctx.verdicts.set(id, await ctx.validate(entry));
      } catch {
        return e - removed; // budget refused the validating read
      }
    }
    if (ctx.verdicts.get(id)) continue;
    const result = await setMembership(store, budget, {
      gen: ctx.gen, family, hash, source: entry.source, referenceSetVersion: entry.referenceSetVersion,
      present: false, exact: true, mode: ctx.mode,
    });
    if (result === "budget") return e - removed;
    if (result === "done") removed += 1;
  }
  return -1;
}

/**
 * One listing page of the generation. Key and entry indexes are positions in
 * that page; a page that shifted between passes skips or repeats a few items,
 * which the next audit cycle covers.
 */
async function audit(store, budget, ctx, cursor, out) {
  const at = parseAuditCursor(cursor.auditCursor);
  const prefix = generationPrefix(ctx.gen);
  if (!budget.take()) return;
  let listed;
  try {
    listed = await store.list({ prefix, cursor: at.token ?? undefined, limit: AUDIT_LIST_LIMIT });
  } catch {
    cursor.auditCursor = ""; // an expired or refused token: start over
    return;
  }
  const keys = (listed.objects || []).map((o) => o?.key).filter((k) => typeof k === "string" && k.startsWith(prefix));
  for (let k = at.k; k < keys.length; k += 1) {
    const rel = keys[k].slice(prefix.length);
    const from = k === at.k ? at.e : 0;
    let resume = -1;
    if (NODE_KEY.test(rel)) {
      if (!(await auditNode(store, budget, ctx, keys[k], out))) resume = 0;
    } else {
      const m = PAGE_KEY.exec(rel);
      if (m) resume = await auditPage(store, budget, ctx, keys[k], m[1], m[2], from);
    }
    if (resume >= 0) {
      cursor.auditCursor = JSON.stringify([at.token, k, resume]);
      return;
    }
  }
  const next = listed.truncated && typeof listed.cursor === "string" && listed.cursor ? listed.cursor : null;
  cursor.auditCursor = next ? JSON.stringify([next, 0, 0]) : "";
}

/**
 * One bounded reconciliation pass. Returns `{ projected, pending,
 * sweepComplete }` (internal, never printed to a caller). `sweepComplete` is
 * true when this pass wrapped the sweep over a complete census.
 */
export async function reconcileGraph(store, budget, { census, censusComplete, removedHints = [], isIndexable, now }) {
  const out = { projected: 0, pending: 0, sweepComplete: false };
  const mode = graphMode(store);
  let { manifest, absent } = await readGraphManifest(store, budget);
  if (!manifest && absent) manifest = await initGraphManifest(store, budget, { mode, now });
  if (!manifest) return out;
  const gen = manifest.generation;
  const read = await readCursor(store, budget, gen);
  if (!read) return out;
  const { cursor } = read;
  const before = JSON.stringify(cursor);
  const ctx = { census, isIndexable, gen, mode, now, verdicts: new Map() };
  const reserve = wrapReserve(mode);
  const work = capped(budget, reserve);
  ctx.validate = validateEntry(store, work, gen);

  for (const path of removedHints) {
    if (typeof path !== "string" || !isIndexable(path) || census.has(path)) continue;
    const state = await removeIfGone(store, work, path, ctx);
    if (state === "stop" || state === "budget") break;
    tally(out, state);
  }
  // Once the graph is ready, sweep and audit alternate passes and each takes
  // the whole remainder on its turn; a split share could fall below the
  // audit's smallest unit and livelock it. Before ready the sweep comes first
  // and the audit gets what it leaves.
  const auditFirst = censusComplete && manifest.health.state === "ready" && cursor.auditTurn;
  if (censusComplete && manifest.health.state === "ready") cursor.auditTurn = !cursor.auditTurn;
  if (auditFirst) await audit(store, work, ctx, cursor, out);
  const wrapped = await sweep(store, work, ctx, cursor, out);
  if (censusComplete && !auditFirst) await audit(store, work, ctx, cursor, out);

  if (wrapped) {
    if (censusComplete) {
      const fresh = await readGraphManifest(store, budget);
      // Ready only when the whole wrap found nothing pending.
      const state = cursor.sweepPending ? "behind" : "ready";
      const health = { sweepComplete: true, lastSweepAt: new Date(now).toISOString(), state };
      if (fresh.manifest?.generation === gen) await publishHealth(store, budget, fresh.manifest, fresh.etag, { health });
      out.sweepComplete = true;
    }
    Object.assign(cursor, { sweepCursor: "", sweepStartedAt: "", sweepPending: false });
  }
  if (JSON.stringify(cursor) !== before && budget.take()) {
    const onlyIf = mode === "conditional" ? { onlyIf: read.etag ? { etagMatches: read.etag } : { absent: true } } : undefined;
    // A refused write means another pass moved the cursor; this one is dropped.
    await store.put(maintenanceCursorKey(gen), JSON.stringify(cursor), onlyIf);
  }
  return out;
}

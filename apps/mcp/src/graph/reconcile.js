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
// passes take turns whatever the health (`turn`: sweep, audit, sweep, GC),
// each taking the whole remainder on its turn, so none is starved below its
// smallest unit of work.
//
// Accepted races. The exact clear is time-of-check/time-of-use: an entry
// validated as stale whose source flips back to that referenceSetVersion
// before the removal lands is lost; the node audit re-asserts it on the next
// audit cycle. And `ready` means "as of the last wrap": nothing was pending
// when the sweep last wrapped, not that every node is settled right now.
//
// Generations (rebuild.js): while the manifest names a `building` generation,
// every piece above runs on it instead of the active one, in the same turns,
// and its wraps publish no health; two consecutive clean wraps on a complete
// census, with a full audit listing begun after the first, cut over. The
// active generation gets only pinned writes until then (removal hints
// included go to the building one). A manifest or building generation from
// newer code is left alone, and while a newer build exists the active
// generation's wraps publish "behind", never ready, so it is never complete
// until that build cuts over. A `collect` generation is garbage-collected on
// GC turns and otherwise only on what the sweep leaves, so junk under it
// never takes a sweep turn; a GC failure never stops the pass.
import { membershipsFor } from "./facts.js";
import { generationPrefix, maintenanceCursorKey, nodeKey, pathHash } from "./keys.js";
import { initGraphManifest, publishHealth, readGraphManifest } from "./manifest.js";
import { graphMode, writeHeadroom } from "./mode.js";
import { setMembership } from "./postings.js";
import { projectNote, readNode, removeNote, validateEntry } from "./project.js";
import { parseNode, parsePage, recordText } from "./records.js";
import { BUDGET_EXHAUSTED } from "../search/budget.js";
import {
  GC_FAILURE_LIMIT, abandonCollect, collectGarbage, cutover, isNewer, matchesCode, needsRebuild, startRebuild,
} from "./rebuild.js";

// Kept back for the end of the pass: manifest read, health put, cursor put,
// plus publishHealth's re-read in best-effort mode, plus the wrapper's charged
// read before each of those puts that is unconditional or absent (fix round 2:
// without it the cursor never lands on a best-effort gateway store).
const wrapReserve = (store, mode, cursorOnlyIf) => {
  const health = writeHeadroom(store, mode === "conditional" ? { onlyIf: { etagMatches: "held" } } : undefined);
  return (mode === "conditional" ? 3 : 4) + health + writeHeadroom(store, cursorOnlyIf);
};
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

// `recheck`: the building generation's last wrap was clean; the next clean one
// cuts over once `auditWrapped` says an audit listing begun since then ended.
// `gcFailures`: consecutive passes whose GC page failed. `gcCursor`: where
// the GC listing of `collect` resumes (rebuild.js).
const freshCursor = () => ({
  sweepCursor: "", sweepStartedAt: "", auditCursor: "", sweepPending: false, turn: 0,
  recheck: false, auditWrapped: false, gcFailures: 0, gcCursor: "",
});

async function readCursor(store, budget, gen) {
  if (!budget.take()) return null;
  const got = await store.get(maintenanceCursorKey(gen));
  if (!got) return { cursor: freshCursor(), etag: null };
  let value = null;
  try {
    // Over the record cap reads as unparseable, never parsed.
    value = JSON.parse(await recordText(got));
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
        turn: Number.isInteger(value.turn) && value.turn > 0 ? value.turn % 4 : 0,
        recheck: value.recheck === true,
        auditWrapped: value.auditWrapped === true,
        gcFailures: Number.isInteger(value.gcFailures) && value.gcFailures > 0 ? value.gcFailures : 0,
        gcCursor: typeof value.gcCursor === "string" ? value.gcCursor : "",
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

/**
 * Re-assert a current node's memberships (lost membership), in sorted order
 * from index `from`. Returns -1 when done, or the index to resume from on a
 * budget stop, so a node with more memberships than one turn still finishes
 * (the cutover waits for a full audit listing).
 */
async function auditCurrentNode(store, budget, ctx, path, node, from) {
  let memberships;
  try {
    ({ memberships } = await membershipsFor(path, node.occurrences));
  } catch {
    return -1; // hostile occurrences: nothing to assert
  }
  const sorted = [...memberships].sort();
  for (let i = from; i < sorted.length; i += 1) {
    const [family, hash] = sorted[i].split(":");
    const result = await setMembership(store, budget, {
      gen: ctx.gen, family, hash, source: path, referenceSetVersion: node.referenceSetVersion, present: true, mode: ctx.mode,
    });
    if (result === "budget") return i;
  }
  return -1;
}

/** -1 when the node is finished, else the membership index to resume from. */
async function auditNode(store, budget, ctx, key, out, from) {
  if (!budget.take()) return from;
  const got = await store.get(key);
  if (!got) return -1;
  const text = await recordText(got);
  if (text === null) return -1; // over the record cap: never parsed
  let path;
  try {
    path = JSON.parse(text)?.path;
  } catch {
    return -1;
  }
  if (typeof path !== "string") return -1;
  const node = parseNode(text, path);
  // The record must live at its own path's key (arch 9.1).
  if (!node || nodeKey(ctx.gen, await pathHash(path)) !== key) return -1;
  if (ctx.census.has(path)) {
    if (node.coverage === "excluded" || !isCurrent(node, ctx.census.get(path))) return -1; // the sweep's job
    return auditCurrentNode(store, budget, ctx, path, node, from);
  }
  // A tombstone (removeNote without conditional delete) has nothing to remove.
  if (node.coverage === "excluded" && node.observedSourceVersion === null && isCurrent(node, null)) return -1;
  // Absent from a complete census: removed only on an authoritative not-found.
  const state = await removeIfGone(store, budget, path, ctx);
  if (state === "stop" || state === "budget") return from;
  tally(out, state);
  return -1;
}

/** Returns the entry index to resume from, or -1 when the page is finished. */
async function auditPage(store, budget, ctx, key, family, hash, from) {
  if (!budget.take()) return from;
  const got = await store.get(key);
  const page = got ? parsePage(await recordText(got), key) : null;
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
  // Sized to the budget: on a logical-delete store each listed marker costs a
  // charged read, so a page larger than what is left would throw every pass
  // and never advance (fix round 3). A full page then still leaves at least
  // one op per visible key on it, so every pass makes progress.
  const limit = Math.min(AUDIT_LIST_LIMIT, budget.remaining - 1);
  if (limit < 1 || !budget.take()) return;
  let listed;
  try {
    listed = await store.list({ prefix, cursor: at.token ?? undefined, limit });
  } catch (error) {
    // Out of budget mid-listing: resume from the same place next pass. Any
    // other failure (an expired or refused token) starts over.
    if (!error?.[BUDGET_EXHAUSTED]) cursor.auditCursor = "";
    return;
  }
  const keys = (listed.objects || []).map((o) => o?.key).filter((k) => typeof k === "string" && k.startsWith(prefix));
  for (let k = at.k; k < keys.length; k += 1) {
    const rel = keys[k].slice(prefix.length);
    const from = k === at.k ? at.e : 0;
    let resume = -1;
    if (NODE_KEY.test(rel)) {
      resume = await auditNode(store, budget, ctx, keys[k], out, from);
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
  if (!next) cursor.auditWrapped = true;
}

/** One GC page on what `budget` has left; a GC failure never stops the pass. */
async function garbage(store, budget, manifest, cursor) {
  let gc;
  try {
    gc = await collectGarbage(store, budget, manifest, cursor);
  } catch {
    gc = "failed"; // a manifest op inside GC
  }
  if (gc === "done") cursor.gcFailures = 0;
  if (gc === "failed" && (cursor.gcFailures += 1) >= GC_FAILURE_LIMIT) {
    cursor.gcFailures = 0;
    try {
      await abandonCollect(store, budget, manifest.collect);
    } catch {
      // Retried after the next GC_FAILURE_LIMIT failures.
    }
  }
}

/**
 * One bounded reconciliation pass. Returns `{ projected, pending,
 * sweepComplete, cutover? }` (internal, never printed to a caller).
 * `sweepComplete` is true when this pass wrapped the sweep over a complete
 * census; `cutover` is true when it swapped to the building generation.
 */
export async function reconcileGraph(store, budget, { census, censusComplete, removedHints = [], isIndexable, now }) {
  const out = { projected: 0, pending: 0, sweepComplete: false };
  const mode = graphMode(store);
  let { manifest, etag, absent } = await readGraphManifest(store, budget);
  if (!manifest && absent) manifest = await initGraphManifest(store, budget, { mode, now });
  if (!manifest || isNewer(manifest)) return out;
  // A build by older code is restarted; one by newer code is left to it.
  if (manifest.building ? needsRebuild(manifest.building) : needsRebuild(manifest)) {
    await startRebuild(store, budget, manifest, etag, now); // the next pass builds
    return out;
  }
  const building = manifest.building !== null && matchesCode(manifest.building);
  const gen = building ? manifest.building.generation : manifest.generation;
  const read = await readCursor(store, budget, gen);
  if (!read) return out;
  const { cursor } = read;
  const before = JSON.stringify(cursor);
  const ctx = { census, isIndexable, gen, mode, now, verdicts: new Map() };
  const cursorOnlyIf = mode === "conditional" ? { onlyIf: read.etag ? { etagMatches: read.etag } : { absent: true } } : undefined;
  const reserve = wrapReserve(store, mode, cursorOnlyIf);
  const work = capped(budget, reserve);
  ctx.validate = validateEntry(store, work, gen);
  for (const path of removedHints) {
    if (typeof path !== "string" || !isIndexable(path) || census.has(path)) continue;
    const state = await removeIfGone(store, work, path, ctx);
    if (state === "stop" || state === "budget") break;
    tally(out, state);
  }
  // Turns cycle sweep, audit, sweep, GC every pass, whatever the health says,
  // and each goes first on its turn with the whole remainder; the others get
  // what it leaves. A piece living only on leftovers starves for some census
  // size (a wrap can always leave fewer ops than its smallest unit), and a
  // split share could fall below the audit's smallest unit and livelock it.
  // The GC turn's leftover goes to the audit. With an incomplete census the
  // audit does not run and its turns go to the sweep.
  const turn = cursor.turn;
  cursor.turn = (turn + 1) % 4;
  const auditFirst = censusComplete && turn % 2 === 1;
  if (turn === 3) await garbage(store, work, manifest, cursor);
  if (auditFirst) await audit(store, work, ctx, cursor, out);
  const wrapped = await sweep(store, work, ctx, cursor, out);
  if (turn !== 3) await garbage(store, work, manifest, cursor);
  if (censusComplete && !auditFirst) await audit(store, work, ctx, cursor, out);

  if (wrapped) {
    if (censusComplete) {
      // Ready only when the whole wrap found nothing pending.
      const state = cursor.sweepPending ? "behind" : "ready";
      const health = { sweepComplete: true, lastSweepAt: new Date(now).toISOString(), state };
      if (!building) {
        // A build here was started by newer code (or by another worker since
        // this pass began): this generation is about to be replaced, so it
        // stays behind (never complete) until then.
        const fresh = await readGraphManifest(store, budget);
        if (fresh.manifest?.building) health.state = "behind";
        if (fresh.manifest?.generation === gen) await publishHealth(store, budget, fresh.manifest, fresh.etag, { health });
      } else if (state === "ready" && cursor.recheck && cursor.auditWrapped) {
        // This clean wrap was the re-check (OPEN-16) and the audit has
        // listed the whole generation since the first: cut over.
        const fresh = await readGraphManifest(store, budget);
        if (fresh.manifest?.building?.generation === gen) out.cutover = await cutover(store, budget, fresh, health);
        cursor.recheck = false;
      } else {
        // The first clean wrap starts a fresh audit listing for the re-check.
        if (state === "ready" && !cursor.recheck) Object.assign(cursor, { auditCursor: "", auditWrapped: false });
        cursor.recheck = state === "ready";
      }
      out.sweepComplete = true;
    } else {
      cursor.recheck = false;
    }
    Object.assign(cursor, { sweepCursor: "", sweepStartedAt: "", sweepPending: false });
  }
  if (JSON.stringify(cursor) !== before && budget.take()) {
    // A refused write means another pass moved the cursor; this one is dropped.
    await store.put(maintenanceCursorKey(gen), JSON.stringify(cursor), cursorOnlyIf);
  }
  return out;
}

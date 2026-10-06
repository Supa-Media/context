// Forward publish plus reverse repair (arch 9.4). The node record and the
// posting pages it affects are never committed together, so the record is
// published first carrying every outstanding posting change (`reverseRepair`),
// the postings are repaired, and only then is the marker cleared by a write
// conditional on the record we published. A stop anywhere in between leaves
// the obligations in the record for the next call or reconciliation.
//
// The bucket is a trust boundary: a stored record or page that does not parse,
// or carries hostile fields, is overwritten or reported, never thrown on.
import { buildNodeRecord, membershipsFor } from "./facts.js";
import { readGraphManifest, publishHealth } from "./manifest.js";
import { nodeKey, pathHash } from "./keys.js";
import { MAX_ATTEMPTS, setMembership } from "./postings.js";
import { GRAPH_FORMAT_VERSION, GRAPH_RECORD_BYTE_CAP, parseNode, serializeNode } from "./records.js";
import { exceedsUtf8Bytes } from "../search/maintain.js";

const FAMILIES = ["incoming", "bare", "names", "urls"];
const HASH = /^[0-9a-f]{64}$/;

// facts.js holds memberships as "<family>:<hash>" strings, the record holds
// `{ family, hash }` objects. These two are the only conversions.
const toRef = (m) => ({ family: m.slice(0, m.indexOf(":")), hash: m.slice(m.indexOf(":") + 1) });
const fromRef = (r) =>
  r && typeof r === "object" && FAMILIES.includes(r.family) && typeof r.hash === "string" && HASH.test(r.hash)
    ? `${r.family}:${r.hash}`
    : null;

const noRepair = (record) => Array.isArray(record.reverseRepair) && record.reverseRepair.length === 0;

/** `{ key, old, etag, exists }`, or null when the budget refuses the read. */
async function readNode(store, budget, gen, path) {
  const key = nodeKey(gen, await pathHash(path));
  if (!budget.take()) return null;
  const got = await store.get(key);
  if (!got) return { key, old: null, etag: null, exists: false };
  return { key, old: parseNode(await got.text(), path), etag: got.etag ?? null, exists: true };
}

/**
 * Memberships the stored record may have written: recomputed from its
 * occurrences, plus its outstanding `reverseRepair`. A partial record's
 * truncated occurrences undercount; what is missed carries an old
 * referenceSetVersion that `validateEntry` rejects.
 */
async function priorObligations(old, path) {
  const out = new Set();
  if (!old) return out;
  if (old.coverage !== "excluded") {
    try {
      for (const m of (await membershipsFor(path, old.occurrences)).memberships) out.add(m);
    } catch {
      // Hostile occurrences: nothing recoverable from them.
    }
  }
  if (Array.isArray(old.reverseRepair)) {
    for (const r of old.reverseRepair) {
      const m = fromRef(r);
      if (m) out.add(m);
    }
  }
  return out;
}

/**
 * The record to publish with its obligations, fitted under the record cap
 * (OPEN-7). Obligations win over forward facts: occurrences go first, then the
 * tail of `reverseRepair`. Either way the node is partial.
 */
function withObligations(record, ordered) {
  const full = { ...record, reverseRepair: ordered.map(toRef) };
  if (!exceedsUtf8Bytes(serializeNode(full), GRAPH_RECORD_BYTE_CAP)) return { published: full, overflow: false };
  const bare = { ...full, occurrences: [], externalReferences: [], coverage: "partial" };
  const fits = (k) => !exceedsUtf8Bytes(serializeNode({ ...bare, reverseRepair: bare.reverseRepair.slice(0, k) }), GRAPH_RECORD_BYTE_CAP);
  let lo = 0;
  let hi = bare.reverseRepair.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return { published: { ...bare, reverseRepair: bare.reverseRepair.slice(0, lo) }, overflow: true };
}

/** Steps 2 to 5 of arch 9.4 for a built record and its new membership set. */
async function settle(store, budget, { gen, mode, path, read, record, memberships, remove }) {
  const conditional = mode === "conditional";
  const union = await priorObligations(read.old, path);
  for (const m of memberships) union.add(m);
  // Additions first, so a trimmed record keeps the obligations whose loss
  // would hide a real backlink (a missed removal is rejected by validateEntry).
  const ordered = [...union].sort((a, b) => Number(memberships.has(b)) - Number(memberships.has(a)));
  const { published, overflow } = withObligations(record, ordered);
  // Mark the dropped portion for a rebuild before the record that drops it.
  if (overflow) await flagRebuild(store, budget);

  if (!budget.take()) return { state: "pending" };
  const onlyIf = (etag) => (conditional ? { onlyIf: etag ? { etagMatches: etag } : { absent: true } } : undefined);
  const put = await store.put(read.key, serializeNode(published), onlyIf(read.etag));
  if (!put) return { state: "stale" };

  let unfinished = false;
  let full = false;
  for (const m of ordered) {
    const { family, hash } = toRef(m);
    const result = await setMembership(store, budget, {
      gen, family, hash, source: path, referenceSetVersion: record.referenceSetVersion, present: memberships.has(m), mode,
    });
    if (result === "budget") return { state: "pending" };
    // "full": the chain cannot take the entry; drop the obligation and report
    // the node partial so moves touching it fall back to the scan (arch 9.4).
    if (result === "full") full = true;
    else if (result !== "done") unfinished = true;
  }
  if (unfinished || !budget.take()) return { state: "pending" };
  // Conditional on the record we published, so it still names the same
  // observedSourceVersion and referenceSetVersion; a newer record and its
  // obligations are never erased.
  if (conditional && !put.etag) return { state: "pending" };
  let done;
  if (remove && store.capabilities?.conditionalDelete === true) {
    done = (await store.delete(read.key, conditional ? { onlyIf: { etagMatches: put.etag } } : undefined)) !== null;
  } else {
    const cleared = { ...record, reverseRepair: [], ...(full && { coverage: "partial" }) };
    done = Boolean(await store.put(read.key, serializeNode(cleared), onlyIf(put.etag)));
  }
  if (done) return { state: "projected" };
  return conditional ? handBack(store, budget, read.key, path, ordered) : { state: "stale" };
}

/**
 * A newer record replaced ours while our repairs ran, so those repairs may
 * have overwritten postings the newer call already settled (setMembership
 * matches by source). Hand our keys to the newest record so the next
 * projection or sweep reconciles them against it. Returns "pending" whether
 * the hand-back landed or gave up after MAX_ATTEMPTS, and "stale" when the
 * record is gone or does not parse.
 */
async function handBack(store, budget, key, path, ordered) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (!budget.take()) return { state: "pending" };
    const got = await store.get(key);
    const node = got ? parseNode(await got.text(), path) : null;
    if (!node) return { state: "stale" };
    const keys = new Set(Array.isArray(node.reverseRepair) ? node.reverseRepair.map(fromRef).filter(Boolean) : []);
    for (const m of ordered) keys.add(m);
    const { published, overflow } = withObligations(node, [...keys]);
    if (overflow) await flagRebuild(store, budget);
    if (!budget.take()) return { state: "pending" };
    if (await store.put(key, serializeNode(published), { onlyIf: { etagMatches: got.etag } })) return { state: "pending" };
  }
  return { state: "pending" };
}

async function flagRebuild(store, budget) {
  const { manifest, etag } = await readGraphManifest(store, budget);
  if (manifest) await publishHealth(store, budget, manifest, etag, { health: { rebuildHint: "reverse-repair-overflow" } });
}

/**
 * Publish `path`'s forward record for `body` at `version` and repair its
 * reverse postings. Returns `{ state }`: "projected" (record current, no
 * outstanding work), "pending" (stopped by the budget or a posting conflict;
 * the record, if published, carries the outstanding work), "skipped" (the
 * stored record already observed `version` and has nothing outstanding) or
 * "stale" (the publish was refused: the caller re-reads the source rather
 * than retrying this body, arch 9.4). A refused clear is "pending": this
 * call's keys are handed to the newer record (see handBack).
 */
export async function projectNote(store, path, body, version, { budget, gen, mode, now }) {
  // Read the record before using body/version (arch 9.4 last paragraph).
  const read = await readNode(store, budget, gen, path);
  if (!read) return { state: "pending" };
  if (read.old && read.old.observedSourceVersion === version && noRepair(read.old)) return { state: "skipped" };
  const { record, memberships } = await buildNodeRecord(path, body, version, { now });
  return settle(store, budget, { gen, mode, path, read, record, memberships, remove: false });
}

/**
 * Remove `path` from the graph: the same procedure with no memberships, then
 * the record is deleted (conditional delete) or left as an `excluded`
 * tombstone with nothing outstanding. Same states as `projectNote`.
 */
export async function removeNote(store, path, { budget, gen, mode }) {
  const read = await readNode(store, budget, gen, path);
  if (!read) return { state: "pending" };
  if (!read.exists) return { state: "skipped" };
  const tombstoned = read.old?.coverage === "excluded" && noRepair(read.old);
  if (tombstoned && store.capabilities?.conditionalDelete !== true) return { state: "skipped" };
  const record = {
    formatVersion: GRAPH_FORMAT_VERSION,
    path,
    observedSourceVersion: null,
    referenceSetVersion: null,
    occurrences: [],
    externalReferences: [],
    coverage: "excluded",
    reverseRepair: [],
  };
  return settle(store, budget, { gen, mode, path, read, record, memberships: new Set(), remove: true });
}

/**
 * `validate` for `readPostings` (arch 9.3): an entry counts only when its
 * source's node record parses for that path, is not `excluded`, and names the
 * same referenceSetVersion. A budget refusal throws, which `readPostings`
 * reports as incomplete rather than as a rejected entry.
 */
export function validateEntry(store, budget, gen) {
  return async (entry) => {
    const key = nodeKey(gen, await pathHash(entry.source));
    if (!budget.take()) throw new Error("graph budget exhausted");
    const got = await store.get(key);
    if (!got) return false;
    const node = parseNode(await got.text(), entry.source);
    return node !== null && node.coverage !== "excluded" && node.referenceSetVersion === entry.referenceSetVersion;
  };
}

import { addDoc, removeDoc } from "../indexer.js";
import { exceedsUtf8Bytes } from "../maintain.js";
import { FIELD_ORDER, NEUTRAL_RANK, AUDIT_SHARDS_PER_SYNC } from "./constants.js";
import { serializeShard } from "./serialize.js";

// -- the sync loop ---------------------------------------------------------

/**
 * Per-shard bookkeeping, derived from the shard's own docs and nothing else.
 *
 * `shedPaths` is `shed`'s own evidence, not a second count of it: **the
 * identities are what let a caller be told which of their own visible notes
 * lost recall**, the way `pending`'s callers are told which notes are stale
 * rather than only how many. Sorted so the manifest's serialized bytes do not
 * churn on note order alone, the same reason every other array here is.
 */
export function statsOfShard(shard) {
  const lenTotals = { title: 0, headings: 0, tags: 0, body: 0 };
  // Notes this shard holds only part of — see `shedToFit`. Counted off the
  // docs themselves rather than remembered from the pass that shed them, so
  // it cannot outlive the condition: a note re-indexed in full arrives with
  // no shed doc among its fresh ones and stops being counted here.
  const shed = new Set();
  for (const doc of shard.docs.values()) {
    for (const field of FIELD_ORDER) lenTotals[field] += doc.len[field];
    if (doc.shed) shed.add(doc.notePath ?? null);
  }
  return { docCount: shard.docs.size, lenTotals, shed: shed.size, shedPaths: [...shed].sort() };
}

/**
 * `docsByShard`'s entry for one shard: note path → the version token it was
 * indexed at.
 *
 * Keyed by **`doc.notePath`, never by the doc's own key** — the diff surface
 * tracks real bucket notes, one entry per listed object, and a channel-day
 * note contributes several docs sharing one key. Every sub-document of one
 * note is written in the same fetch and carries the same `etag`, so any one
 * of them names the version the whole note was indexed at; `Map.set` on a
 * repeated key is idempotent for an identical value, so which one "wins" does
 * not matter.
 */
export function docVersionsOf(shard) {
  const versions = new Map();
  for (const doc of shard.docs.values()) {
    const notePath = typeof doc.notePath === "string" ? doc.notePath : null;
    if (notePath !== null) versions.set(notePath, doc.etag);
  }
  return versions;
}

export function sameVersions(a, b) {
  if (a.size !== b.size) return false;
  for (const [path, version] of a) if (b.get(path) !== version) return false;
  return true;
}

function sameShedPaths(a, b) {
  const pathsA = a || [];
  const pathsB = b || [];
  if (pathsA.length !== pathsB.length) return false;
  // Both sides are written sorted (`statsOfShard`, `parseManifest`), so a
  // positional compare is exact rather than a heuristic.
  return pathsA.every((path, i) => path === pathsB[i]);
}

export function sameStats(a, b) {
  return (
    a.docCount === b.docCount &&
    (a.shed || 0) === (b.shed || 0) &&
    // Two shards can shed the same COUNT of different notes — a fresh note
    // pushing an older one over the cap, say — and a compare that stopped at
    // the count would call that "unchanged" and leave `shedPaths` stale.
    sameShedPaths(a.shedPaths, b.shedPaths) &&
    FIELD_ORDER.every((field) => a.lenTotals[field] === b.lenTotals[field])
  );
}

/**
 * How much of a shard's serialized body one doc is responsible for, near
 * enough to choose which to drop.
 *
 * Token counts, because the postings are what a shard is mostly made of: a
 * doc's entry in `docs` is a constant few hundred bytes, and its share of
 * `terms` is one interned posting per distinct term in it. Measured across two
 * corpora that differ as much as any two do — 300 ordinary notes at the
 * per-note cap and 400 channel-day sub-documents — 18 to 26 bytes per token,
 * which is close enough to rank contributors and nowhere near close enough to
 * predict a size, which is why the loop below re-serializes rather than
 * projecting.
 */
function docWeight(key, doc) {
  return key.length + doc.len.title + doc.len.headings + doc.len.tags + doc.len.body;
}

/**
 * Notes one over-cap shard may shed before it is given up on and refused.
 *
 * One note per round with a full re-serialization between them, so this is
 * also the CPU bound on the pathological path: at most eight `JSON.stringify`
 * of a shard already at its cap, on top of the one every touched shard pays
 * anyway. A shard needing more than this reports `oversizedShards` rather than
 * grinding, and the pass after it starts from the same place.
 */
const SHED_ROUNDS = 8;

/**
 * Make an over-cap shard writable by dropping documents from the notes that
 * are largest in it, and answer the body to write plus the notes that lost
 * something.
 *
 * **The rule this exists for: a shard that cannot be written must not take the
 * rest of the context's search down with it.** Before this, a body over
 * `SHARD_PARSE_BYTE_CAP` was simply not written — correct in isolation, since
 * storing an object this module refuses to read is a rebuild loop — but it
 * meant every ordinary note that happened to share the shard with a heavy
 * bundled note was unsearchable too, and the reported reason was `pending`,
 * which reads as "still catching up" rather than "this will never fit".
 *
 * So the shard sheds instead: the note contributing most to it gives up
 * documents until the body fits, largest note first. What that costs is stated
 * rather than hidden:
 *
 * - **A shed note is never dropped, only reduced.** It keeps at least one
 *   document, and where it is down to its last one that document is *blanked*
 *   — kept, carrying its title and no body — rather than removed. Removing it
 *   would take the note out of `docVersionsOf`, which makes it stale on every
 *   later listing, re-fetched forever: the non-convergence
 *   `subDocumentsFor`'s own fallback exists to avoid, and a burn loop on the
 *   customer's own budget. Reduced, the note converges and simply answers
 *   fewer queries than it did.
 * - **So an ordinary note in an over-cap shard loses its body from the index**,
 *   which is a real recall loss and the honest trade: the alternative — the one
 *   this replaced — was every note in the shard losing everything, permanently,
 *   while `pending` told the caller to keep running passes that could never
 *   land. One note quietly answering less is worse than nothing and much
 *   better than four.
 * - **The loss is recorded** — the surviving docs carry `shed`,
 *   `statsOfShard` counts the notes, and the manifest carries the count to the
 *   query side, so an answer knows the index is incomplete for a reason that
 *   will not resolve by waiting.
 * - **It is sticky until the note changes or the index is rebuilt.** Sizing
 *   and placement run before this on every pass, so a shard reaching here has
 *   already failed to be given room; re-trying the full set each pass would
 *   spend the same reads to shed it again. A rebuild re-derives it from the
 *   files with whatever room the index has then, which is the disposable
 *   derivative's own answer to a state it does not like.
 *
 * @param {ReturnType<typeof emptyShard>} shard mutated
 * @param {string} body the serialization already found to be over the cap
 * @param {number} cap
 * @returns {{body: string|null, shed: string[]}} `body: null` where no amount
 *   of shedding got it under the cap
 */
export function shedToFit(shard, body, cap) {
  const shed = new Set();
  let current = body;
  for (let round = 0; round < SHED_ROUNDS; round += 1) {
    if (!exceedsUtf8Bytes(current, cap)) return { body: current, shed: [...shed] };

    /** @type {Map<string, {keys: string[], weight: number}>} */
    const byNote = new Map();
    for (const [key, doc] of shard.docs) {
      const notePath = doc.notePath ?? key;
      const entry = byNote.get(notePath) || { keys: [], weight: 0 };
      entry.keys.push(key);
      entry.weight += docWeight(key, doc);
      byNote.set(notePath, entry);
    }

    // **One note per round, and the body re-serialized between them.** The
    // obvious cheaper loop — take the overshoot as a fraction of the shard's
    // weight and shed that fraction in one sweep — was measured and sheds far
    // too much: weight is tokens, and a note of two hundred *unique* terms
    // costs several times the bytes per token of one written in the shard's
    // existing vocabulary, so the share taken from the notes that are cheap
    // per token is paid by notes that never needed to lose anything. Measured
    // on a fixture of one dense note beside six ordinary ones: the sweep
    // blanked all seven where shedding the dense one alone was enough.
    // Re-measuring after each note is the only estimate of a serialized size
    // that is not a model of one, and its cost is bounded — a shard reaching
    // here is already over its cap, and there are at most `SHED_ROUNDS` of it.
    let heaviest = null;
    for (const [notePath, entry] of byNote) {
      // Nothing left to give: one document, already blank.
      if (entry.keys.length === 1 && !hasBody(shard.docs.get(entry.keys[0]))) continue;
      if (
        heaviest === null ||
        entry.weight > heaviest[1].weight ||
        (entry.weight === heaviest[1].weight && notePath < heaviest[0])
      ) {
        heaviest = [notePath, entry];
      }
    }
    // Every note is down to a blank document and the shard still will not fit.
    // Refused, exactly as it was before shedding existed, and counted so the
    // caller is told which of the two things happened.
    if (heaviest === null) return { body: null, shed: [...shed] };

    const [notePath, entry] = heaviest;
    // Everything after the first document goes; the first is blanked where it
    // is all that is left. Which documents survive is the shard's own stored
    // order — the order they were indexed in for a note this pass wrote, and
    // sorted-by-key order for one it read back. A bounded subset either way,
    // and not a promise about which messages it holds.
    while (entry.keys.length > 1) removeDoc(shard, entry.keys.pop());
    const key = entry.keys[0];
    const doc = shard.docs.get(key);
    if (hasBody(doc)) {
      removeDoc(shard, key);
      addDoc(shard, key, {
        etag: doc.etag,
        uploaded: doc.uploaded,
        // Blanked, not removed: the note keeps an entry — and with it the
        // version `docVersionsOf` records — so the diff converges instead of
        // re-fetching it on every pass forever.
        content: "",
        notePath: doc.notePath,
        anchor: doc.anchor,
        comms: doc.comms,
      });
      shard.docs.get(key).rank = NEUTRAL_RANK;
    }
    // The survivors carry the flag, so the fact travels in the shard's own
    // bytes rather than in a memory of this pass.
    for (const surviving of entry.keys) shard.docs.get(surviving).shed = true;
    shed.add(notePath);
    current = serializeShard(shard);
  }
  return exceedsUtf8Bytes(current, cap)
    ? { body: null, shed: [...shed] }
    : { body: current, shed: [...shed] };
}

/** Whether a doc still has anything but its title to give up. */
function hasBody(doc) {
  return doc.len.headings + doc.len.tags + doc.len.body > 0;
}

export function pushInto(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * `now` as milliseconds, the way `searchIndex` reads its own: a `Date`, a
 * finite number, and anything else is the wall clock. Injectable only so a test
 * can pin which shard a pass rotates onto; nothing in production passes it.
 */
export function nowMsOf(now) {
  if (now instanceof Date) {
    const ms = now.getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  }
  if (typeof now === "number" && Number.isFinite(now)) return now;
  return Date.now();
}

/**
 * Up to `AUDIT_SHARDS_PER_SYNC` shard ids to open even though the diff wants
 * nothing from them: vouched for by the manifest (a shard it says is empty has
 * no object to be corrupt) and not already in the worklist.
 *
 * **The rotation is clock-derived, and deliberately not `manifest.generatedAt`.**
 * The obvious rotation — step the offset with each manifest write — sticks: an
 * audit that finds the shard healthy writes nothing, so `generatedAt` does not
 * advance, and every later pass re-checks that same shard forever while the
 * unreadable one is never reached. Coverage has to advance on passes that
 * change nothing, which is exactly the pass this exists for, so it advances on
 * the only thing that moves on its own.
 *
 * The scan steps forward from the offset so a shard the worklist already holds
 * costs the audit a neighbour rather than the whole pass.
 */
export function auditCandidates(manifest, busy, nowMs, count = AUDIT_SHARDS_PER_SYNC) {
  const { shardCount } = manifest;
  const picked = [];
  if (count < 1 || !Number.isInteger(shardCount) || shardCount < 1) return picked;
  const start = ((Math.floor(nowMs) % shardCount) + shardCount) % shardCount;
  for (let step = 0; step < shardCount && picked.length < count; step += 1) {
    const id = (start + step) % shardCount;
    if (busy.has(id)) continue;
    if (manifest.docsByShard[id].size === 0) continue;
    picked.push(id);
  }
  return picked;
}

/**
 * Bring `.context/search/v2/` as close to the bucket as one budget allows, and hand back
 * what was built — CONTRACT.md § "The sharded index … Maintenance".
 *
 * GET the manifest, list the notes, diff the listing against `docsByShard`,
 * group what changed by shard, and then per shard in id order: read it, fetch
 * its stale notes in waves, re-index them, write it. The manifest is written
 * last and conditionally, because it is the concurrency point — the shards
 * under it are written unconditionally, and a shard written by a pass whose
 * manifest write then lost the race is simply re-derived by the pass that won.
 *
 * Then, on whatever budget the real work left, one more shard the diff asked
 * nothing of — `AUDIT_SHARDS_PER_SYNC`, rotating. The diff is over the manifest
 * alone, so a shard whose stored object is unreadable while none of its notes
 * changed is in no worklist at all: it heals only when somebody edits one of
 * its notes, and until then the manifest vouches for docs no query can reach.
 * An audited shard that arrives unreadable needs nothing new to repair it — it
 * is an empty shard on the loop's own terms, and the work list below is derived
 * from the shard that arrived rather than from the manifest for exactly that
 * reason.
 *
 * Three ways a pass can be incomplete, and each is reported rather than
 * papered over:
 *
 * - `shed` / `oversizedShards` — the corpus not fitting the index rather
 *   than the pass running out of room in it. A bundled note whose documents a
 *   shard could not hold whole is shed down to what fits and named here; a
 *   shard with nothing to shed is not written and counted here. Separate from
 *   `pending` because they ask for opposite things: `pending` says run again,
 *   and these say another pass will find exactly the same wall.
 * - `pending` — stale notes this pass did not land. That includes the notes of
 *   a shard whose serialized form crossed `SHARD_PARSE_BYTE_CAP`, which is a
 *   deliberate difference from v1's `pending` (v1 reports what the *answer*
 *   holds, and a refused write can still be `pending: 0`). In v2 the query side
 *   streams shards **from the bucket**, so a shard that was not persisted is
 *   not in the next answer, and calling that zero would be the floor language
 *   going quiet on exactly the shard that plateaued.
 * - `listingTruncated` — the walk did not finish, so no doc may be removed for
 *   being absent from it.
 * - `manifestOverflow` — the manifest itself crossed its cap and was not
 *   written. The shards were, so nothing is lost; the diff simply cannot record
 *   what it did until the manifest fits.
 *
 * @param {import("../store/index.js").ContextStore} store
 * @param {{
 *   budget: number | ReturnType<typeof createSearchBudget>,
 *   reserve?: number,
 *   isIndexable?: (key: string) => boolean,
 *   shardByteCap?: number,
 *   manifestByteCap?: number,
 *   now?: Date | number,
 * }} options `reserve` is store ops the caller keeps for its own later work.
 * @returns {Promise<{
 *   manifest: ReturnType<typeof emptyManifest>,
 *   shards: Map<number, ReturnType<typeof emptyShard>>,
 *   pending: number,
 *   listingTruncated: boolean,
 *   manifestOverflow: boolean,
 *   changed: boolean,
 *   committed: boolean,
 *   shed: string[],
 *   oversizedShards: number,
 *   spent: number,
 * }>} `shards` holds only what this pass loaded or built.
 */

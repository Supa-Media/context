/**
 * The sync loop half of the search format contract — CONTRACT.md § Maintenance.
 *
 * One bounded pass per search: read the stored index, list the notes, diff by
 * etag, re-index as much of what changed as the budget allows, write it back
 * conditionally. The failure this module exists to remove is measured, not
 * hypothetical: a 154-note context answered every unprefixed search with
 * "Too many subrequests", because the brute-force scan fetched every note.
 * Cloudflare's free tier allows 50 subrequests per invocation, so **every**
 * store call here goes through one counter and a search can never spend more
 * than the caller allowed.
 *
 * The index is a **disposable derivative** (CLAUDE.md, plain-files rule), and
 * three consequences of that are deliberate rather than omissions:
 *
 * - It is **not snapshotted to `.history/`**. Versioning a derivative of
 *   versioned files is waste, and `.history/` is already the largest thing in
 *   a real bucket.
 * - It is **not written to `.audit/`**. The audit trail records what a person
 *   or an agent did to somebody's notes; nobody did this, and an audit line per
 *   search would bury the lines that matter.
 * - It **never gates correctness**. Anything this pass could not finish comes
 *   back as `pending` / `listingTruncated` rather than being papered over, and
 *   a caller that gets an exception falls back to the bounded scan.
 *
 * The index contains text drawn from private notes — acceptable inside the
 * customer's own bucket, beside those notes, and never acceptable in what
 * leaves the gateway. Nothing in this module filters by visibility, because
 * nothing in this module returns anything to a caller: `canSee` is applied to
 * every result by the gateway, after this returns.
 */

import { addDoc, emptyIndex, parseIndex, removeDoc, serializeIndex } from "./indexer.js";
import { computeRanks } from "./query.js";

/**
 * One object per bucket. Dot-prefixed on purpose: `isPlumbing` already hides
 * every dot-segment key from every tool at every scope, so the index is
 * unreachable through the note surface without a single new rule.
 */
export const SEARCH_INDEX_KEY = ".index/search-v1.json";

const LIST_PAGE_LIMIT = 1000;
/**
 * The stored index is refused, unparsed, past this size — and rebuilt slim.
 *
 * The Worker's 128MB memory limit is the one ceiling no plan raises, and
 * `JSON.parse` of a large index inflates it several-fold in the heap. Measured
 * live: a brain whose full-text chat archives had been indexed whole grew an
 * index big enough that parsing it killed every invocation — uncatchably, past
 * the top-level catch — so search was down *because of* its own accelerator,
 * and no pass survived long enough to shrink the object. Refusing to parse is
 * what breaks that cycle: an oversized index is treated exactly like a corrupt
 * one, rebuilt from the notes under `NOTE_INDEX_CHAR_CAP`, and overwritten.
 *
 * This is a ceiling, not a cure: a brain whose *capped* index still exceeds
 * this size (roughly 10k+ notes) would churn — refused, partially rebuilt,
 * regrown, refused again. At that scale the index needs sharding (per-folder
 * postings, a small global-stats object); that is v2 work, stated here so the
 * churn is recognized as this boundary rather than rediscovered as a mystery.
 */
const INDEX_PARSE_BYTE_CAP = 12_000_000;
/**
 * At most this much of one note's content is indexed.
 *
 * The median note is a few KB; the outliers are saved chat sessions and agent
 * ledgers at 64KB+, and indexing those whole is what bloated the index past
 * the memory ceiling above. The first N characters carry a long note's
 * frontmatter, title, headings and opening prose — the parts ranking weighs
 * most — so the recall lost is the tail of the largest logs, and the note
 * still surfaces by everything that matters. The cut is by characters of
 * source text, before tokenization, so `len` and tf stay consistent with what
 * was actually indexed.
 */
const NOTE_INDEX_CHAR_CAP = 8_192;
/** Never spend the last op on listing or fetching; the write needs one. */
const WRITE_RESERVE = 1;
/** Nor let the listing consume everything a backfill would have used. */
const FETCH_FLOOR = 2;

/**
 * The shared subrequest counter. Every `get`, `put` and `list` this module
 * performs takes one, and `reserve` is how a caller keeps ops back for work it
 * will do after this returns (snippet reads). A caller that constructs the
 * budget itself still holds it when `syncIndex` throws, which is what lets the
 * fallback scan know how much of the invocation is left.
 */
export function createSearchBudget(total) {
  let remaining = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  let spent = 0;
  return {
    get remaining() {
      return remaining;
    },
    get spent() {
      return spent;
    },
    /** Spend one store op without dipping into `reserve`; false if it cannot. */
    take(reserve = 0) {
      if (remaining <= reserve) return false;
      remaining -= 1;
      spent += 1;
      return true;
    },
  };
}

/**
 * The default note filter: `.md`, no dot-prefixed segment, and not one of the
 * two root plumbing keys the gateway keeps outside the note surface.
 *
 * The gateway passes its own `isPlumbing`-backed predicate, so there is one
 * authority in the worker and this is not a second one. It exists so the module
 * stands alone (self-hosting, tests), and `searchIntegration.test.mjs` asserts
 * a real gateway search never lands `privacy.md`, `scopes.yml` or a dot-segment
 * key in the index — a duplicated rule that nothing checks is the "guard nobody
 * has checked" failure CLAUDE.md names.
 */
export function defaultIsIndexable(key) {
  if (typeof key !== "string" || !key.endsWith(".md")) return false;
  if (key === "privacy.md" || key === "scopes.yml") return false;
  return !key.split("/").some((segment) => segment.startsWith("."));
}

function toIso(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString() : null;
  }
  return typeof value === "string" && value ? value : null;
}

/**
 * The token the diff compares against.
 *
 * R2 and S3 both report an etag per listed object and that is what this uses.
 * Dropbox lists `server_modified` and `size` and no etag at all, so the
 * fallback is those two — a staleness token, not an etag, and named `version`
 * everywhere below for that reason. Without it every note would compare unequal
 * on every pass and the backfill would never converge: the index would be
 * rebuilt from scratch, 20-odd notes at a time, forever.
 *
 * The fallback's blind spot is documented rather than hidden: two edits within
 * the same second that leave the size unchanged look identical, and that note
 * is re-indexed on its next edit instead. A derivative that is one edit stale
 * is the cost; a bucket that never finishes indexing is not.
 */
function versionOf(object) {
  if (typeof object.etag === "string" && object.etag) return object.etag;
  const size = Number.isFinite(object.size) ? object.size : "";
  return `${toIso(object.uploaded) || ""}:${size}`;
}

/**
 * One paged listing, bounded by the shared budget.
 *
 * Returns whether it *finished*. That is the load-bearing half: an unfinished
 * listing is never evidence that a key is gone, and treating it as evidence
 * would silently delete docs from the index for exactly the largest contexts.
 *
 * A page that reports `truncated` with no continuation token, or replays a
 * cursor, ends the walk as unfinished rather than throwing — `listAllKeys`
 * throws for a move, where a partial answer is a wrong answer; maintenance is
 * the opposite case and reports instead.
 */
async function listPaged(store, { prefix, delimiter }, budget, reserve, onObject, onPrefix) {
  const seen = new Set();
  let cursor;
  for (;;) {
    if (!budget.take(reserve)) return false;
    const page = await store.list({
      prefix: prefix || undefined,
      delimiter,
      cursor,
      limit: LIST_PAGE_LIMIT,
    });
    for (const object of page.objects || []) onObject(object);
    if (onPrefix) for (const childPrefix of page.delimitedPrefixes || []) onPrefix(childPrefix);
    if (!page.truncated) return true;
    if (!page.cursor || seen.has(page.cursor)) return false;
    seen.add(page.cursor);
    cursor = page.cursor;
  }
}

/**
 * Every indexable note key with the token to diff it by.
 *
 * Delimited at the root, then flat inside each real folder — not an
 * optimisation. A flat walk from the root returns `.history/…` first, because
 * "." sorts before every digit and letter, so it spends its whole budget inside
 * the history and reports zero notes for the biggest contexts there are. That
 * is the same trap `surveyContext` and the console's note census both document.
 */
async function listNoteObjects(store, budget, reserve, isIndexable) {
  const entries = new Map();
  const folders = new Set();
  const listingReserve = reserve + WRITE_RESERVE + FETCH_FLOOR;

  const record = (object) => {
    if (!isIndexable(object.key)) return;
    entries.set(object.key, {
      version: versionOf(object),
      uploaded: toIso(object.uploaded),
      // Whether that token is the backend's own etag, which decides what the
      // backfill may store back — see the comment at the `addDoc` call.
      fromEtag: typeof object.etag === "string" && object.etag.length > 0,
    });
  };

  const rootComplete = await listPaged(
    store,
    { prefix: "", delimiter: "/" },
    budget,
    listingReserve,
    (object) => {
      const slash = object.key.indexOf("/");
      // A listing that ignores `delimiter` (the suite's in-memory stub does)
      // still yields the same folder set this way, so the walk shape is the
      // same against a stub and against R2.
      if (slash === -1) record(object);
      else folders.add(object.key.slice(0, slash + 1));
    },
    (childPrefix) => folders.add(childPrefix)
  );

  const realFolders = [...folders].filter((prefix) => !prefix.startsWith(".")).sort();
  const folderComplete = new Map();
  for (const prefix of realFolders) {
    folderComplete.set(
      prefix,
      await listPaged(store, { prefix }, budget, listingReserve, record)
    );
  }

  /**
   * Whether the region a path lives in was listed to the end — the only ground
   * on which a doc may be removed for being absent.
   */
  const regionComplete = (path) => {
    const slash = path.indexOf("/");
    if (slash === -1) return rootComplete;
    const prefix = path.slice(0, slash + 1);
    // A folder the root listing never named is gone; a dot-prefixed one was
    // never walked on purpose. Either way the root listing is what decides.
    if (!folderComplete.has(prefix)) return rootComplete;
    return folderComplete.get(prefix) === true;
  };

  const truncated =
    !rootComplete || realFolders.some((prefix) => folderComplete.get(prefix) !== true);
  return { entries, regionComplete, truncated };
}

/**
 * Bring `.index/search-v1.json` as close to the bucket as one budget allows,
 * and hand back what was built.
 *
 * @param {import("../store/index.js").ContextStore} store
 * @param {{
 *   budget: number | ReturnType<typeof createSearchBudget>,
 *   reserve?: number,
 *   isIndexable?: (key: string) => boolean,
 * }} options `reserve` is store ops the caller keeps for its own later work.
 * @returns {Promise<{
 *   index: ReturnType<typeof emptyIndex>,
 *   pending: number,
 *   listingTruncated: boolean,
 *   spent: number,
 * }>} `pending` is stale notes this pass did not get to.
 */
export async function syncIndex(store, { budget, reserve = 0, isIndexable = defaultIsIndexable } = {}) {
  const ops = typeof budget === "object" && budget ? budget : createSearchBudget(budget);

  let index = emptyIndex();
  if (!ops.take(reserve)) {
    return { index, pending: 0, listingTruncated: true, spent: ops.spent };
  }
  const stored = await store.get(SEARCH_INDEX_KEY);
  const storedEtag = typeof stored?.etag === "string" && stored.etag ? stored.etag : null;
  if (stored) {
    // A corrupt, wrong-version, or oversized index is a rebuild, never a
    // throw: `parseIndex` answers null for anything it cannot fully validate,
    // the byte cap refuses to even parse an object big enough to endanger the
    // memory limit, and the conditional put below replaces the bad object with
    // a good one. The size is read from the bytes, not a header, because the
    // header is the backend's word for it.
    const bytes = await stored.arrayBuffer();
    index =
      (bytes.byteLength <= INDEX_PARSE_BYTE_CAP &&
        parseIndex(new TextDecoder().decode(bytes))) ||
      emptyIndex();
  }

  const { entries, regionComplete, truncated } = await listNoteObjects(
    store,
    ops,
    reserve,
    isIndexable
  );

  let changed = false;

  // Removals are free — no store op — so they always run to completion.
  for (const path of [...index.docs.keys()]) {
    if (entries.has(path)) continue;
    if (!regionComplete(path)) continue;
    removeDoc(index, path);
    changed = true;
  }

  const stale = [];
  for (const [path, listed] of entries) {
    const doc = index.docs.get(path);
    if (!doc || doc.etag !== listed.version) stale.push([path, listed]);
  }

  // Fetched in parallel waves, indexed in `stale` order once a wave lands.
  //
  // This loop was one awaited GET at a time, and that was a wall-clock bug the
  // subrequest budget could not see: a paid-plan budget of 600 authorizes ~580
  // fetches, which sequentially is 30-60 seconds — past what MCP clients wait —
  // so the client timed out, the invocation died with it, the conditional put
  // never ran, and a *bigger* budget made convergence *less* likely. Measured
  // live before any client saw a converged index. The budget is still taken
  // one op per fetch, before the fetch, on one shared counter; only the
  // waiting overlaps. `addDoc` runs wave by wave in list order, so what the
  // index contains for a given spend is what the sequential loop would have
  // built.
  const BACKFILL_CONCURRENCY = 12;
  let processed = 0;
  for (let start = 0; start < stale.length; start += BACKFILL_CONCURRENCY) {
    const wave = [];
    for (const entry of stale.slice(start, start + BACKFILL_CONCURRENCY)) {
      if (!ops.take(reserve + WRITE_RESERVE)) break;
      wave.push(
        (async ([path, listed]) => {
          let object;
          try {
            object = await store.get(path);
          } catch {
            // One unreadable note must not cost the query its whole answer —
            // and it must not cost the *rest of the backfill* either. An
            // earlier version stopped the walk here, which parked the sync at
            // the same note on every pass forever: the stale list is in
            // listing order, so a single key the adapter refuses (a backslash,
            // a control character — keys Obsidian and rclone write without
            // asking us) stalled indexing for every note that sorts after it.
            // That is the census's "one oddly named folder suppressed the
            // whole count" trap, one layer down. Skip it: the attempt already
            // spent its budget op, so a bucket full of unreadable notes still
            // terminates, and the note stays in `pending`, so the floor
            // language keeps being said.
            return null;
          }
          if (!object) return { path, gone: true };
          const full = await object.text();
          const content = full.length > NOTE_INDEX_CHAR_CAP ? full.slice(0, NOTE_INDEX_CHAR_CAP) : full;
          // Record the token the *next* listing will report, or the diff never
          // converges. Where the listing carries a real etag that is the etag
          // this read returned (a write that landed in between is caught on
          // the next pass); where it does not, the object's real etag would
          // never equal the synthetic token and every note would look stale
          // forever.
          const version =
            listed.fromEtag && typeof object.etag === "string" && object.etag
              ? object.etag
              : listed.version;
          return { path, uploaded: listed.uploaded, content, version };
        })(entry)
      );
    }
    if (wave.length === 0) break;
    for (const result of await Promise.all(wave)) {
      if (!result) continue;
      processed += 1;
      if (result.gone) {
        // Deleted between the listing and the read. Dropping it is right in a
        // way the removal pass above cannot be: we asked for it by name and it
        // is not there.
        if (index.docs.has(result.path)) {
          removeDoc(index, result.path);
          changed = true;
        }
        continue;
      }
      addDoc(index, result.path, {
        etag: result.version,
        uploaded: result.uploaded,
        content: result.content,
      });
      changed = true;
    }
    if (wave.length < Math.min(BACKFILL_CONCURRENCY, stale.length - start)) break;
  }

  if (changed) {
    computeRanks(index);
    if (ops.take(0)) {
      const body = serializeIndex(index);
      // Conditional on the etag read at the top. Where no index object existed
      // the write is unconditional: the ContextStore surface offers
      // `onlyIf.etagMatches` and nothing else — both adapters refuse an
      // `onlyIf` without one — so there is no create-only precondition to use.
      // The cost is bounded and self-healing: two concurrent first searches
      // each write a complete derivative and the later one wins.
      //
      // A `null` back means somebody else synced first. Serve the query from
      // what was built and skip the write — a lost write is one extra sync
      // later, a retry loop is this query's budget spent on plumbing.
      await (storedEtag
        ? store.put(SEARCH_INDEX_KEY, body, { onlyIf: { etagMatches: storedEtag } })
        : store.put(SEARCH_INDEX_KEY, body));
    }
  }

  return {
    index,
    pending: stale.length - processed,
    listingTruncated: truncated,
    spent: ops.spent,
  };
}

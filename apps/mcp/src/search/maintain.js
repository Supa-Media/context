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
 * The one size the index may reach, in bytes, and it governs both directions.
 *
 * A stored index past it is refused unparsed and rebuilt slim; an index the
 * sync builds past it is not written at all. Those are two halves of one rule
 * — **never store an object this same function will refuse to read** — and
 * splitting them is not a smaller version of the cap, it is a loop: the write
 * had no check for a while, so a growing brain stored an index it already knew
 * it would reject, rebuilt from empty on the next pass, regrew, and refused
 * again. Measured at 2,000 notes the coverage cycled `594 -> 1188 -> 1782 ->
 * 594` forever, and at 900 larger-vocabulary notes a *converged* index
 * (`pending: 0`) was written at 12.37MB and discarded unread.
 *
 * The Worker's 128MB memory limit is the one ceiling no plan raises, and
 * `JSON.parse` of a large index inflates it several-fold in the heap. Measured
 * live: a brain whose full-text chat archives had been indexed whole grew an
 * index big enough that parsing it killed every invocation — uncatchably, past
 * the top-level catch — so search was down *because of* its own accelerator,
 * and no pass survived long enough to shrink the object. Refusing to parse is
 * what breaks that cycle: an oversized index is treated exactly like a corrupt
 * one and rebuilt from the notes under `NOTE_INDEX_CHAR_CAP` — and overwritten
 * *if the rebuild fits*, which since the write side exists is a condition
 * rather than a promise.
 *
 * This is a ceiling, not a cure. A brain whose *capped* index still exceeds
 * this size (roughly 10k+ notes) plateaus: the last object small enough to
 * read survives, each pass rebuilds a fuller index in memory, answers the
 * query it was called for, and declines to persist it. Partial and stable
 * beats complete and unreachable, and `pending` keeps saying so. **The plateau
 * assumes such an object exists.** A bucket whose very first pass already
 * overflows has no readable predecessor at all: the write is refused, so
 * nothing is ever stored, and every search re-lists, re-fetches every note
 * body it can afford, rebuilds from empty and answers from that. It is the
 * most expensive shape here — and it is still **cheaper than what this change
 * replaced**, which is worth stating plainly because the opposite reads like a
 * reason to revert. Both loops measured on one bucket, 20 notes against a
 * 5,000-byte cap, three consecutive passes each:
 *
 *              subrequests   puts   note reads   bytes read   bytes written
 *   read cap        24         1        20         51,386        42,976
 *   both sides      23         0        20          8,410             0
 *
 * with `docs: 20, pending: 0` on both. The old path did not accumulate
 * anything either — it wrote an object it refused on the next read, then paid
 * to read it again. Refusing the write drops a subrequest, the write, and the
 * re-read, and costs nothing.
 *
 * Reaching it takes a bucket whose *capped* index overflows inside one pass.
 * Index size at a given note count is a function of distinct-token volume and
 * path length rather than of note size alone, so there is no single note count
 * that names it: at 880 notes of 2KB the real indexer spans 0.19MB to 19.15MB
 * across vocabularies, and Zipfian prose lands at 6.4-8.3MB. It is a corner
 * rather than the norm, and it is stated because it is the one shape the
 * plateau does not cover. At that scale the index needs sharding (per-folder
 * postings, a small global-stats object); that is v2 work, stated here so the
 * plateau is recognized as this boundary rather than rediscovered as a
 * mystery.
 */
const INDEX_PARSE_BYTE_CAP = 12_000_000;
/**
 * At most this much of one note's content is indexed.
 *
 * An ordinary note is estimated at a few KB and the outliers are saved chat
 * sessions and agent ledgers at 64KB+ — an estimate, never measured, and said
 * as one because every other number in this file is a measurement and an
 * unmarked guess beside them reads as one. Indexing the outliers whole is what
 * bloated the index past the memory ceiling above.
 *
 * The first N characters carry a note's frontmatter, title and opening prose —
 * the parts ranking weighs most — and, on a long note, only the headings that
 * fall inside them, since `extractFields` runs on the sliced text.
 *
 * At 8KB the recall lost really was "the tail of the largest logs". At 2KB
 * that sentence is no longer true and saying it anyway would be the comment
 * describing the number it used to hold: on the estimate above an ordinary
 * note is now indexed by its opening rather than to its end, and a term deep
 * inside one does not match. That is a real loss of recall on ordinary notes,
 * accepted because an index that cannot be parsed loses all of them — and it
 * is said out loud to the caller on a miss (`toolSearchNotes`) rather than
 * left as a silent wrong answer. The cut is by characters of source text,
 * before tokenization, so `len` and tf stay consistent with what was actually
 * indexed.
 *
 * 2KB, down from 8KB. What is measured is that **8KB failed**: a live brain in
 * the mid-thousands of notes built a capped index that still crossed
 * `INDEX_PARSE_BYTE_CAP`, so every pass refused it, rebuilt the same first
 * budget's worth of notes, and coverage never accumulated — the churn the cap's
 * comment predicted before the write side existed, arriving well before the
 * 10k-note guess. (That churn is now a plateau; what 8KB proved is that a
 * mid-thousands brain crosses the parse cap, which is why this number moved.)
 * 2KB is a four-fold extrapolation from that measurement rather than a second
 * measurement, and it should be read as one: it holds a few-thousand-note
 * brain under the parse cap by arithmetic, not by observation. The durable fix
 * at the next order of magnitude is sharding, not a smaller number here — and
 * a smaller number is now visibly expensive, because it costs recall on
 * ordinary notes rather than on 64KB logs.
 */
export const NOTE_INDEX_CHAR_CAP = 2_048;
/** Never spend the last op on listing or fetching; the write needs one. */
const WRITE_RESERVE = 1;
/** Nor let the listing consume everything a backfill would have used. */
const FETCH_FLOOR = 2;

/**
 * Does `value` encode to more than `cap` bytes of UTF-8?
 *
 * The read side compares `bytes.byteLength`, so the write side has to answer
 * in the same currency or the two disagree on exactly the buckets that need
 * them to agree: a CJK index runs three bytes to the character, so a check
 * counted in UTF-16 code units would store an object at up to three times the
 * cap and then refuse it on every read after — the same defect wearing a
 * different alphabet.
 *
 * **It counts without allocating**, which is the whole reason it is not one
 * line of `new TextEncoder().encode(value).byteLength`. Encoding to measure
 * spends a second full copy of the body — up to twelve megabytes, beside the
 * ~24MB UTF-16 string it is copying — inside the 128MB limit this cap exists
 * to respect. An earlier version did encode, and excused it as a narrow band
 * the two bounds below would usually skip; that was backwards. An ASCII index
 * has one byte to the code unit, so **everything from `cap/3` to `cap` — the
 * entire useful range for a Latin-script bucket — is the band**, and the
 * bounds spared only CJK-heavy or absurdly long bodies. Measured at twelve
 * million characters the scan costs 44ms against 12ms for encoding, and the
 * 12MB it does not allocate is the trade.
 *
 * The two bounds stay because they are exact and O(1): UTF-8 is never *fewer*
 * bytes than the string has UTF-16 code units, and never more than three per
 * unit (a surrogate pair is two units and four bytes; a lone surrogate is one
 * unit and becomes U+FFFD, three). So a string longer than the cap is over it
 * and one under a third of the cap is under it, without looking at a
 * character. In between, the scan walks code units and stops the moment the
 * running total crosses.
 *
 * Being a hand-written second copy of one line of `TextEncoder`, it is held
 * the way two copies of any rule are held here — **both run against a corpus**,
 * in `searchIndexer.test.mjs`, exhaustively over every BMP code unit and over
 * a seeded pseudo-random corpus carrying astral pairs and unpaired surrogates
 * of both halves. Reading it is not the check; the count in that file is.
 */
export function exceedsUtf8Bytes(value, cap) {
  if (value.length > cap) return true;
  if (value.length * 3 <= cap) return false;
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit < 0xdc00 && i + 1 < value.length && (value.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      // A well-formed pair is one code point in four bytes. Consume both units;
      // anything else — including a lone surrogate of either half — is the
      // three-byte replacement character, which is what `TextEncoder` emits.
      bytes += 4;
      i += 1;
    } else bytes += 3;
    if (bytes > cap) return true;
  }
  return false;
}

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
 * Run `task` over `items` in waves of at most `size`, results in input order.
 *
 * Every remote read this module and `shards.js` make is independent of the
 * others in its wave — separate folders, separate shards, separate notes — so
 * awaiting them one at a time buys nothing and costs a round trip each. That
 * is a wall-clock cost the subrequest budget cannot see, and it is the one the
 * measurements in this file's neighbours are about: a warm search over a
 * 7,961-note bucket spent 57 store operations and **1,439ms** at a simulated
 * 20ms per operation, because 55 of the 57 were serialized.
 *
 * The wave is bounded rather than unbounded for two reasons that are not the
 * same reason. Cloudflare allows a Worker **6 simultaneous open connections**,
 * so a wider wave does not go faster — the extra requests queue — and it hides
 * how much is in flight from anybody reading the code. And a wave holds every
 * response it has received until the slowest of them lands, so an unbounded
 * wave over shard objects is the whole-corpus heap `shards.js` exists to
 * remove, wearing a `Promise.all`.
 *
 * Nothing here spends budget: the caller takes its ops before it builds the
 * wave, exactly as the sequential loops did, so a wave cannot overspend a
 * counter it never touches.
 */
export async function inWaves(items, size, task) {
  const width = Number.isFinite(size) && size > 0 ? Math.floor(size) : 1;
  const results = [];
  for (let start = 0; start < items.length; start += width) {
    const wave = items.slice(start, start + width);
    results.push(...(await Promise.all(wave.map(task))));
  }
  return results;
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
 *   byteCap?: number,
 * }} options `reserve` is store ops the caller keeps for its own later work.
 * @returns {Promise<{
 *   index: ReturnType<typeof emptyIndex>,
 *   pending: number,
 *   listingTruncated: boolean,
 *   spent: number,
 * }>} `pending` is stale notes this pass did not get to.
 */
export async function syncIndex(
  store,
  {
    budget,
    reserve = 0,
    isIndexable = defaultIsIndexable,
    /**
     * Injectable so a test can drive the whole loop against a small number
     * instead of building twelve real megabytes of JSON, which would take
     * thousands of notes and minutes of wall clock. Nothing in production
     * passes it. It is **one** parameter rather than a read cap and a write
     * cap, because two numbers that can disagree is the state this exists to
     * remove.
     *
     * Re-checked rather than trusted, the way `createSearchBudget` re-checks
     * its own argument, because a default parameter only fires on `undefined`:
     * `null` makes `length > cap` true for every non-empty body and the index
     * is never persisted again, silently, while `NaN` or a string makes both
     * comparisons false — the write always allowed and the read always refusing
     * — which is precisely the divergent loop the single parameter removes.
     */
    byteCap: requestedByteCap = INDEX_PARSE_BYTE_CAP,
  } = {},
) {
  const byteCap = Number.isFinite(requestedByteCap) ? requestedByteCap : INDEX_PARSE_BYTE_CAP;
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
      (bytes.byteLength <= byteCap &&
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

  // One return shape, computed at call time, so the refusal path below cannot
  // drift from the ordinary one. A second copy of this object is a second place
  // for `pending` to start lying about what was reached.
  const finish = () => ({
    index,
    pending: stale.length - processed,
    listingTruncated: truncated,
    spent: ops.spent,
  });

  if (changed) {
    computeRanks(index);
    // `remaining` rather than `take`, because the op must not be charged until
    // the write is actually going to happen: a refused pass that spent one
    // anyway takes it from a budget the caller shares with its snippet reads,
    // so on exactly the buckets this cap refuses, every search silently lost a
    // snippet to a `put` that never ran. Measured at 24 spent against 23 real
    // store calls. Nothing else spends between the peek and the take.
    if (ops.remaining > 0) {
      const body = serializeIndex(index);
      // **Never write an object this same function will refuse to read.** See
      // INDEX_PARSE_BYTE_CAP: an unwritten index costs this pass its
      // persistence and costs the caller nothing, because the query in hand is
      // answered from `index` in memory either way. Storing it would cost the
      // last readable index instead, and buy an object no read ever parses.
      if (exceedsUtf8Bytes(body, byteCap)) return finish();
      ops.take(0);
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

  return finish();
}

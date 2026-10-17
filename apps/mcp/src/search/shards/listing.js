import { inWaves } from "../maintain.js";
import { servedListingStore } from "../../tree/served.js";
import { isNoteId } from "../../store/noteIdKeys.js";
import { LIST_PAGE_LIMIT, MANIFEST_WRITE_RESERVE, FETCH_FLOOR, LIST_CONCURRENCY } from "./constants.js";

// -- the listing walk ------------------------------------------------------
//
// Descended from `listNoteObjects` in `maintain.js`, which is v1's and is not
// exported. Everything about its shape is load-bearing and was reproduced
// rather than reinvented — the delimited root, the flat per-folder walk, the
// budget on every page, and `regionComplete` — and it is held here by checks
// that drive truncation and removal rather than by reading the two side by
// side.
//
// **They are no longer identical**, and that is deliberate rather than drift:
// this copy runs its folder listings in waves and v1's does not. v1 is reached
// by nothing in production — the gateway and the console both answer from v2 —
// so it is legacy carried for its fixtures, and giving it concurrency would be
// changing code no caller runs to keep a sentence true. When v2 replaces v1 the
// v1 copy is what goes.

function toIso(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString() : null;
  }
  return typeof value === "string" && value ? value : null;
}

/**
 * The token the diff compares against: the listed etag where the backend
 * reports one (R2 and S3 do), else `uploaded:size` (Dropbox reports no etag at
 * all). Named `version` everywhere below for that reason.
 */
function versionOf(object) {
  if (typeof object.etag === "string" && object.etag) return object.etag;
  const size = Number.isFinite(object.size) ? object.size : "";
  return `${toIso(object.uploaded) || ""}:${size}`;
}

/**
 * One paged listing, bounded by the shared budget. Returns whether it
 * *finished* — an unfinished listing is never evidence that a key is gone, and
 * treating it as evidence would delete docs from the index for exactly the
 * largest contexts.
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
 * The listing the census reads, which is never the bucket's where a control
 * plane exists. In a keyed workspace (`notes-by-id.md`) the bucket lists uuid
 * keys, so a census built from it names notes `notes/<uuid>.md`, and the tree
 * is the only place the names and each row's etag are.
 *
 * - The Convex barrier attaches the tree as `treeListing` (`namesListing`,
 *   `lib/fileOps/walk.ts`), and that is what it reads.
 * - A gateway session carries `treeManifest`, and `servedListingStore` answers
 *   its listings from the tree.
 * - A store with neither has no control plane (the single-tenant token
 *   deployment, a self-hosted gateway, a unit test's in-memory bucket), so its
 *   own listing is the only one there is.
 *
 * A tree that is still loading or cannot be asked throws `TreeUnavailable`
 * rather than falling back to the bucket, as every other tree listing does.
 */
export function namesOf(store) {
  if (store.treeListing) return store.treeListing;
  return typeof store.treeManifest === "function" ? servedListingStore(store) : store;
}

/**
 * Every indexable note key with the token to diff it by.
 *
 * Delimited at the root, then flat inside each real folder — not an
 * optimisation. A flat walk from the root returns `.history/…` first, because
 * "." sorts before every digit and letter, so it spends its whole budget inside
 * the history and reports zero notes for the biggest contexts there are.
 */
export async function listNoteObjects(store, budget, reserve, isIndexable) {
  const names = namesOf(store);
  const entries = new Map();
  const folders = new Set();
  const listingReserve = reserve + MANIFEST_WRITE_RESERVE + FETCH_FLOOR;

  const record = (object) => {
    if (!isIndexable(object.key)) return;
    entries.set(object.key, {
      version: versionOf(object),
      uploaded: toIso(object.uploaded),
      // What the sizing and the placement are computed from, and the reason
      // both cost no store op: R2, S3 and Dropbox all report a size on a
      // listing, so how much index a note will take up is knowable before
      // anything has been read. `null` where a backend does not, which
      // `indexVolumeOf` reads as one note's worth — the assumption counting
      // notes was already making.
      size: Number.isFinite(object.size) ? object.size : null,
      // The tree's note id for the row, where the listing is the tree's and
      // the row has one; a bucket's own listing never names one.
      ...(isNoteId(object.noteId) ? { noteId: object.noteId } : {}),
    });
  };

  const rootComplete = await listPaged(
    names,
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
  // One folder's pages are sequential — the next page is addressed by the last
  // one's cursor — and the folders are independent of each other, so they run
  // in waves. That is wall clock the budget cannot see: the ops are identical,
  // the round trips are not. `record` and the shared counter are touched from
  // several listings at once, which is safe because a Worker runs one turn at a
  // time; nothing here is re-entered mid-statement.
  const folderComplete = new Map();
  const completions = await inWaves(realFolders, LIST_CONCURRENCY, (prefix) =>
    listPaged(names, { prefix }, budget, listingReserve, record)
  );
  realFolders.forEach((prefix, at) => folderComplete.set(prefix, completions[at]));

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


/**
 * The Convex tree, as a bucket listing, for the agent tools that list.
 *
 * `list_notes`, `orient`'s map and counts, `list_contacts`, `list_meetings`,
 * `list_channel_days` and `evaluate_lists` list from the keys the control
 * plane sends (`/gateway/tree/manifest`,
 * `apps/convex/functions/lib/nodes/gatewayManifest.ts`): one request per few
 * thousand keys, read once per tool call and reused by every listing in it.
 * Storage is never listed for them (decided by the owner, 2026-10-13: "the
 * only thing that should be reading from storage directly should be actually
 * opening and editing a note ... I don't want to see even fallbacks").
 *
 * Three things hold it:
 *
 *  - **Privacy is decided twice, never once less.** The control plane hands
 *    back only what this grant's clearance sees, through the unchanged
 *    `syncManifest`; every tool then filters with `canSee` over the
 *    workspace's rules, exactly as it filtered the bucket's own listing. A key
 *    reaches an agent only if both agree.
 *  - **Only `list` changes, and only for note keys.** A listing of plumbing
 *    (`.context/`, a dot folder) is Context's own small data, which the tree
 *    never holds, and every read and write is the bucket's: note text still
 *    comes from the bucket.
 *  - **No tree, no listing.** A workspace whose first copy has not finished
 *    (`served: false`) is told it is still loading; a request that failed,
 *    timed out or came back malformed is told the list could not be read just
 *    now. Neither walks the bucket instead (`TreeUnavailable`).
 *
 * The one store that lists its bucket is one with no control plane at all:
 * the single-tenant token deployment and a self-hosted gateway, which have no
 * Convex to hold a tree. Nothing else could answer them, so this is not a
 * fallback from a tree that failed; a session that has a control plane never
 * reaches it.
 */

import { listAllKeys } from "../notes/storage.js";

/** Why a listing could not be answered: the tree is still being copied, or could not be asked. */
export class TreeUnavailable extends Error {
  /** @param {"loading" | "unreachable"} reason */
  constructor(reason) {
    super(reason === "loading" ? TREE_LOADING : TREE_UNREACHABLE);
    this.name = "TreeUnavailable";
    this.reason = reason;
  }
}

/** What an agent is told while a workspace's first copy into Context has not finished. */
export const TREE_LOADING =
  "this workspace is still loading: Context is copying the list of its files, so it cannot be listed yet. " +
  "read, write and search work now; list again in a minute or two.";

/** What an agent is told when the control plane could not be asked for the list. */
export const TREE_UNREACHABLE = "this workspace's file list could not be read just now; try again in a moment.";

/** Pages of a few thousand keys one call may read: 50 is 200k keys, past the largest workspace. */
const MANIFEST_PAGES = 50;

/** S3 lists in UTF-8 byte order, which is not JavaScript's string order. */
const KEY_BYTES = new TextEncoder();
export function compareKeys(a, b) {
  const x = KEY_BYTES.encode(a);
  const y = KEY_BYTES.encode(b);
  const shared = Math.min(x.length, y.length);
  for (let index = 0; index < shared; index += 1) {
    if (x[index] !== y[index]) return x[index] - y[index];
  }
  return x.length - y.length;
}

/** A listing the tree never answers: Context's plumbing and every dot folder. */
function plumbingPrefix(prefix) {
  return prefix.startsWith(".") || prefix.includes("/.");
}

/** The folder whose subtree holds every key under `prefix`, `""` for the whole tree. */
function folderOf(prefix) {
  const slash = prefix.lastIndexOf("/");
  return slash === -1 ? "" : prefix.slice(0, slash);
}

function covers(folder, wanted) {
  return folder === "" || wanted === folder || wanted.startsWith(`${folder}/`);
}

/**
 * `store`, with `list` answered from the Convex tree. A note listing the tree
 * cannot answer throws `TreeUnavailable`, and so does every later one in the
 * same call; a store with no way to ask the control plane cannot list notes
 * at all.
 *
 * @param {object} store a session-bound store
 */
export function servedListingStore(store) {
  if (typeof store?.treeManifest !== "function") return bucketListing(store);
  /** Folder → its keys, sorted (a promise of them), for each subtree read so far in this call. */
  const subtrees = new Map();
  /** The first refusal, repeated for the rest of the call. */
  let refused = null;

  async function read(folder) {
    const entries = [];
    let cursor;
    for (let page = 0; page < MANIFEST_PAGES; page += 1) {
      const answer = await store.treeManifest({
        ...(folder === "" ? {} : { folder }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!answer || answer.served !== true) throw new TreeUnavailable("loading");
      if (!Array.isArray(answer.entries)) throw new TreeUnavailable("unreachable");
      for (const entry of answer.entries) {
        if (entry && typeof entry.path === "string" && entry.path !== "") entries.push(entry);
      }
      if (answer.cursor === null) {
        entries.sort((a, b) => compareKeys(a.path, b.path));
        return entries;
      }
      if (answer.cursor === cursor) throw new TreeUnavailable("unreachable");
      cursor = answer.cursor;
    }
    // More pages than any workspace holds is a walk that is not ending.
    throw new TreeUnavailable("unreachable");
  }

  /** The keys under `prefix`, or null for plumbing, which the bucket lists. */
  async function keysUnder(prefix) {
    if (plumbingPrefix(prefix)) return null;
    if (refused !== null) throw refused;
    const folder = folderOf(prefix);
    for (const [held, entries] of subtrees) {
      if (covers(held, folder)) return await entries;
    }
    // The promise is held, not its answer, so listings started side by side
    // (orient's map and its chaos score) share one request.
    const reading = (async () => {
      try {
        return await read(folder);
      } catch (error) {
        refused = error instanceof TreeUnavailable ? error : new TreeUnavailable("unreachable");
        throw refused;
      }
    })();
    subtrees.set(folder, reading);
    return await reading;
  }

  const listing = Object.create(store);
  /** Every key the tree holds for this grant; throws `TreeUnavailable` where it cannot answer. */
  listing.treeKeys = async () => (await keysUnder("")).map((entry) => entry.path);
  /** Every key the tree holds for this grant, as listed objects (`orient`'s survey); throws likewise. */
  listing.treeEntries = async () => (await keysUnder("")).map(objectOf);
  listing.list = async (options = {}) => {
    const prefix = options.prefix ?? "";
    const entries = await keysUnder(prefix);
    if (entries === null) return await store.list(options);
    const cursor = typeof options.cursor === "string" && options.cursor !== "" ? options.cursor : options.startAfter;
    const inside = entries.filter(
      (entry) => entry.path.startsWith(prefix) && (cursor === undefined || compareKeys(entry.path, cursor) > 0)
    );
    if (options.delimiter === "/") {
      // One level, the whole of it in one answer: the immediate keys, and the
      // folders below as `delimitedPrefixes`, the way the S3 adapter returns them.
      const objects = [];
      const delimitedPrefixes = new Set();
      for (const entry of inside) {
        const rest = entry.path.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) objects.push(objectOf(entry));
        else delimitedPrefixes.add(`${prefix}${rest.slice(0, slash + 1)}`);
      }
      return { objects, delimitedPrefixes: [...delimitedPrefixes], truncated: false };
    }
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 1000;
    const page = inside.slice(0, limit);
    const truncated = inside.length > page.length;
    return {
      objects: page.map(objectOf),
      truncated,
      ...(truncated ? { cursor: page[page.length - 1].path } : {}),
    };
  };
  return listing;
}

function objectOf(entry) {
  return {
    key: entry.path,
    ...(typeof entry.etag === "string" && entry.etag !== "" ? { etag: entry.etag } : {}),
    ...(Number.isFinite(entry.size) ? { size: entry.size } : {}),
    ...(Number.isFinite(entry.updatedAt) ? { uploaded: new Date(entry.updatedAt) } : {}),
    // The row's note id: search by meaning files a note's passages under it,
    // so a move or rename keeps them (`search/meaning/project.js`).
    ...(typeof entry.noteId === "string" && entry.noteId !== "" ? { noteId: entry.noteId } : {}),
  };
}

/**
 * A store with no control plane (see the header): its own listing, with
 * `treeKeys` and `treeEntries` walking the bucket, since there is no tree.
 */
function bucketListing(store) {
  const listing = Object.create(store);
  let everything = null;
  const all = () => {
    everything ??= listAllKeys(store, "").then((objects) => objects.filter(({ key }) => !plumbingPrefix(key)));
    return everything;
  };
  listing.treeKeys = async () => (await all()).map(({ key }) => key);
  listing.treeEntries = async () => await all();
  return listing;
}

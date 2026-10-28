/**
 * The Convex tree, as a listing, for the agent tools that list.
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
 *  - **No tree, no listing.** A workspace the tree does not serve
 *    (`served: false`), and a request that failed, timed out or came back
 *    malformed, are both told the list could not be read just now. Nothing
 *    walks the bucket instead (`TreeUnavailable`).
 *
 * Every session has a control plane (decided by the owner, 2026-10-15: there
 * is no mode without one), so a store with no `treeManifest` refuses every
 * listing of names rather than walking storage for them.
 */

/** Why a listing could not be answered: the control plane could not be asked for the tree. */
export class TreeUnavailable extends Error {
  /** @param {string} [code] why, for logs: `not_served`, `timed_out`, `failed`, `malformed` or `endless` */
  constructor(code = "unreachable") {
    super(TREE_UNREACHABLE);
    this.name = "TreeUnavailable";
    this.reason = "unreachable";
    this.code = code;
  }
}

/** A failed manifest request as a log code: the control plane's own words never leave here. */
function failureCode(error) {
  if (error instanceof TreeUnavailable) return error.code;
  return /timed out/.test(String(error?.message)) ? "timed_out" : "failed";
}

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
 * @param {{timeoutMs?: number}} [options] how long each page may take, where nobody waits on it (a check-in)
 */
export function servedListingStore(store, { timeoutMs } = {}) {
  if (typeof store?.treeManifest !== "function") return store?.treeListing ? barrierListing(store) : refusedListing(store);
  /** Folder → its keys, sorted (a promise of them), for each subtree read so far in this call. */
  const subtrees = new Map();
  /** The first refusal, repeated for the rest of the call. */
  let refused = null;

  async function read(folder) {
    const entries = [];
    let cursor;
    for (let page = 0; page < MANIFEST_PAGES; page += 1) {
      const answer = await store.treeManifest(
        {
          ...(folder === "" ? {} : { folder }),
          ...(cursor === undefined ? {} : { cursor }),
        },
        ...(timeoutMs === undefined ? [] : [{ timeoutMs }])
      );
      if (!answer || answer.served !== true) throw new TreeUnavailable("not_served");
      if (!Array.isArray(answer.entries)) throw new TreeUnavailable("malformed");
      for (const entry of answer.entries) {
        if (entry && typeof entry.path === "string" && entry.path !== "") entries.push(entry);
      }
      if (answer.cursor === null) {
        entries.sort((a, b) => compareKeys(a.path, b.path));
        return entries;
      }
      if (answer.cursor === cursor) throw new TreeUnavailable("endless");
      cursor = answer.cursor;
    }
    // More pages than any workspace holds is a walk that is not ending.
    throw new TreeUnavailable("endless");
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
        refused = error instanceof TreeUnavailable ? error : new TreeUnavailable(failureCode(error));
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

/** A manifest entry as a listed object. */
export function objectOf(entry) {
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
 * A store inside the Convex credential barrier, which reads the tree's rows directly and attaches them as
 * `treeListing` (`lib/nodes/treeNames.ts`): its listing is that one, never the bucket's.
 */
function barrierListing(store) {
  const listing = Object.create(store);
  // Plumbing (`.context/`) is Context's own small data, which the tree never holds: the bucket lists it.
  listing.list = async (options = {}) =>
    plumbingPrefix(options.prefix ?? "") ? await store.list(options) : await store.treeListing.list(options);
  listing.treeEntries = async () => {
    const objects = [];
    for (let cursor; ; ) {
      const page = await store.treeListing.list({ ...(cursor === undefined ? {} : { cursor }), limit: 1000 });
      objects.push(...(page.objects ?? []).filter((object) => !plumbingPrefix(object.key)));
      if (!page.truncated || !page.cursor || page.cursor === cursor) return objects;
      cursor = page.cursor;
    }
  };
  listing.treeKeys = async () => (await listing.treeEntries()).map((object) => object.key);
  return listing;
}

/** A store with no control plane (see the header): every listing of names is refused. */
function refusedListing(store) {
  const listing = Object.create(store);
  const refuse = async () => {
    throw new TreeUnavailable();
  };
  listing.treeKeys = refuse;
  listing.treeEntries = refuse;
  listing.list = refuse;
  return listing;
}

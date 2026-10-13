/**
 * The Convex tree, as a bucket listing, for the agent tools that list.
 *
 * `list_notes`, `orient`'s map and counts, `list_contacts`, `list_meetings`,
 * `list_channel_days` and `evaluate_lists` walked the bucket on every call, a
 * page of a thousand keys at a time and one walk per folder. Where the tree
 * serves the workspace (`/gateway/tree/manifest`,
 * `apps/convex/functions/lib/nodes/gatewayManifest.ts`), this store answers
 * those walks from the keys the control plane sends instead: one request per
 * few thousand keys, read once per tool call and reused by every listing in it.
 *
 * Three things stay as they were:
 *
 *  - **Privacy is decided twice, never once less.** The control plane hands
 *    back only what this grant's clearance sees, through the unchanged
 *    `syncManifest`; every tool then filters with `canSee` over the bucket's
 *    `privacy.md`, exactly as it filtered the bucket's own listing. A key
 *    reaches an agent only if both agree.
 *  - **Only `list` changes, and only for note keys.** A listing of plumbing
 *    (`.context/`, a dot folder) goes to the bucket, because the tree never
 *    holds it, and so does every read and write: note text still comes from
 *    the bucket.
 *  - **Anything short of a proved tree reads the bucket.** A workspace the tree
 *    does not serve, staff's Pause, a request that failed or timed out, and a
 *    store with no control plane all fall back to the bucket's own listing for
 *    the rest of the call, so the answer is today's answer, only slower.
 */

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
 * `store`, with `list` answered from the Convex tree where it serves. Returns
 * `store` itself when this store has no way to ask (a self-hosted gateway
 * without the route, a test stub), so a caller never has to check.
 *
 * @param {object} store a session-bound store
 * @param {{onServed?: (served: boolean) => void}} [options]
 */
export function servedListingStore(store, { onServed } = {}) {
  if (typeof store?.treeManifest !== "function") return store;
  /** Folder → its keys, sorted, for each subtree read so far in this call. */
  const subtrees = new Map();
  let off = false;
  let told = false;
  const tell = (served) => {
    if (told) return;
    told = true;
    if (typeof onServed === "function") onServed(served);
  };

  async function read(folder) {
    const entries = [];
    let cursor;
    for (let page = 0; page < MANIFEST_PAGES; page += 1) {
      const answer = await store.treeManifest({
        ...(folder === "" ? {} : { folder }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!answer || answer.served !== true) return null;
      for (const entry of answer.entries) {
        if (entry && typeof entry.path === "string" && entry.path !== "") entries.push(entry);
      }
      if (answer.cursor === null) {
        entries.sort((a, b) => compareKeys(a.path, b.path));
        return entries;
      }
      if (answer.cursor === cursor) return null;
      cursor = answer.cursor;
    }
    // More pages than any workspace holds is a walk that is not ending.
    return null;
  }

  /** The keys under `prefix`, or null when the bucket must answer. */
  async function keysUnder(prefix) {
    if (off || plumbingPrefix(prefix)) return null;
    const folder = folderOf(prefix);
    for (const [held, entries] of subtrees) {
      if (covers(held, folder)) return entries;
    }
    let entries;
    try {
      entries = await read(folder);
    } catch {
      entries = null;
    }
    if (entries === null) {
      off = true;
      tell(false);
      return null;
    }
    tell(true);
    subtrees.set(folder, entries);
    return entries;
  }

  const listing = Object.create(store);
  /**
   * Every key the tree holds for this grant, or null when the tree does not
   * serve this call: for a reader that would rather use another source than
   * fall back to a whole-bucket listing (the chaos score in `orient`).
   */
  listing.treeKeys = async () => {
    const entries = await keysUnder("");
    return entries === null ? null : entries.map((entry) => entry.path);
  };
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
  };
}

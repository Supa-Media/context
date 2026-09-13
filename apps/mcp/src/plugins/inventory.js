/**
 * Finding the Obsidian plugins already in somebody's bucket, and checking them.
 *
 * This is the storage half of the compatibility check. It exists because the
 * strong version of "your setup keeps working" is not a promise, it is a
 * report: connect a bucket that an Obsidian vault already syncs to, and be told
 * — before installing anything, before moving anything — which of the plugins
 * in it Context can run and which stay in Obsidian.
 *
 * ## Two rules this file exists to keep
 *
 * **`.obsidian/` is read here and written nowhere.** It is the one place in a
 * customer's bucket that belongs to another program. A plugin's settings and
 * data live in it, and a gateway that "tidied" it would break the plugin in the
 * client the person actually uses. `isPlumbing` in `index.js` already keeps it
 * out of notes, listings, search and the note count; this module adds the only
 * read path, and no write path. Plugins installed by Context live separately
 * under `.context/plugins/`; their immutable release files are selected by a
 * small `current.json` pointer and are scanned by the same rules.
 *
 * **No caller ever names a path.** Every key read here is built from a fixed
 * shape — `.obsidian/plugins/<folder>/manifest.json` and `.../main.js` — where
 * `<folder>` comes from a listing of that prefix and nothing else. There is no
 * argument to point somewhere better. That matters because a tool that reads
 * `.obsidian/` is by construction a tool that reads outside the privacy
 * manifest's reach, and the safe form of such a tool is one that cannot be
 * aimed: the privacy engine governs notes, and a read primitive that took a
 * caller's path would be a way around it.
 */

import { MAX_SCAN_BYTES, scanPlugin, summarize } from "./scan.js";

/** Where Obsidian keeps plugins, in every vault, on every platform. */
export const PLUGIN_PREFIX = ".obsidian/plugins/";

/** Context-owned plugin installs, deliberately outside Obsidian's directory. */
export const MANAGED_PLUGIN_PREFIX = ".context/plugins/";

/**
 * How many plugins one report will actually open.
 *
 * Each one costs up to three reads, and a Worker invocation has a subrequest ceiling
 * that the search budget already spends most of. Twenty is two-thirds of that
 * ceiling and comfortably above what a real vault holds — the largest we have
 * measured carries fifteen — but a vault *can* exceed it, and one that does is
 * reported as a floor rather than silently cut. See `truncated` below.
 */
export const PLUGIN_SCAN_CAP = 20;

/** Refuse to loop forever on a backend that keeps handing back pages. */
const LIST_PAGE_CAP = 20;

/**
 * The plugin folders present, newest listing order, without reading any of them.
 *
 * Uses a delimited listing so a plugin's own files — some ship a hundred — are
 * never paged through to find the next folder. A backend that ignores the
 * delimiter (the in-memory test stub does, as does at least one S3-compatible
 * provider) is handled by deriving the folder from each key instead, which is
 * the same fallback `listImmediateLayout` carries and for the same reason.
 */
export async function listPluginFolders(store, { prefix = PLUGIN_PREFIX } = {}) {
  const folders = new Set();
  const seenCursors = new Set();
  let listingTruncated = false;
  let cursor;
  do {
    const page = await store.list({ prefix, delimiter: "/", cursor, limit: 1000 });
    for (const listedPrefix of page.delimitedPrefixes || []) {
      const folder = listedPrefix.slice(prefix.length).replace(/\/$/, "");
      if (isSafeFolder(folder)) folders.add(folder);
    }
    for (const object of page.objects || []) {
      const remainder = object.key.slice(prefix.length);
      const slash = remainder.indexOf("/");
      if (slash === -1) continue;
      const folder = remainder.slice(0, slash);
      if (isSafeFolder(folder)) folders.add(folder);
    }
    if (!page.truncated) break;
    if (!page.cursor) {
      throw new Error("storage listing did not finish and offered no continuation token");
    }
    if (seenCursors.has(page.cursor)) {
      throw new Error("storage listing repeated a pagination cursor; refusing to loop");
    }
    seenCursors.add(page.cursor);
    if (seenCursors.size >= LIST_PAGE_CAP) {
      // Cut by the page cap, not by the scan cap. Reported, because the caller
      // computes `truncated` from `folders.length > selected.length` and this
      // cut happens UPSTREAM of the length it measures — so a listing stopped
      // here came back looking complete. Folders are sorted, so the ones lost
      // are the last alphabetically: a `wont-run` plugin late in the alphabet
      // vanishing from a report that reads as whole. That is the trap this
      // module's own header says the report exists to avoid.
      listingTruncated = true;
      break;
    }
    cursor = page.cursor;
  } while (cursor);
  return { folders: [...folders].sort(), listingTruncated };
}

/**
 * Managed data and cached releases share the plugin directory, so a folder is
 * an installed plugin only when it contains the activation pointer itself.
 * Listing the objects (without a delimiter) lets us make that distinction
 * without interpreting `data.json` as an install.
 */
async function listManagedPluginFolders(store) {
  const folders = new Set();
  const seenCursors = new Set();
  let listingTruncated = false;
  let cursor;
  do {
    const page = await store.list({ prefix: MANAGED_PLUGIN_PREFIX, cursor, limit: 1000 });
    for (const object of page.objects || []) {
      const remainder = object.key.slice(MANAGED_PLUGIN_PREFIX.length);
      if (!remainder.endsWith("/current.json")) continue;
      const folder = remainder.slice(0, -"/current.json".length);
      if (!folder.includes("/") && isSafeFolder(folder)) folders.add(folder);
    }
    if (!page.truncated) break;
    if (!page.cursor) {
      throw new Error("storage listing did not finish and offered no continuation token");
    }
    if (seenCursors.has(page.cursor)) {
      throw new Error("storage listing repeated a pagination cursor; refusing to loop");
    }
    seenCursors.add(page.cursor);
    if (seenCursors.size >= LIST_PAGE_CAP) {
      listingTruncated = true;
      break;
    }
    cursor = page.cursor;
  } while (cursor);
  return { folders: [...folders].sort(), listingTruncated };
}

/**
 * A folder name we are willing to build a key from.
 *
 * The adapter's own `assertSafeKey` would reject the dangerous ones, but it
 * throws, and one oddly named folder must not be able to take down the report
 * for the whole bucket — the same failure the note count hit when a single
 * unlistable folder suppressed a customer's total forever. Screened here, and
 * each read is wrapped besides.
 */
function isSafeFolder(folder) {
  return (
    typeof folder === "string" &&
    folder.length > 0 &&
    folder.length <= 200 &&
    !folder.startsWith(".") &&
    // Control characters and a backslash — the two shapes `assertSafeKey`
    // refuses — screened here before it can throw, plus every other character
    // that can move a cursor or reverse a run of text in the report this name
    // ends up in. The hand-written range covered C0 and DEL and missed U+2028,
    // U+2029, U+0085 and the whole bidi block, so a folder could draw its own
    // lines into the report the way a manifest could before `str()` — the same
    // actor, the same page, the adjacent path. Named by category so the two
    // strips cannot drift apart again.
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/u.test(folder)
  );
}

/**
 * Read and check one plugin, in its own `try`.
 *
 * The guard is here, around the whole plugin, rather than only inside the two
 * reads — and the difference is not stylistic. It was written the other way
 * first, with `readText` catching and this function trusting it, and a sabotage
 * run proved what that costs: making one read throw did not degrade one
 * plugin's verdict, it took down the report for the entire bucket. That is the
 * note count's bug exactly, where one oddly named folder suppressed a
 * customer's total forever, and the fix there was the same one — each folder
 * walked in its own `try`, so a folder that will not walk costs only itself.
 *
 * A plugin that cannot be read is `unknown`, which the console draws as
 * "couldn't be checked" and never as a refusal.
 */
async function readPlugin(store, folder) {
  try {
    const manifest = await readText(store, `${PLUGIN_PREFIX}${folder}/manifest.json`);
    const bundle = await readText(store, `${PLUGIN_PREFIX}${folder}/main.js`);
    const styles = await readOptionalText(store, `${PLUGIN_PREFIX}${folder}/styles.css`);
    return {
      ...scanPlugin({ id: folder, manifestText: manifest?.text ?? null, source: bundle?.text ?? null }),
      source: "obsidian",
      // A grant is for the code that was reviewed, not forever for anything
      // later synced into the same folder. ETags are the storage adapter's
      // content identity and are already normalized before they reach here.
      bundleFingerprint: fingerprintFor(manifest, bundle, styles),
    };
  } catch {
    // Nothing from the error reaches the caller: its message would carry an
    // object key, and keys are the customer's own paths.
    //
    // **Not individually pinned, and stated so rather than left to be
    // rediscovered.** `readText` has its own inner `try`, so removing either
    // one alone leaves the suite green and only removing both fails. What this
    // one adds is the case the inner cannot reach — `scanPlugin` itself
    // throwing on some input nothing has thought of — and testing that would
    // mean injecting a throwing scanner into a module that takes no
    // dependencies. So the property is covered and the structure is not; a
    // reader deleting this as redundant gets a green run, which is exactly why
    // this paragraph is here.
    return {
      ...scanPlugin({ id: folder, manifestText: null, source: null }),
      source: "obsidian",
      bundleFingerprint: null,
    };
  }
}

/**
 * Read the release selected by a Context-managed install.
 *
 * The pointer is untrusted bucket data, just like a manifest. It must agree
 * with the encoded folder it lives under, and its version is encoded before it
 * is used in a key. A bad pointer still produces one `unknown` row: silently
 * dropping it would make `found` claim the managed install did not exist.
 */
async function readManagedPlugin(store, folder) {
  const id = decodeManagedSegment(folder);
  if (!id) return unknownManagedPlugin(folder);

  try {
    const pointerObject = await readText(store, `${MANAGED_PLUGIN_PREFIX}${folder}/current.json`);
    const pointer = parseManagedPointer(pointerObject?.text, id);
    if (!pointer) return unknownManagedPlugin(id);

    const version = encodeURIComponent(pointer.version);
    const releasePrefix = `${MANAGED_PLUGIN_PREFIX}${folder}/releases/${version}/`;
    const manifest = await readText(store, `${releasePrefix}manifest.json`);
    const bundle = await readText(store, `${releasePrefix}main.js`);
    const styles = await readOptionalText(store, `${releasePrefix}styles.css`);
    return {
      ...scanPlugin({ id, manifestText: manifest?.text ?? null, source: bundle?.text ?? null }),
      source: "context",
      bundleFingerprint: fingerprintFor(manifest, bundle, styles),
    };
  } catch {
    return unknownManagedPlugin(id);
  }
}

function unknownManagedPlugin(id) {
  return {
    ...scanPlugin({ id, manifestText: null, source: null }),
    source: "context",
    bundleFingerprint: null,
  };
}

function decodeManagedSegment(folder) {
  try {
    const decoded = decodeURIComponent(folder);
    if (!isSafeManagedValue(decoded) || encodeURIComponent(decoded) !== folder) return null;
    return decoded;
  } catch {
    return null;
  }
}

function parseManagedPointer(text, expectedId) {
  if (typeof text !== "string") return null;
  try {
    const pointer = JSON.parse(text);
    if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) return null;
    if (pointer.id !== expectedId || !isSafeManagedValue(pointer.version)) return null;
    return { id: pointer.id, version: pointer.version };
  } catch {
    return null;
  }
}

function isSafeManagedValue(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value.trim() === value &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  );
}

function fingerprintFor(manifest, bundle, styles) {
  // `undefined` is an unreadable optional file; `null` is a confirmed absence.
  // Only the latter may produce a grantable fingerprint.
  if (!manifest || !bundle || styles === undefined) return null;
  const etags = [manifest.etag, bundle.etag];
  if (etags.some((etag) => typeof etag !== "string" || !etag || etag.length > 256)) return null;
  if (
    styles &&
    (typeof styles.etag !== "string" || !styles.etag || styles.etag.length > 256)
  ) {
    return null;
  }
  const styleIdentity = styles ? `present:${styles.etag}` : "absent";
  return `v2:${[...etags, styleIdentity].map((etag) => encodeURIComponent(etag)).join(":")}`;
}

async function readOptionalText(store, key) {
  try {
    const object = await store.get(key);
    if (!object) return null;
    const text = await object.text();
    return typeof text === "string"
      ? { text: text.slice(0, MAX_SCAN_BYTES + 1), etag: object.etag }
      : undefined;
  } catch {
    return undefined;
  }
}

async function readText(store, key) {
  try {
    const object = await store.get(key);
    if (!object) return null;
    const text = await object.text();
    // A bundle past the cap is handed on as-is; `scanBundle` is the one place
    // that decides what an over-long bundle means, so the size rule lives in
    // one file rather than two that could disagree about the number.
    return typeof text === "string"
      ? { text: text.slice(0, MAX_SCAN_BYTES + 1), etag: object.etag }
      : null;
  } catch {
    return null;
  }
}

/**
 * The whole report for one context.
 *
 * `truncated` is the same honesty the note count keeps: when a vault holds more
 * plugins than the cap, the counts describe the ones that were read and say so,
 * because a total that is really a floor is the bug that report exists to
 * avoid. `checkedAt` travels with it for the same reason a count carries its
 * own date — nothing re-checks on a schedule, and a verdict from a version ago
 * is not a verdict about the version installed now.
 */
export async function inventoryPlugins(store, { cap = PLUGIN_SCAN_CAP } = {}) {
  let obsidianFolders;
  let managedFolders;
  let listingTruncated = false;
  try {
    const obsidian = await listPluginFolders(store);
    const managed = await listManagedPluginFolders(store);
    obsidianFolders = obsidian.folders;
    managedFolders = managed.folders;
    listingTruncated = obsidian.listingTruncated || managed.listingTruncated;
  } catch (error) {
    return {
      available: false,
      reason: String(error?.message || error).slice(0, 200),
      plugins: [],
      counts: summarize([]),
      found: 0,
      scanned: 0,
      truncated: false,
      checkedAt: new Date().toISOString(),
    };
  }

  // One plugin id yields one row and therefore one possible grant target. A
  // Context-managed release is the explicitly selected runtime bundle, so it
  // wins over a synced Obsidian folder carrying the same id.
  const managedIds = new Set(managedFolders.map((folder) => decodeManagedSegment(folder) || folder));
  const locations = [
    ...obsidianFolders
      .filter((folder) => !managedIds.has(folder))
      .map((folder) => ({ folder, source: "obsidian" })),
    ...managedFolders.map((folder) => ({ folder, source: "context" })),
  ].sort((a, b) => a.folder.localeCompare(b.folder) || a.source.localeCompare(b.source));
  const selected = locations.slice(0, cap);
  const plugins = [];
  for (const location of selected) {
    plugins.push(
      location.source === "context"
        ? await readManagedPlugin(store, location.folder)
        : await readPlugin(store, location.folder)
    );
  }

  return {
    available: true,
    reason: null,
    plugins,
    counts: summarize(plugins),
    found: locations.length,
    scanned: plugins.length,
    truncated: listingTruncated || locations.length > selected.length,
    checkedAt: new Date().toISOString(),
  };
}

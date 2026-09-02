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
 * read path, and no write path.
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

/**
 * How many plugins one report will actually open.
 *
 * Each one costs two reads, and a Worker invocation has a subrequest ceiling
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
export async function listPluginFolders(store) {
  const folders = new Set();
  const seenCursors = new Set();
  let listingTruncated = false;
  let cursor;
  do {
    const page = await store.list({ prefix: PLUGIN_PREFIX, delimiter: "/", cursor, limit: 1000 });
    for (const prefix of page.delimitedPrefixes || []) {
      const folder = prefix.slice(PLUGIN_PREFIX.length).replace(/\/$/, "");
      if (isSafeFolder(folder)) folders.add(folder);
    }
    for (const object of page.objects || []) {
      const remainder = object.key.slice(PLUGIN_PREFIX.length);
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
    // refuses — screened here before it can throw.
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001F\u007F\\]/.test(folder)
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
    const manifestText = await readText(store, `${PLUGIN_PREFIX}${folder}/manifest.json`);
    const source = await readText(store, `${PLUGIN_PREFIX}${folder}/main.js`);
    return scanPlugin({ id: folder, manifestText, source });
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
    return scanPlugin({ id: folder, manifestText: null, source: null });
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
    return typeof text === "string" ? text.slice(0, MAX_SCAN_BYTES + 1) : null;
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
  let folders;
  let listingTruncated = false;
  try {
    ({ folders, listingTruncated } = await listPluginFolders(store));
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

  const selected = folders.slice(0, cap);
  const plugins = [];
  for (const folder of selected) {
    plugins.push(await readPlugin(store, folder));
  }

  return {
    available: true,
    reason: null,
    plugins,
    counts: summarize(plugins),
    found: folders.length,
    scanned: plugins.length,
    truncated: listingTruncated || folders.length > selected.length,
    checkedAt: new Date().toISOString(),
  };
}

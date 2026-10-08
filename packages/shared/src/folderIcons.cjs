/**
 * Folder icons: an emoji somebody chose for a folder, from "Set icon…" in its
 * menu (decided by the owner, 2026-10-08: no folder gets a special icon; any
 * folder can be given one).
 *
 * ## Where they live
 *
 * One small file in the workspace's own bucket, `.context/folder-icons.json`:
 *
 *     { "version": 1, "icons": { "2-areas/cooking": "🍳" } }
 *
 * The proposal said the folder's own note, and that was the first idea. It
 * would mean opening every folder's front note to draw one folder listing,
 * which is a read per row on every expand. One file read once draws them all,
 * it is still the customer's (in their bucket, exported with everything else),
 * and it is plumbing (`.context/`), so no note and no AI client ever sees it.
 *
 * ## Paths, not ids
 *
 * A folder has no id, only a path, so a move has to carry its icon along:
 * `remapFolderIcons` runs after every folder move, in the console and through
 * an MCP client alike, and `dropFolderIcons` after a folder is deleted for
 * good. Both are best-effort by design. An icon is decoration; a move must
 * never fail, or half-happen, because the decoration could not be written.
 *
 * Pure parsing plus two store helpers that take any adapter with `get` and
 * `put`, so the gateway and the control plane share one engine.
 */

const FOLDER_ICONS_KEY = ".context/folder-icons.json";
const FOLDER_ICONS_VERSION = 1;
/** Longer than any single emoji (ZWJ families, flags with tags); see `workspaceIcon.ts`. */
const MAX_ICON_LENGTH = 32;
/** A workspace with more icons than this has a file somebody wrote by hand. */
const MAX_ICONS = 2000;

function plainPath(path) {
  return (
    typeof path === "string" &&
    path !== "" &&
    path.length <= 1024 &&
    !path.startsWith("/") &&
    !path.endsWith("/") &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || segment.startsWith("."))
  );
}

function plainIcon(icon) {
  // The setter validates with `isSingleEmoji`; reading is lenient on shape but
  // never lets anything long or control-character-bearing through to a row.
  return typeof icon === "string" && icon.length > 0 && icon.length <= MAX_ICON_LENGTH && !/[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/.test(icon);
}

/**
 * The icons a file holds, as a plain object of path to emoji. Anything that is
 * not that (a missing file, a hand edit gone wrong, a future version) reads as
 * no icons rather than an error: the folders still draw, with plain icons.
 */
function parseFolderIcons(text) {
  const icons = {};
  if (typeof text !== "string" || text.trim() === "") return icons;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return icons;
  }
  if (parsed === null || typeof parsed !== "object" || parsed.version !== FOLDER_ICONS_VERSION) return icons;
  const source = parsed.icons;
  if (source === null || typeof source !== "object" || Array.isArray(source)) return icons;
  let count = 0;
  for (const [path, icon] of Object.entries(source)) {
    if (count >= MAX_ICONS) break;
    if (!plainPath(path) || !plainIcon(icon)) continue;
    icons[path] = icon;
    count += 1;
  }
  return icons;
}

/** The file's text for a set of icons, keys sorted so a diff shows one line. */
function serializeFolderIcons(icons) {
  const sorted = {};
  for (const path of Object.keys(icons).sort()) sorted[path] = icons[path];
  return `${JSON.stringify({ version: FOLDER_ICONS_VERSION, icons: sorted }, null, 2)}\n`;
}

/**
 * The icons after `from` moved to `to`: the folder's own icon and every icon
 * beneath it follow. Returns `null` when nothing changed, so a caller can skip
 * the write.
 */
function iconsAfterMove(icons, from, to) {
  let changed = false;
  const next = {};
  const prefix = `${from}/`;
  for (const [path, icon] of Object.entries(icons)) {
    if (path === from) {
      next[to] = icon;
      changed = true;
    } else if (path.startsWith(prefix)) {
      next[`${to}/${path.slice(prefix.length)}`] = icon;
      changed = true;
    } else if (!(path in next)) {
      next[path] = icon;
    }
  }
  return changed ? next : null;
}

/** The icons after `path` and everything beneath it are gone, or `null` when none were. */
function iconsAfterDelete(icons, path) {
  let changed = false;
  const next = {};
  const prefix = `${path}/`;
  for (const [key, icon] of Object.entries(icons)) {
    if (key === path || key.startsWith(prefix)) changed = true;
    else next[key] = icon;
  }
  return changed ? next : null;
}

async function readFolderIcons(store) {
  const object = await store.get(FOLDER_ICONS_KEY);
  if (object === null || object === undefined) return { icons: {}, etag: null };
  return { icons: parseFolderIcons(await object.text()), etag: object.etag };
}

/**
 * Write `change(icons)` back, conditionally on the version read, retrying once
 * on a lost race. `change` returns `null` for "nothing to write". Returns the
 * icons as written, or `null` when the write was skipped or lost twice.
 */
async function updateFolderIcons(store, change) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { icons, etag } = await readFolderIcons(store);
    const next = change(icons);
    if (next === null) return null;
    const conditional = etag !== null || store.capabilities?.conditionalCreate === true;
    const onlyIf = etag === null ? { absent: true } : { etagMatches: etag };
    const written = await store.put(FOLDER_ICONS_KEY, serializeFolderIcons(next), conditional ? { onlyIf } : undefined);
    if (written !== null) return next;
  }
  return null;
}

/** Carry icons along with a folder move. Never throws. */
async function remapFolderIcons(store, from, to) {
  try {
    return await updateFolderIcons(store, (icons) => iconsAfterMove(icons, from, to));
  } catch {
    return null;
  }
}

/** Forget the icons of a folder deleted for good. Never throws. */
async function dropFolderIcons(store, path) {
  try {
    return await updateFolderIcons(store, (icons) => iconsAfterDelete(icons, path));
  } catch {
    return null;
  }
}

module.exports = {
  FOLDER_ICONS_KEY,
  FOLDER_ICONS_VERSION,
  parseFolderIcons,
  serializeFolderIcons,
  iconsAfterMove,
  iconsAfterDelete,
  readFolderIcons,
  updateFolderIcons,
  remapFolderIcons,
  dropFolderIcons,
};

/**
 * Folder icons: an emoji somebody chose for a folder, from "Set icon…" in its
 * menu (decided by the owner, 2026-10-08: no folder gets a special icon; any
 * folder can be given one). Since 2026-10-13 a note can have one too, keyed by
 * its own path (`todo.md`), and the built-in folders show a default emoji when
 * nobody chose one (`defaultFolderIcon`). The file keeps its name: it is a
 * stable on-bucket format, and a note's icon is one more key in it.
 *
 * ## Where they live
 *
 * One small file in the workspace's own bucket, `.context/folder-icons.json`:
 *
 *     { "version": 1, "icons": { "2-areas/cooking": "🍳", "1-projects/launch": ":party-parrot:" } }
 *
 * An icon is any single emoji, written as the character, or one of the
 * workspace's own emoji, written `:name:` the way a note writes it (its
 * picture is the `emoji-<name>` object in the image store, `customEmoji.ts`).
 *
 * The proposal said the folder's own note, and that was the first idea. It
 * would mean opening every folder's front note to draw one folder listing,
 * which is a read per row on every expand. One file read once draws them all,
 * it is still the customer's (in their bucket, exported with everything else),
 * and it is plumbing (`.context/`), so no note and no AI client ever sees it.
 *
 * ## Held in the control plane, and the file is the export
 *
 * Since 2026-10-14 (the owner's "Names only") the icons are rows in Convex
 * (`folderIcons`, `apps/convex/functions/lib/schema/smallData.ts`), and every
 * reader reads those. This file is still written, in this format, from the
 * rows after every change, so the customer's export and their own bucket keep
 * the icons; nothing on a request path reads it back. It is read once more,
 * to import a workspace (`lib/smallData/sync.ts`).
 *
 * A store opened by the console's barrier or the gateway's session carries
 * the rows as `store.folderIconsHeld` (`remap`, `drop`), and the helpers
 * below change the rows through it. Only a store with no control plane at
 * all (the gateway's in-memory test stub, a self-hosted gateway without one)
 * keeps the file as the record, read and written here.
 *
 * ## Paths, not ids
 *
 * A folder has no id, only a path, so a move has to carry its icon along:
 * `remapFolderIcons` runs after every folder move and `remapIcons` after every
 * note move, in the console and through an MCP client alike, and
 * `dropFolderIcons` after a folder or note is deleted for good. Both are best-effort by design. An icon is decoration; a move must
 * never fail, or half-happen, because the decoration could not be written.
 *
 * Pure parsing plus store helpers that take any adapter with `get` and
 * `put`, so the gateway and the control plane share one engine.
 */

const { topLevelRole } = require("./folderRoles.cjs");
const { cadenceFromFolder } = require("./routines.cjs");
const { contextPartMarker } = require("./contextIcons.cjs");

const FOLDER_ICONS_KEY = ".context/folder-icons.json";
const FOLDER_ICONS_VERSION = 1;
/** Longer than any single emoji (ZWJ families, flags with tags); see `workspaceIcon.ts`. */
const MAX_ICON_LENGTH = 32;
/**
 * One of the workspace's own emoji, as `:name:`: the name rule is
 * `customEmoji.ts`'s `CUSTOM_EMOJI_NAME`, so a name can run to 64 characters,
 * which is past `MAX_ICON_LENGTH` once the colons are on.
 */
const CUSTOM_ICON = /^:[a-z0-9][a-z0-9_-]{0,63}:$/;
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
  if (typeof icon === "string" && CUSTOM_ICON.test(icon)) return true;
  return typeof icon === "string" && icon.length > 0 && icon.length <= MAX_ICON_LENGTH && !/[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/.test(icon);
}

/**
 * The emoji a built-in folder shows when nobody chose one (decided by the
 * owner, 2026-10-13, reversing "no special icons" of 2026-10-08 for the
 * built-in folders only). Read from the folder's name like its role
 * (`folderRoles.cjs`), so `0-inbox`, `inbox` and `Inbox` all get 📥, and only
 * at the top level: `1-projects/inbox` is somebody's own folder.
 *
 * Drawn, never written: nothing goes into `folder-icons.json`, so every
 * workspace, old ones included, gets them without a migration, and a chosen
 * icon always wins. Removing a chosen icon brings the default back.
 */
const DEFAULT_FOLDER_ICONS = Object.freeze({
  inbox: "📥",
  projects: "🏗️",
  areas: "🛠️",
  resources: "📚",
  clients: "🤝",
  teams: "👥",
  products: "📦",
  archive: "🗄️",
});
/** The website folder is not a PARA role, but it is built in: `websiteRoutes.ts`'s `DEFAULT_WEBSITE_ROOT`. */
const WEBSITE_FOLDER = "website";
const WEBSITE_ICON = "🖥️";

/**
 * The folders the product itself files into inside the inbox, and what each
 * shows when nobody chose an icon (decided by the owner, 2026-10-14). Matched
 * by exact name one level under the inbox only, so `0-inbox/email` is ours and
 * `1-projects/email` or `0-inbox/email/archive` are somebody's own.
 */
const DEFAULT_INBOX_FOLDER_ICONS = Object.freeze({
  calendar: contextPartMarker("inbox_calendar"),
  contacts: contextPartMarker("inbox_contacts"),
  email: contextPartMarker("inbox_email"),
  forms: contextPartMarker("inbox_forms"),
  "google-chat": contextPartMarker("inbox_chat"),
  imessage: contextPartMarker("inbox_imessage"),
  meetings: contextPartMarker("inbox_meetings"),
  memories: contextPartMarker("inbox_memories"),
  sessions: contextPartMarker("inbox_sessions"),
  granola: contextPartMarker("inbox_granola"),
  inbox: contextPartMarker("inbox_capture"),
  capture: contextPartMarker("inbox_capture"),
});

/**
 * `tex/` draws Tex itself, calm (the owner, 2026-10-14: "the tex icon,
 * organized version"), not an emoji. A default is drawn and never written, so
 * this marker only ever reaches `EmojiGlyph`, which draws the figure for it.
 * Not an emoji and not a `:name:`, so no workspace emoji can take its place.
 */
const TEX_FIGURE_ICON = "context:tex";

/**
 * Tex's own folders and notes, by their path inside Tex's folder (owner,
 * 2026-10-21: "mark other system folders and give them context like icons
 * like the folders under tex"). Drawn in Tex blue from the same brush as the
 * built-in folders (`contextIcons.cjs`'s parts), never written. The folders
 * here are also kept where they are, like the Inbox's own (`TEX_PARTS`,
 * `folderJobInfo.cjs`).
 */
const TEX_PART_ICONS = Object.freeze({
  "about-me.md": contextPartMarker("tex_about"),
  attention: contextPartMarker("tex_attention"),
  chats: contextPartMarker("tex_chats"),
  "attention.md": contextPartMarker("tex_attention"),
  dreams: contextPartMarker("tex_dreams"),
  groups: contextPartMarker("tex_groups"),
  handbacks: contextPartMarker("tex_handbacks"),
  heartbeat: contextPartMarker("tex_heartbeat"),
  "heartbeat.md": contextPartMarker("tex_heartbeat"),
  housekeeping: contextPartMarker("tex_housekeeping"),
  "jobs.md": contextPartMarker("tex_jobs"),
  routines: contextPartMarker("tex_routines"),
  skills: contextPartMarker("tex_skills"),
  transcripts: contextPartMarker("tex_transcripts"),
});
const CADENCE_ICONS = Object.freeze({
  once: contextPartMarker("cadence_once"),
  minute: contextPartMarker("cadence_minute"),
  hour: contextPartMarker("cadence_hour"),
  day: contextPartMarker("cadence_day"),
  week: contextPartMarker("cadence_week"),
  month: contextPartMarker("cadence_month"),
});
const YEARLY_ICON = contextPartMarker("cadence_year");

/**
 * The drawn icon of `inside`, a path inside Tex's folder (`about-me.md`,
 * `routines/every-day`), or `null` for anything of the person's own. Takes the
 * path below Tex's folder, so a Tex folder nested anywhere is drawn the same.
 */
function texPartIcon(inside) {
  if (typeof inside !== "string") return null;
  if (Object.prototype.hasOwnProperty.call(TEX_PART_ICONS, inside)) return TEX_PART_ICONS[inside];
  const segments = inside.split("/");
  if (segments.length !== 2 || segments[0] !== "routines") return null;
  const cadence = cadenceFromFolder(segments[1]);
  if (cadence === null) return null;
  if (cadence.unit === "month" && cadence.every >= 12) return YEARLY_ICON;
  return CADENCE_ICONS[cadence.unit] ?? null;
}

function texIcon(path) {
  if (path === "tex") return TEX_FIGURE_ICON;
  return path.startsWith("tex/") ? texPartIcon(path.slice("tex/".length)) : null;
}

/** The default emoji for the folder (or built-in note) at `path`, or `null` for one with none. */
function defaultFolderIcon(path) {
  if (typeof path !== "string") return null;
  if (path === WEBSITE_FOLDER) return WEBSITE_ICON;
  const tex = texIcon(path);
  if (tex !== null) return tex;
  const segments = path.split("/");
  if (segments.length === 2 && topLevelRole(segments[0]) === "inbox") {
    return Object.prototype.hasOwnProperty.call(DEFAULT_INBOX_FOLDER_ICONS, segments[1])
      ? DEFAULT_INBOX_FOLDER_ICONS[segments[1]]
      : null;
  }
  const role = topLevelRole(path);
  return role === null ? null : DEFAULT_FOLDER_ICONS[role] ?? null;
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

/** The control plane's icon rows a store carries, or `null` for a store with none. */
function heldIcons(store) {
  const held = store?.folderIconsHeld;
  return held && typeof held.remap === "function" && typeof held.drop === "function" ? held : null;
}

/** Carry icons along with a folder move. Never throws. */
async function remapFolderIcons(store, from, to) {
  return await remapIcons(store, [{ from, to }]);
}

/**
 * Carry icons along with several moves at once (a batch of notes), in one
 * read and at most one write. Each move is applied to the map the previous
 * one left. Never throws.
 */
async function remapIcons(store, moves) {
  if (!Array.isArray(moves) || moves.length === 0) return null;
  try {
    const held = heldIcons(store);
    if (held !== null) {
      await held.remap(moves.map(({ from, to }) => ({ from, to })));
      return null;
    }
    return await updateFolderIcons(store, (icons) => {
      let next = icons;
      let changed = false;
      for (const { from, to } of moves) {
        const after = iconsAfterMove(next, from, to);
        if (after !== null) {
          next = after;
          changed = true;
        }
      }
      return changed ? next : null;
    });
  } catch {
    return null;
  }
}

/** Forget the icons of a folder deleted for good. Never throws. */
async function dropFolderIcons(store, path) {
  try {
    const held = heldIcons(store);
    if (held !== null) {
      await held.drop(path);
      return null;
    }
    return await updateFolderIcons(store, (icons) => iconsAfterDelete(icons, path));
  } catch {
    return null;
  }
}

module.exports = {
  FOLDER_ICONS_KEY,
  FOLDER_ICONS_VERSION,
  DEFAULT_FOLDER_ICONS,
  DEFAULT_INBOX_FOLDER_ICONS,
  TEX_FIGURE_ICON,
  defaultFolderIcon,
  texPartIcon,
  parseFolderIcons,
  serializeFolderIcons,
  iconsAfterMove,
  iconsAfterDelete,
  readFolderIcons,
  updateFolderIcons,
  remapFolderIcons,
  remapIcons,
  dropFolderIcons,
};

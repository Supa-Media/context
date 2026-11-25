/**
 * What kind of file a path names, decided in one place.
 *
 * Context keeps two kinds of file as text it reads and writes itself: a note
 * (`.md`, Markdown) and a sheet (`.csv`, a table with typed headers,
 * `docs/decisions/sheets.md`). Everything else (a picture, a PDF, a sound) is
 * a file: bytes Context stores and shows but never opens as text. A path's
 * kind is its last extension, exactly as written: `Plan.MD` is a file, not a
 * note. Case matters because the privacy engine's exact-note parser
 * (`apps/mcp/src/privacy/engine.js`) matches `.md` and `.csv` exactly; a kind
 * that ignored case would let `set_visibility` write an override that parser
 * refuses, and one refused line makes the whole manifest unreadable.
 *
 * Before this list, about 150 places asked `path.endsWith(".md")` on their
 * own, and every new text type had to be added to each of them by hand; the
 * ones that were (`|| .csv`) already disagreed with each other. Ask here
 * instead, and add a new text type with one line in `TEXT_KINDS`
 * (`docs/decisions/file-kinds.md`). `scripts/check-file-kinds.mjs` fails a
 * pull request that adds a hard-coded extension test anywhere else.
 *
 * A check that means Markdown on purpose (a form, a `.page.md`, front matter,
 * a routine, live co-editing) asks `isNotePath`. A check that means "text
 * Context reads and writes" (listing, search, visibility, saving) asks
 * `isTextFilePath`.
 *
 * Dependency-free CommonJS, so the gateway, Convex, the app and Tex all read
 * the same copy.
 */

const NOTE = "note";
const SHEET = "sheet";
const FILE = "file";

/** The text kinds, by extension. One line adds one. */
const TEXT_KINDS = Object.freeze({
  ".md": NOTE,
  ".csv": SHEET,
});

/** The extensions Context reads and writes as text, in `TEXT_KINDS` order. */
const TEXT_EXTENSIONS = Object.freeze(Object.keys(TEXT_KINDS));

/**
 * A path's last extension, with its dot and its case: `a/b.csv` → `.csv`.
 * A name with no dot after its first character has none (`""`), so a
 * dot-file such as `.gitignore` is not an extension.
 *
 * @param {unknown} path
 * @returns {string}
 */
function extensionOf(path) {
  if (typeof path !== "string") return "";
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/**
 * `note`, `sheet` or `file`. A folder path, or anything that is not a string,
 * is `file`: callers decide folders by the row, never by the name.
 *
 * @param {unknown} path
 * @returns {"note" | "sheet" | "file"}
 */
function kindOf(path) {
  const extension = extensionOf(path);
  return Object.prototype.hasOwnProperty.call(TEXT_KINDS, extension) ? TEXT_KINDS[extension] : FILE;
}

/** A Markdown note (`.md`). @param {unknown} path */
function isNotePath(path) {
  return kindOf(path) === NOTE;
}

/** A sheet (`.csv`). @param {unknown} path */
function isSheetPath(path) {
  return kindOf(path) === SHEET;
}

/** Text Context reads and writes itself: a note or a sheet. @param {unknown} path */
function isTextFilePath(path) {
  return kindOf(path) !== FILE;
}

module.exports = {
  NOTE,
  SHEET,
  FILE,
  TEXT_KINDS,
  TEXT_EXTENSIONS,
  extensionOf,
  kindOf,
  isNotePath,
  isSheetPath,
  isTextFilePath,
};

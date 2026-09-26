/** The grammar of a ```list block: see `../lists.js` for what it is for. */

/** The info string that marks a fenced block as a folder list. */
export const LIST_FENCE_LANG = "list";

/** Every key the block accepts. Anything else is an error, not a warning. */
// One string rather than an array literal: `"from", "` reads as an import to
// scripts/check-gateway-imports.mjs, which scans this folder by pattern.
export const LIST_KEYS = new Set("from where sort show limit subfolders rows group as".split(" "));

/** The only key that may appear more than once; its lines are ANDed. */
export const REPEATABLE_KEYS = new Set(["where"]);

/**
 * Condition operators, longest first so `is not set` is tried before `is not`
 * and `is`. Operators marked `unary` take no value.
 */
export const OPERATORS = [
  { op: "is not set", unary: true },
  { op: "is set", unary: true },
  { op: "is not", unary: false },
  { op: "contains", unary: false },
  { op: "is", unary: false },
];

/** Sort direction words, and the order each means. */
export const SORT_DIRECTIONS = new Map([
  ["newest first", "desc"],
  ["oldest first", "asc"],
  ["a to z", "asc"],
  ["z to a", "desc"],
  ["lowest first", "asc"],
  ["highest first", "desc"],
  ["ascending", "asc"],
  ["descending", "desc"],
]);

/** The word written back for an order, per kind of sort key. */
export function directionWord(key, order) {
  if (key === "updated") return order === "desc" ? "newest first" : "oldest first";
  return order === "desc" ? "z to a" : "a to z";
}


export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
export const MAX_COLUMNS = 4;

/** A property name: a letter, then letters, digits, `_` or `-`. */
export const PROPERTY_NAME = /^[A-Za-z][\w-]*$/;

/** What one row stands for: a note, or a project (a folder or note with a status). */
export const ROW_KINDS = new Set(["notes", "projects"]);

/** How a list is laid out. A board is columns by its `group` property. */
export const LAYOUTS = new Set(["list", "board"]);

/**
 * The note that speaks for a folder, first one present wins. A folder is a
 * project when this note has a `status`. See `docs/decisions/folder-lists.md`.
 */
export const FRONT_NOTES = ["overview.md", "index.md", "README.md"];

/**
 * Values that close a project, for a parent's "3 of 5" count. Lower-cased.
 * Anything else, including no status at all, is still open.
 */
export const CLOSED_STATUSES = new Set("done complete completed shipped cancelled canceled archived".split(" "));

/**
 * The order groups are drawn in when their values are lifecycle words, so a
 * list grouped by status reads active work first and finished work last.
 * Values not listed here follow in alphabetical order; an unset value is last.
 */
export const GROUP_ORDER = [
  "active", "in progress", "doing", "next", "planned", "todo", "backlog",
  "review", "blocked", "waiting", "paused", "done", "complete", "completed",
  "shipped", "cancelled", "canceled", "archived",
];

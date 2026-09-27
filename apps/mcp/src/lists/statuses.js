import { FRONT_NOTES } from "./grammar.js";

/**
 * Status groups: every status belongs to Not started, In progress or Done.
 *
 * ## The groups are fixed, the words are the folder's
 *
 * The three groups are the product's opinion and never change: they decide
 * the order a board and a list are drawn in, what counts toward a project's
 * "3 of 5", and what `status is done` matches. The words inside them belong
 * to a folder, declared in its front note as three frontmatter lists:
 *
 *     statuses-not-started: [exploration]
 *     statuses-in-progress: [in progress, in review]
 *     statuses-done: [finished, cancelled]
 *
 * Three flat keys rather than one nested map, because the frontmatter reader
 * is deliberately not YAML (`properties.js`) and a key that reader cannot see
 * would be a list no other surface could read. A note still says only
 * `status: in review`; its group is looked up here and never written into it,
 * so a note moved to another folder takes on that folder's meaning.
 *
 * ## "No status" is the empty value, not a word
 *
 * It is always the first status of Not started, so clearing a status stays a
 * one-line delete and a folder with nothing declared still has a start.
 *
 * ## Every group keeps a status
 *
 * A missing or empty In progress or Done list reads as its default, so there
 * is always a place to drop a card at each stage. Not started always has "No
 * status", so its list may be empty.
 *
 * ## Inherited from the nearest folder that declares one
 *
 * A folder with none takes its parent's, then its parent's, and a workspace
 * with none anywhere has the defaults. The workspace root never declares one:
 * its front note is the workspace's front page, not a folder's.
 *
 * ## Words nobody declared
 *
 * Notes predate their folder's list, and agents and other apps write what they
 * like. A word the list does not hold is placed by `KNOWN_WORDS` when it is an
 * ordinary lifecycle word (`active` is In progress, `shipped` is Done), and is
 * otherwise in no group: a surface shows it apart and asks which group it is
 * in, rather than guessing. See "Status groups" in
 * `docs/decisions/folder-lists.md`.
 */

/** The groups, in the order they are drawn. */
export const STATUS_GROUPS = ["not-started", "in-progress", "done"];

/** What each group is called, and the word `where: status is …` accepts for it. */
export const STATUS_GROUP_LABELS = {
  "not-started": "Not started",
  "in-progress": "In progress",
  done: "Done",
};

/** The frontmatter key that holds a group's words. */
export function statusKey(group) {
  return `statuses-${group}`;
}

/** Every key a status list is made of. */
export const STATUS_KEYS = STATUS_GROUPS.map(statusKey);

/** A folder's list when it declares nothing. */
export const DEFAULT_STATUSES = Object.freeze({
  "not-started": Object.freeze([]),
  "in-progress": Object.freeze(["in progress"]),
  done: Object.freeze(["finished"]),
});

/**
 * Ordinary lifecycle words, placed in a group when a folder's list does not
 * hold them. The order within a group is the order their columns are drawn
 * in. Lower-cased.
 */
export const KNOWN_WORDS = Object.freeze({
  "not-started": Object.freeze(["not started", "idea", "next", "planned", "todo", "to do", "backlog"]),
  "in-progress": Object.freeze([
    "active", "in progress", "doing", "started", "review", "in review", "blocked", "waiting", "on hold", "paused",
  ]),
  done: Object.freeze([
    "done", "finished", "complete", "completed", "shipped", "approved", "cancelled", "canceled", "archived",
  ]),
});

const known = new Map();
STATUS_GROUPS.forEach((group) => KNOWN_WORDS[group].forEach((word, index) => known.set(word, { group, index })));

/** A status word as compared: trimmed, lower-cased. */
export function foldStatus(word) {
  return typeof word === "string" ? word.trim().toLowerCase() : "";
}

function wordsOf(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" && value.trim() !== "" ? [value] : [];
  return list.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item !== "");
}

/** Whether a note's properties declare a status list at all. */
export function declaresStatuses(properties) {
  return STATUS_KEYS.some((key) => properties?.[key] !== undefined);
}

/**
 * A status list from a front note's properties: each group's words, trimmed,
 * a word in two groups kept in the first, and a missing or empty In progress
 * or Done read as its default. Words keep the spelling written.
 */
export function statusListOf(properties) {
  const seen = new Set();
  const list = {};
  for (const group of STATUS_GROUPS) {
    const words = [];
    for (const word of wordsOf(properties?.[statusKey(group)])) {
      const folded = foldStatus(word);
      if (seen.has(folded)) continue;
      seen.add(folded);
      words.push(word);
    }
    if (words.length === 0 && group !== "not-started") {
      for (const word of DEFAULT_STATUSES[group]) {
        if (!seen.has(word)) {
          seen.add(word);
          words.push(word);
        }
      }
    }
    list[group] = words;
  }
  return list;
}

/** The defaults, as a fresh list. */
export function defaultStatusList() {
  return statusListOf({});
}

function parentOf(folder) {
  const slash = folder.lastIndexOf("/");
  return slash === -1 ? "" : folder.slice(0, slash);
}

/**
 * The status list that applies inside `folder`, from the notes the caller
 * already holds: the first front note (`FRONT_NOTES` order) that declares one,
 * in `folder` and then each parent up to, but not including, the workspace
 * root. `from` is that folder, or null when nothing declares one and the list
 * is the defaults. `notes` is `[{ path, properties }]`.
 */
export function resolveStatusList(folder, notes) {
  const byPath = new Map();
  for (const note of notes || []) byPath.set(String(note.path || ""), note);
  let at = typeof folder === "string" ? folder.replace(/^\/+|\/+$/g, "") : "";
  while (at !== "") {
    const front = FRONT_NOTES.map((name) => byPath.get(`${at}/${name}`)).find((note) => note !== undefined);
    if (front !== undefined && declaresStatuses(front.properties)) {
      return { list: statusListOf(front.properties), from: at, note: front.path };
    }
    at = parentOf(at);
  }
  return { list: defaultStatusList(), from: null, note: null };
}

/**
 * Which group a status is in: the folder's list first, then `KNOWN_WORDS`;
 * `"not-started"` for no status at all, and null for a word nobody placed.
 */
export function statusGroupOf(status, list) {
  const folded = foldStatus(status);
  if (folded === "") return "not-started";
  for (const group of STATUS_GROUPS) {
    if ((list?.[group] ?? []).some((word) => foldStatus(word) === folded)) return group;
  }
  return known.get(folded)?.group ?? null;
}

/** Whether a status is in the folder's list itself, not placed by a known word. */
export function isDeclaredStatus(status, list) {
  const folded = foldStatus(status);
  return folded !== "" && STATUS_GROUPS.some((group) => (list?.[group] ?? []).some((word) => foldStatus(word) === folded));
}

/** Whether a status closes a project: it is in Done. */
export function isDoneStatus(status, list) {
  return statusGroupOf(status, list) === "done";
}

/**
 * Where a status sorts: by group, then its place in the folder's list, then
 * known words in their order, then a to z; words in no group after Done.
 * Returns a tuple compared left to right.
 */
function rankOf(status, list) {
  const folded = foldStatus(status);
  if (folded === "") return [0, -1, 0];
  const group = statusGroupOf(status, list);
  if (group === null) return [STATUS_GROUPS.length, 0, 0];
  const g = STATUS_GROUPS.indexOf(group);
  const declared = (list?.[group] ?? []).findIndex((word) => foldStatus(word) === folded);
  if (declared !== -1) return [g, 0, declared];
  return [g, 1, known.get(folded)?.index ?? Infinity];
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/**
 * Two statuses in the order a board draws them: Not started (No status
 * first), In progress, Done, then words in no group; within a group the
 * folder's own order, then known words, then a to z.
 */
export function compareStatuses(a, b, list) {
  if (foldStatus(a) === foldStatus(b)) return 0;
  const left = rankOf(a, list);
  const right = rankOf(b, list);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return collator.compare(String(a).trim(), String(b).trim());
}

/**
 * The words `where: status is …` reads as a whole group: each group's name,
 * and `open` for Not started and In progress together.
 */
export function statusGroupsNamed(word) {
  const folded = foldStatus(word);
  if (folded === "open") return ["not-started", "in-progress"];
  const group = STATUS_GROUPS.find((each) => foldStatus(STATUS_GROUP_LABELS[each]) === folded || each === folded);
  return group === undefined ? null : [group];
}

/**
 * The list with `word` added to `group`, removed from any other group first.
 * Returns the same shape `statusListOf` does. Never adds the empty word.
 */
export function withStatus(list, word, group, index = Infinity) {
  const folded = foldStatus(word);
  const next = {};
  for (const each of STATUS_GROUPS) next[each] = (list?.[each] ?? []).filter((item) => foldStatus(item) !== folded);
  if (folded === "" || !STATUS_GROUPS.includes(group)) return next;
  const words = next[group];
  const at = Math.max(0, Math.min(words.length, index));
  next[group] = [...words.slice(0, at), word.trim(), ...words.slice(at)];
  return next;
}

/**
 * Why a list cannot be written, or null: a group other than Not started left
 * empty, a word the frontmatter reader could not read back from an inline
 * list (a comma, a bracket, a quote, a line break, " #"), or one word twice.
 */
export function statusListProblem(list) {
  const seen = new Set();
  for (const group of STATUS_GROUPS) {
    const words = list?.[group] ?? [];
    if (group !== "not-started" && words.length === 0) {
      return `${STATUS_GROUP_LABELS[group]} needs at least one status`;
    }
    for (const word of words) {
      const trimmed = typeof word === "string" ? word.trim() : "";
      if (trimmed === "") return "a status needs a name";
      if (/[,[\]"'\p{Cc}]|\s#|^#/u.test(trimmed)) return `"${trimmed}" can't hold a comma, a bracket, a quote or " #"`;
      if (trimmed.length > 40) return "a status name is at most 40 characters";
      const folded = foldStatus(trimmed);
      if (seen.has(folded)) return `"${trimmed}" is already a status`;
      seen.add(folded);
    }
  }
  return null;
}

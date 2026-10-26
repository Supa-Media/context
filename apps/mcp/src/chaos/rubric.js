/**
 * The chaos rubric: how organized a folder is, as one number from 0 (calm)
 * to 100 (chaos), and a workspace as the weighted average of its folders.
 *
 * ## Whose rules these are
 *
 * The owner's, argued in the project thread "chaos score" (2026-10-10) and
 * written down in `docs/decisions/chaos-score.md`. It is deliberately
 * opinionated: one shape of a well-kept workspace, not a setting.
 *
 * - **Items.** A folder's items are the notes and subfolders directly in it.
 *   Its about note (about, overview, index, README) describes the folder and
 *   is not an item; neither are pictures, attachments or dot files.
 * - **The curve.** 4 or 5 items is calm. Each item past 5 adds 5 up to the
 *   average mark at 10 (25), then 4 each to 20 (65), then steeply to 100 at
 *   35. Below 4 is thin: three items cost 5, two cost 20 (combine them), one costs 40
 *   (move it out), and a folder holding nothing but its about note 60.
 * - **Runs.** Notes that are one sequence count as one item: the same name
 *   with a number after it (Kings 1 to Kings 30, a lettered second note such
 *   as `log-18b` included), notes named by date, or
 *   chapters numbered 1 to N with no gaps or repeats. Only up to 30, though:
 *   a run is one item per 30 notes, so a month of daily notes is fine and a
 *   year of them is not. Subfolders named by single letters (A to Z, and a
 *   catch-all such as `other` beside them) are a run the same way.
 * - **Long notes.** Past 1,000 lines a note gains 10 per 100 lines, reaching
 *   100 at 2,000, wherever it sits. A line over 120 characters counts as one
 *   per 120, so a wall of text can't dodge it. Meetings and notes marked
 *   `generated: true` are exempt: nobody wrote them long.
 * - **Never thin.** The root and the built-in folders (Inbox, Projects,
 *   Areas, Resources, Clients, Teams, Products) only count as crowded.
 * - **Never scored.** Archive, at the root and everything under it.
 * - **Contacts** are scored on hygiene, never on count: each page carries
 *   its own chaos (`contacts.js`), and the folders are never thin
 *   (2026-10-12).
 * - **The workspace.** Every note carries its folder's chaos, or its own
 *   length chaos when that is higher; a subfolder carries its parent's. The
 *   score is the average over all of them, so each folder weighs what it
 *   holds: 20% of the notes in a calm folder and 80% in a chaotic one is
 *   80% chaos.
 *
 * Pure: no storage, no clock. `live.js` feeds it the Convex tree's keys, and
 * the control plane keeps the facts it needs beyond them.
 */

import { FRONT_NOTES } from "../lists/grammar.js";
import { contactChaos, isContactsFolder } from "./contacts.js";
import { folderRole } from "../../../../packages/shared/src/folderRoles.cjs";
import { isMeetingNotePath } from "../../../../packages/meetings/src/paths.js";

/** Lines a note may run to before it starts to cost. */
export const LONG_NOTE_LINES = 1000;

/** Characters one line may hold before it counts as more than one. */
export const LINE_WIDTH = 120;

/** Notes in a run that count as one item. */
export const RUN_SPAN = 30;

const FRONT = new Set(FRONT_NOTES.map((name) => name.toLowerCase()));

/** Notes at the root that are the workspace's frame, not its content. */
const ROOT_FRAME_NOTES = new Set(["index.md", "privacy.md", "activity.md"]);

/** A root folder this product knows as an archive (`archive`, `4-archive`, `9-archive`). */
const ARCHIVE_ROOT = /^(?:\d+-)?archive$/i;

/** Built-in folder roles that are part of the workspace's frame. */
const FRAME_ROLES = new Set(["inbox", "projects", "areas", "resources", "archive", "clients", "teams", "products"]);

/**
 * Chaos for a folder holding `items` items.
 *
 * @param {number} items
 * @param {{ thinAllowed?: boolean }} [options] the root and built-in folders are never thin
 */
export function folderChaos(items, { thinAllowed = false } = {}) {
  const n = Math.max(0, Math.floor(items));
  if (n < 4) return thinAllowed ? 0 : [60, 40, 20, 5][n];
  if (n <= 5) return 0;
  if (n <= 10) return (n - 5) * 5;
  if (n <= 20) return 25 + (n - 10) * 4;
  return Math.min(100, 65 + ((n - 20) * 35) / 15);
}

/** Chaos a note of `lines` lines carries on its own. */
export function lengthChaos(lines) {
  if (!Number.isFinite(lines) || lines <= LONG_NOTE_LINES) return 0;
  return Math.min(100, (lines - LONG_NOTE_LINES) / 10);
}

/** A note's length in lines, a line past 120 characters counting once per 120. */
export function countLines(text) {
  if (typeof text !== "string") return 0;
  let lines = 0;
  for (const line of text.split("\n")) lines += Math.max(1, Math.ceil(line.length / LINE_WIDTH));
  return lines;
}

/** Whether a note is exempt from the long-note rule: meetings and generated notes. */
export function isExempt(path, type, generated) {
  if (type === "meeting" || isMeetingNotePath(path)) return true;
  return generated === 1 || generated === true || generated === "true";
}

/** Whether a `review:` property holds a question: any non-empty value. */
export function hasReview(value) {
  if (value === null || value === undefined || value === false || value === 0) return false;
  if (typeof value === "string") return value.trim() !== "" && value.trim() !== "[]";
  return true;
}

/** The workspace's word for a chaos number. */
export function chaosWord(chaos) {
  if (chaos <= 10) return "calm";
  if (chaos <= 30) return "fine";
  if (chaos <= 60) return "crowded";
  return "chaotic";
}

/** Whether a name is a note this rubric counts (not a front note, not a picture, not a dot file). */
function isCountedNote(name, { root }) {
  if (typeof name !== "string" || name.startsWith(".") || !name.toLowerCase().endsWith(".md")) return false;
  const lower = name.toLowerCase();
  if (FRONT.has(lower)) return false;
  if (root && ROOT_FRAME_NOTES.has(lower)) return false;
  return true;
}

/** A subfolder named by one letter, which with two others makes an A to Z index. */
const LETTER_FOLDER = /^[a-z]$/i;

/** The folder an A to Z index keeps for names that start with no letter. */
const CATCH_ALL_FOLDERS = new Set(["other", "#", "0-9", "_"]);

const DATED = /^\d{4}-\d{2}-\d{2}/;
/**
 * A name with a number at its end, a day's second or third note lettered
 * after it (`coverage-2026-09-18b`): on 2026-10-26 a folder of 54 such notes
 * scored as 54 items, so housekeeping would not file a month into it.
 */
const STEM_NUMBER = /^(.*?\D)[\s_-]*(\d+)[a-z]?$/i;
const LEADING_NUMBER = /^(\d{1,3})[\s._-]/;

/**
 * The runs among a folder's note names: groups of notes that are one sequence.
 *
 * @param {string[]} names counted note names
 * @returns {string[][]} each run's members; a name belongs to at most one
 */
function runsOf(names) {
  const runs = [];
  const taken = new Set();
  const dated = names.filter((name) => DATED.test(name));
  if (dated.length >= 3) {
    runs.push(dated);
    for (const name of dated) taken.add(name);
  }
  const stems = new Map();
  for (const name of names) {
    if (taken.has(name)) continue;
    const match = name.replace(/\.md$/i, "").match(STEM_NUMBER);
    if (!match) continue;
    const stem = match[1].toLowerCase().replace(/[\s_-]+$/, "");
    if (!stems.has(stem)) stems.set(stem, []);
    stems.get(stem).push(name);
  }
  for (const members of stems.values()) {
    if (members.length < 3) continue;
    runs.push(members);
    for (const name of members) taken.add(name);
  }
  // Chapters: every remaining numbered name, numbered 1..N (or any start) with no gaps or repeats.
  const numbered = names.filter((name) => !taken.has(name) && LEADING_NUMBER.test(name));
  if (numbered.length >= 3) {
    const numbers = numbered.map((name) => Number(name.match(LEADING_NUMBER)[1]));
    const unique = new Set(numbers).size === numbers.length;
    if (unique && Math.max(...numbers) - Math.min(...numbers) === numbers.length - 1) runs.push(numbered);
  }
  return runs;
}

/** An A to Z index among subfolder names: three or more single letters, and the catch-all beside them. */
function letterRunsOf(folders) {
  const letters = folders.filter((name) => LETTER_FOLDER.test(name));
  if (letters.length < 3) return [];
  return [[...letters, ...folders.filter((name) => CATCH_ALL_FOLDERS.has(name.toLowerCase()))]];
}

/**
 * How many items a folder holds, runs collapsed.
 *
 * @param {{ name: string }[]} notes every key directly in the folder
 * @param {string[]} folders subfolder names that hold at least one note
 * @param {{ root?: boolean }} [options]
 * @returns {{ items: number, raw: number, counted: string[] }} `raw` counts every note and subfolder once
 */
export function countItems(notes, folders, { root = false } = {}) {
  const counted = notes.map((note) => note.name).filter((name) => isCountedNote(name, { root }));
  const subfolders = folders.filter((name) => !(root && FRAME_ROLES.has(folderRole(name) ?? "")) && !name.startsWith("."));
  let items = subfolders.length + counted.length;
  for (const run of [...runsOf(counted), ...letterRunsOf(subfolders)]) items -= run.length - Math.ceil(run.length / RUN_SPAN);
  return { items, raw: counted.length + subfolders.length, counted };
}

/** Whether a folder path is the root or one of the built-in folders, which are never thin. */
function thinAllowed(path) {
  if (path === "" || isContactsFolder(path)) return true;
  if (path.includes("/")) return false;
  return FRAME_ROLES.has(folderRole(path) ?? "");
}

/** Whether a path is in an archive, which is never scored. */
export function isArchived(path) {
  return ARCHIVE_ROOT.test(String(path).split("/")[0]);
}

/**
 * One folder's score.
 *
 * @param {{ path: string, notes: { name: string, lines?: number | null, exempt?: boolean, review?: boolean }[], folders: string[] }} folder
 * @returns {{ path: string, items: number, weight: number, sum: number, chaos: number }}
 *   `weight` is how much the folder counts toward the workspace and `sum` its
 *   share of chaos in it, so `chaos = sum / weight` and the workspace score is
 *   Σsum / Σweight.
 */
export function scoreFolder({ path, notes, folders }) {
  const root = path === "";
  const { items, raw, counted } = countItems(notes, folders, { root });
  const contacts = isContactsFolder(path);
  const base = contacts ? 0 : folderChaos(items, { thinAllowed: thinAllowed(path) });
  const countedSet = new Set(counted);
  // In contacts a subfolder weighs nothing: its pages carry their own chaos.
  let sum = contacts ? 0 : (raw - counted.length) * base;
  for (const note of notes) {
    if (!countedSet.has(note.name)) continue;
    const own = contacts ? contactChaos(path, note) : base;
    sum += Math.max(own, note.exempt ? 0 : lengthChaos(note.lines));
  }
  let weight = contacts ? counted.length : raw;
  if (weight === 0 && base > 0) {
    // Nothing but its about note: the folder still counts, once.
    weight = 1;
    sum = base;
  }
  return { path, items, weight, sum, chaos: weight === 0 ? 0 : sum / weight };
}

/** The folder a key sits in (`""` for the root). */
export function parentOf(path) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * Every folder's score, and the workspace's, from its keys.
 *
 * A folder exists while a note sits somewhere beneath it; a folder holding
 * only pictures is where a note keeps its attachments, and is not scored.
 *
 * @param {{ path: string, lines?: number | null, exempt?: boolean }[]} rows every key in the tree
 * @param {{ only?: (folder: string) => boolean }} [options] score only these folders
 * @returns {{ score: number, weight: number, sum: number, folders: ReturnType<typeof scoreFolder>[] }}
 */
export function scoreTree(rows, { only } = {}) {
  const shape = treeShape(rows);
  const folders = [];
  let weight = 0;
  let sum = 0;
  for (const [path, entry] of shape) {
    if (only && !only(path)) continue;
    const scored = scoreFolder({ path, notes: entry.notes, folders: [...entry.folders] });
    folders.push(scored);
    weight += scored.weight;
    sum += scored.sum;
  }
  return { score: weight === 0 ? 0 : sum / weight, weight, sum, folders };
}

/**
 * The folders under the rows, each with its direct notes and subfolders.
 * Archive and dot paths are left out.
 *
 * @returns {Map<string, { notes: { name: string, lines?: number | null, exempt?: boolean }[], folders: Set<string> }>}
 */
export function treeShape(rows) {
  const shape = new Map();
  const ensure = (path) => {
    if (!shape.has(path)) shape.set(path, { notes: [], folders: new Set() });
    return shape.get(path);
  };
  for (const row of rows) {
    const path = typeof row?.path === "string" ? row.path : "";
    if (path === "" || isArchived(path) || path.split("/").some((part) => part.startsWith("."))) continue;
    const parts = path.split("/");
    const name = parts[parts.length - 1];
    // Pictures and attachments are never items, and a folder holding only them is a note's attachments.
    if (!name.toLowerCase().endsWith(".md")) continue;
    ensure(parts.slice(0, -1).join("/")).notes.push({
      name,
      lines: row.lines ?? null,
      exempt: row.exempt === true,
      review: row.review === true,
    });
    // Every folder above a note exists.
    for (let depth = parts.length - 1; depth >= 1; depth -= 1) {
      ensure(parts.slice(0, depth - 1).join("/")).folders.add(parts[depth - 1]);
    }
  }
  ensure("");
  return shape;
}

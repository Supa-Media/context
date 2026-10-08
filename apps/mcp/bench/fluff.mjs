// Filler notes for a benchmark workspace. A fluff.md says how many notes to write in its folder,
// which templates to draw them from, and which hand-written notes to copy as older versions.
// Expansion is a pure function of the file and the seed, so two runs write identical notes.
import { posix } from "node:path";

import { normalize, parseFront } from "./frontMatter.mjs";

export const MAX_COUNT = 50000;
const MAX_SEED = 4294967295;
const DEFAULT_UPDATED = "2026-01-01";
const DAY_MS = 86400000;
const KEYS = new Set(["count", "seed", "from", "name", "dates", "updated"]);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DISTRACTOR = /^- older copy of (.+?) as (.+?) dated (\S+)\s*$/;

// Plain English words for {word} in a template. The order is part of the format: changing
// it changes what every seed writes, so add words only at the end and say so in the commit.
export const WORDS = [
  "apple", "river", "candle", "garden", "window", "pencil", "breeze", "orange", "pocket", "ladder",
  "mirror", "puzzle", "harbor", "meadow", "lantern", "rocket", "velvet", "copper", "thunder", "pebble",
  "falcon", "compass", "blanket", "marble", "quartz", "saddle", "tunnel", "widget", "anchor", "bramble",
  "cabin", "dolphin", "engine", "feather", "glacier", "hammer", "island", "jacket", "kettle", "lemon",
  "magnet", "nickel", "oyster", "parcel", "quiver", "rabbit", "sponge", "timber", "umbrella", "valley",
  "walnut", "yogurt", "zipper", "basket", "canyon", "denim", "ember", "forest", "goblet", "hatch",
  "ivory", "jigsaw", "kingdom", "lobster", "meteor", "napkin", "orchid", "pillow", "quilt", "ribbon",
  "sailor", "thimble", "utensil", "vessel", "whistle", "yarn", "almond", "beacon", "cactus", "dynamo",
  "elbow", "fjord", "gravel", "hazel", "iceberg", "jungle", "kitten", "lattice", "mustard", "nutmeg",
  "olive", "pepper", "quarry", "rooster", "sandal", "tulip", "upland", "violet", "wagon", "zebra",
];

// A small seeded PRNG (mulberry32): the same 32-bit seed always gives the same numbers in [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A real calendar date in YYYY-MM-DD form, not just a string of that shape.
function isIsoDate(s) {
  if (!ISO.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}

/** A path written in a fluff file, relative to that file's folder, as a workspace path. */
export function resolveRel(dir, rel) {
  if (rel.startsWith("/")) throw new Error(`"${rel}" must be relative to the fluff file's folder`);
  const path = posix.normalize(posix.join(dir, rel));
  if (path === ".." || path.startsWith("../")) {
    throw new Error(`"${rel}" from ${dir || "the workspace root"} is outside the workspace`);
  }
  return path;
}

/**
 * Read a fluff.md. Throws with the file line that is wrong. `label` names the file in
 * those messages, e.g. "workspaces/ws/meetings/fluff.md".
 */
export function parseFluff(raw, label = "fluff.md") {
  const lines = normalize(raw).split("\n");
  if (lines[0] !== "---") throw new Error(`${label} line 1: the file must open with a --- front matter fence`);
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error(`${label}: the front matter is not closed by a --- line`);

  const front = parseFront(lines.slice(1, end), 2);
  for (const key of Object.keys(front)) {
    if (!KEYS.has(key)) throw new Error(`${label}: unknown key "${key}" (use count, seed, from, name, dates or updated)`);
  }
  const at = (key) => {
    const i = lines.findIndex((line, j) => j > 0 && j < end && line.startsWith(`${key}:`));
    return i < 0 ? label : `${label} line ${i + 1}`;
  };
  const required = (key) => {
    if (typeof front[key] !== "string" || front[key] === "") throw new Error(`${label}: ${key} is required`);
    return front[key];
  };

  const countRaw = required("count");
  const count = /^\d+$/.test(countRaw) ? Number(countRaw) : 0;
  if (count < 1) throw new Error(`${at("count")}: count must be a whole number from 1 to 50,000`);
  if (count > MAX_COUNT) throw new Error(`${at("count")}: count ${count} is over the 50,000 limit`);

  const seedRaw = required("seed");
  const seed = /^\d+$/.test(seedRaw) ? Number(seedRaw) : -1;
  if (seed < 0 || seed > MAX_SEED) throw new Error(`${at("seed")}: seed must be a whole number from 0 to 4294967295`);

  const from = required("from");
  if (from === "." || from === ".." || /[/\\]/.test(from)) {
    throw new Error(`${at("from")}: from must be one folder name under workspaces/_bank/, not a path`);
  }

  const name = required("name");
  if (/[/\\]/.test(name)) throw new Error(`${at("name")}: name must be a file name, not a path`);
  if (!name.endsWith(".md")) throw new Error(`${at("name")}: name must end in .md`);
  const tokens = name.match(/\{[^}]*\}/g) ?? [];
  const other = tokens.find((token) => token !== "{n}" && token !== "{date}");
  if (other) throw new Error(`${at("name")}: name uses ${other}; only {n} and {date} can be used in a name`);
  if (tokens.length === 0) throw new Error(`${at("name")}: name must contain {n} or {date}, so notes get different names`);

  let dates = null;
  if (front.dates !== undefined) {
    const m = front.dates.match(/^(\S+) to (\S+)$/);
    if (!m || !isIsoDate(m[1]) || !isIsoDate(m[2])) {
      throw new Error(`${at("dates")}: dates must read "YYYY-MM-DD to YYYY-MM-DD" with real dates, got "${front.dates}"`);
    }
    if (m[1] > m[2]) throw new Error(`${at("dates")}: dates must run from an earlier date to a later one, got "${front.dates}"`);
    dates = { from: m[1], to: m[2] };
  }

  let updated = null;
  if (front.updated !== undefined) {
    if (!isIsoDate(front.updated)) throw new Error(`${at("updated")}: updated must be an ISO date (YYYY-MM-DD), got "${front.updated}"`);
    updated = front.updated;
  }

  // Only bullets under "## Distractors" mean anything; the rest of the body is for people.
  const distractors = [];
  let inSection = false;
  for (let i = end + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) {
      inSection = /^##\s+Distractors\s*$/.test(line);
      continue;
    }
    if (!inSection || !/^-\s/.test(line)) continue;
    const where = `${label} line ${i + 1}`;
    const m = line.match(DISTRACTOR);
    if (!m) throw new Error(`${where}: a distractor must read "- older copy of <path> as <name> dated <date>"`);
    const [, path, as, date] = m;
    if (as === "fluff.md") throw new Error(`${where}: as fluff.md is the fluff file itself`);
    if (/[/\\]/.test(as) || !as.endsWith(".md")) throw new Error(`${where}: distractor copy name "${as}" must be a bare .md file name`);
    if (!isIsoDate(date)) throw new Error(`${where}: distractor date "${date}" must be a real YYYY-MM-DD date`);
    distractors.push({ from: path, as, date });
  }

  return { count, seed, from, name, dates, updated, distractors };
}

// Set the top-level updated: line, merging into any front matter the text already has.
export function withUpdated(raw, date) {
  const lines = normalize(raw).split("\n");
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  if (end > 0) {
    const kept = lines.slice(1, end).filter((line) => !/^updated:/.test(line));
    return ["---", `updated: ${date}`, ...kept, ...lines.slice(end)].join("\n");
  }
  return `---\nupdated: ${date}\n---\n${normalize(raw)}`;
}

// Mark the first line of text in the body, so nobody mistakes an older copy for the real note.
function markOlderCopy(text) {
  const lines = text.split("\n");
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  const start = end > 0 ? end + 1 : 0;
  const i = lines.findIndex((line, j) => j >= start && line.trim() !== "");
  if (i < 0) return `${text.replace(/\n*$/, "\n")}(older copy)\n`;
  lines[i] = `(older copy) ${lines[i]}`;
  return lines.join("\n");
}

// The date of each note, sorted ascending so {date} names read in order. Dates are drawn
// first, before any template, so editing a template never moves a date.
function noteDates(fluff, rng) {
  if (!fluff.dates) return Array.from({ length: fluff.count }, () => fluff.updated ?? DEFAULT_UPDATED);
  const first = Date.parse(`${fluff.dates.from}T00:00:00Z`) / DAY_MS;
  const last = Date.parse(`${fluff.dates.to}T00:00:00Z`) / DAY_MS;
  const span = last - first + 1;
  const days = Array.from({ length: fluff.count }, () => first + Math.floor(rng() * span));
  days.sort((a, b) => a - b);
  return days.map((day) => new Date(day * DAY_MS).toISOString().slice(0, 10));
}

// Fill {n}, {date} and {word} in a template. Each {word} is its own draw from the PRNG.
function fillTemplate(template, { n, date }, rng) {
  return template.replace(/\{(n|date|word)\}/g, (_, key) => {
    if (key === "n") return n;
    if (key === "date") return date;
    return WORDS[Math.floor(rng() * WORDS.length)];
  });
}

const padded = (n, width) => String(n).padStart(width, "0");

/**
 * The notes one fluff file writes, as workspace path -> text. Refuses to write over a
 * hand-written note (`files`); two generated notes with one name get "-{n}" appended.
 *
 * @param {object} args
 * @param {string} [args.dir] the fluff file's folder, relative to the workspace root ("" for the root)
 * @param {object} args.fluff what parseFluff returned
 * @param {Record<string, string>} args.templates the folder's templates, name -> text
 * @param {Record<string, string>} [args.files] the workspace's hand-written notes, path -> text
 */
export function expandFluff({ dir = "", fluff, templates, files = {} }) {
  const names = Object.keys(templates ?? {}).sort();
  if (names.length === 0) throw new Error(`workspaces/_bank/${fluff.from}/ is missing or has no .md templates`);

  const rng = mulberry32(fluff.seed);
  const dates = noteDates(fluff, rng);
  const width = String(fluff.count).length;
  const made = new Map();

  for (let n = 1; n <= fluff.count; n += 1) {
    const index = padded(n, width);
    const date = dates[n - 1];
    const template = templates[names[Math.floor(rng() * names.length)]];
    const text = withUpdated(fillTemplate(template, { n: index, date }, rng), date);
    const named = fluff.name.replace(/\{(n|date)\}/g, (_, key) => (key === "n" ? index : date));
    let path = posix.join(dir, named);
    if (Object.hasOwn(files, path)) throw new Error(`${path} would overwrite a hand-written note`);
    if (made.has(path)) {
      path = posix.join(dir, named.replace(/\.md$/, `-${index}.md`));
      if (Object.hasOwn(files, path)) throw new Error(`${path} would overwrite a hand-written note`);
      if (made.has(path)) throw new Error(`${path} is generated twice; change the name pattern`);
    }
    made.set(path, text);
  }

  for (const d of fluff.distractors) {
    const source = resolveRel(dir, d.from);
    if (!Object.hasOwn(files, source)) throw new Error(`distractor copies ${source}, which is not a note in this workspace`);
    const path = resolveRel(dir, d.as);
    if (Object.hasOwn(files, path)) throw new Error(`${path} would overwrite a hand-written note`);
    if (made.has(path)) throw new Error(`${path} is already used by another generated note`);
    made.set(path, markOlderCopy(withUpdated(files[source], d.date)));
  }

  return Object.fromEntries(made);
}

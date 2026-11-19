/**
 * THE SIMULATED WORLD'S ANSWERS, KEPT PER CONVERSATION (`simWorld.mjs`).
 *
 * A model used to invent every outside answer fresh each run, so one Front door conversation scored 11/30 and then
 * 15/30 on the same commit (Dev set, 2026-11-19, 249c2bd): the same flight cost $689, then $742, then $489, and the
 * passenger names changed. An answer the world gave is now a fixture, keyed by the tool's kind and its normalized
 * arguments, and replayed. The model is asked only on a miss. A miss is claimed in the run's folder, so the test
 * processes of one conversation agree with each other, and it is reported, so a person can record it on purpose
 * (`--world record`, `setsFd.mjs`).
 *
 * Nothing here is customer data: fixtures are bench data, written beside the conversation they belong to.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const WORLD_MODES = ["replay", "record", "refresh"];
/** The only sets a record or refresh may write fixtures from: the repo's own. The sealed Test set is never one. */
export const RECORD_SETS = ["training", "dev"];
/** `replay` (the default) answers from fixtures; `record` adds the misses to them; `refresh` answers all from the model. */
export const worldMode = (v) => (WORLD_MODES.includes(String(v ?? "").trim()) ? String(v).trim() : "replay");
export const FIXTURES_DIR = "apps/mcp/bench/sets/sim";
/** Where a conversation's fixtures live, under a tree root. */
export const fixturePath = (tree, id) => join(tree, FIXTURES_DIR, `${id}.json`);

/**
 * A request as a key sees it: case, spacing and key order are not part of what was asked, and a key the request
 * leaves unset (undefined or null) is the same as one it does not have. Numbers and booleans are left as they are.
 */
export function normalizeRequest(value) {
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ").toLowerCase();
  if (Array.isArray(value)) return value.map(normalizeRequest);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined || value[key] === null) continue;
      out[key] = normalizeRequest(value[key]);
    }
    return out;
  }
  return value;
}

/** The key a call is answered under: its tool kind and its normalized request. */
export function worldKey(kind, request) {
  return `${kind} ${JSON.stringify(normalizeRequest(request))}`;
}

const STOP = new Set(["a", "an", "and", "at", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with", "www", "http", "https", "com"]);

/** The words of a request's string values, lowercased, as a set: what two wordings of one ask share. */
export function requestWords(request) {
  const words = new Set();
  const walk = (value) => {
    if (typeof value === "string") {
      for (const word of value.toLowerCase().split(/[^a-z0-9]+/)) if (word.length > 1 && !STOP.has(word)) words.add(word);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(request);
  return words;
}

/** How alike two requests' words are: shared over all (Jaccard), 0 when either has none. */
export function requestLikeness(a, b) {
  const x = requestWords(a);
  const y = requestWords(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared += 1;
  return shared / (x.size + y.size - shared);
}

/** At least this alike, a recorded call answers a reworded one (a replay never invents an answer). */
export const NEAR_LIKENESS = 0.5;

/**
 * The recorded answer of the same kind whose request is most alike, when it is at least `min` alike: a replay's answer
 * to a search or page Tex worded a little differently from the recording. Ties go to the first key in sorted order, so
 * the same call always gets the same answer. Null when nothing is near enough.
 */
export function nearestFixture(fixtures, kind, request, min = NEAR_LIKENESS) {
  let best = null;
  let score = 0;
  for (const key of [...(fixtures?.keys() ?? [])].sort()) {
    const entry = fixtures.get(key);
    if (entry.kind !== kind) continue;
    const likeness = requestLikeness(request, entry.request);
    if (likeness >= min && likeness > score) {
      best = entry;
      score = likeness;
    }
  }
  return best ? { key: best.key, answer: best.answer, likeness: score } : null;
}

/** A conversation's fixtures as a Map of key to `{ key, kind, request, answer }`. A missing file is no fixtures. */
export function readFixtures(path) {
  const fixtures = new Map();
  if (!existsSync(path)) return fixtures;
  const file = JSON.parse(readFileSync(path, "utf8"));
  for (const entry of file.answers ?? []) {
    const key = entry.key ?? worldKey(entry.kind, entry.request);
    fixtures.set(key, { key, kind: entry.kind, request: entry.request, answer: entry.answer });
  }
  return fixtures;
}

/** One claimed answer's file in a run folder: a hash of its key, so any key is a safe name. */
const entryFile = (runDir, key) => join(runDir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);

/** A run folder's entry as written, or null when no process has claimed that key. */
function readEntry(file) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * A world's store of answers for one run. `fixtures` is a Map as `readFixtures` returns it, or null. `runDir` is the
 * folder every test process of the run shares (null: this process only). `mode` decides whether the fixtures are
 * read at all. `test` names the test that is asking, so a miss says which test it came from.
 */
export function openWorldStore({ fixtures = null, runDir = null, mode = "replay", test = null, closed = false } = {}) {
  // This process's own claims, by key, and the calls it asked the model for, in order.
  const own = new Map();
  const claimed = [];

  return {
    mode,
    /** A closed world (a replay with a fixtures file) never asks its model: a miss gets the nearest fixture or nothing. */
    closed: closed && mode === "replay",

    /** The recorded answer nearest a call no key matched (`nearestFixture`), or null. */
    near(kind, request) {
      return mode === "replay" ? nearestFixture(fixtures, kind, request) : null;
    },

    /** The answer for `key` and where it came from: this process, another process of the run, or the fixtures. */
    get(key) {
      if (own.has(key)) return { answer: own.get(key).answer, from: "run" };
      if (runDir) {
        const entry = readEntry(entryFile(runDir, key));
        if (entry) return { answer: entry.answer, from: "run" };
      }
      if (mode !== "refresh" && fixtures?.has(key)) return { answer: fixtures.get(key).answer, from: "fixture" };
      return null;
    },

    /**
     * Keeps the answer the model gave for `key`, and returns the answer that stands: the first claim wins, so two
     * processes that missed the same call at once still agree.
     */
    claim(key, kind, request, answer, { fake = false } = {}) {
      claimed.push({ kind, request, test });
      if (own.has(key)) return own.get(key).answer;
      if (!runDir) {
        const entry = { key, kind, request, answer, test, ...(fake ? { fake: true } : {}) };
        own.set(key, entry);
        return entry.answer;
      }
      mkdirSync(runDir, { recursive: true });
      const file = entryFile(runDir, key);
      const entry = { key, kind, request, answer, test, ...(fake ? { fake: true } : {}) };
      const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      let kept = entry;
      try {
        writeFileSync(tmp, `${JSON.stringify(entry, null, 1)}\n`);
        linkSync(tmp, file); // atomic, and it fails if another process claimed the key first
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        kept = readEntry(file);
      } finally {
        rmSync(tmp, { force: true });
      }
      own.set(key, kept);
      return kept.answer;
    },

    /** Every answer the world has shown this run, the fixtures' first (unless refresh), deduped by key. */
    known() {
      const seen = new Map();
      const add = (entry) => {
        if (!seen.has(entry.key)) seen.set(entry.key, { kind: entry.kind, request: entry.request, answer: entry.answer });
      };
      if (mode !== "refresh") for (const entry of fixtures?.values() ?? []) add(entry);
      for (const entry of runMisses(runDir)) add(entry);
      for (const [key, entry] of own) add({ key, ...entry });
      return [...seen.values()];
    },

    /** The calls this process asked the model for: kind, request and the test that asked. */
    misses: () => claimed.map((entry) => ({ ...entry })),
  };
}

/** Every entry a run folder holds, sorted by key. None when the folder does not exist. */
export function runMisses(runDir) {
  if (!runDir || !existsSync(runDir)) return [];
  return readdirSync(runDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(runDir, name), "utf8")))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** An email address a fixture may keep as it is: an example domain, never a real one. */
const EXAMPLE_EMAIL = /@(?:[A-Za-z0-9-]+\.)*(?:example|test)$|@(?:[A-Za-z0-9-]+\.)*example\.(?:com|org|net)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * A value with every real-looking email address moved onto an example domain, its last label made `example`
 * (`someone@gmail.com` -> `someone@gmail.example`), the way the bench's own worlds write them. The simulated world
 * invents mail, and a name it invents on a real domain may be a real person's address: fixtures are committed to a
 * public repository, so none is ever kept. Requests are rewritten the same way, so a later call that asks for an
 * address the world showed asks for the example one, and its key matches.
 */
export function benchSafe(value) {
  if (typeof value === "string") return value.replace(EMAIL, (address) => (EXAMPLE_EMAIL.test(address) ? address : address.replace(/\.[A-Za-z]{2,}$/, ".example")));
  if (Array.isArray(value)) return value.map(benchSafe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, benchSafe(v)]));
  return value;
}

/**
 * A fixture file's text: one answer a line, sorted by key, so a re-recording's diff is the answers it added or changed
 * and a long conversation's file stays a few hundred lines, not thousands (`pnpm architecture`).
 */
export function fixtureText(id, answers) {
  const lines = answers.map((a) => JSON.stringify({ key: a.key, kind: a.kind, request: a.request, answer: a.answer }));
  return `{"conversation": ${JSON.stringify(id)}, "answers": [${lines.length === 0 ? "" : `\n${lines.join(",\n")}\n`}]}\n`;
}

/**
 * Writes a conversation's fixtures from the run's entries. `record` adds the new answers and keeps the answers
 * already recorded; `refresh` replaces the file with the run's answers; `replay` writes nothing. Fake answers (a run
 * with no model) are never written. Returns how many answers were written.
 */
export function saveFixtures(path, id, entries, mode) {
  if (mode !== "record" && mode !== "refresh") return 0;
  const byKey = mode === "record" ? readFixtures(path) : new Map();
  let written = 0;
  for (const entry of entries) {
    if (entry.fake) continue;
    // Every answer kept is bench-safe (`benchSafe`), its key taken from the safe request.
    const request = benchSafe(entry.request);
    const key = worldKey(entry.kind, request);
    if (byKey.has(key)) continue;
    byKey.set(key, { key, kind: entry.kind, request, answer: benchSafe(entry.answer) });
    written += 1;
  }
  // The answers already recorded are made bench-safe too, so a file recorded before `benchSafe` is cleaned on its next record.
  const safe = new Map();
  for (const e of byKey.values()) {
    const request = benchSafe(e.request);
    const key = worldKey(e.kind, request);
    if (!safe.has(key)) safe.set(key, { key, kind: e.kind, request, answer: benchSafe(e.answer) });
  }
  const answers = [...safe.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, fixtureText(id, answers));
  return mode === "refresh" ? answers.length : written;
}

/**
 * The answers the world has shown, one line each, for the model to keep to: the LAST ones that fit in `cap`
 * characters, since the oldest go first when the conversation is long.
 */
export function knownFacts(entries, cap = 12_000) {
  const lines = entries.map((e) => `- ${e.kind} ${JSON.stringify(e.request)} -> ${JSON.stringify(e.answer).slice(0, 600)}`);
  const kept = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const add = lines[i].length + (kept.length > 0 ? 1 : 0);
    if (total + add > cap) break;
    kept.push(lines[i]);
    total += add;
  }
  return kept.reverse().join("\n");
}

/**
 * The front matter lines a set test's world reads (`simWorld.mjs` simulateFor): its conversation's run folder, the
 * mode, the recorded fixtures when the tree has any, and the test's name, so each miss says which test it came from.
 */
export function worldFront({ tree, id, runDir, mode, test }) {
  const fixtures = fixturePath(tree, id);
  return [`world_run: ${runDir}`, `world_mode: ${mode}`, ...(existsSync(fixtures) ? [`world_fixtures: ${fixtures}`] : []), `world_test: ${test}`].join("\n");
}

/** A test's world on its rows: how many simulated calls no fixture answered, and which (`setsRun.mjs` worldLine). */
export function testWorld(missed, test) {
  const calls = missed.filter((e) => e.test === test).map((e) => ({ kind: e.kind, call: JSON.stringify(e.request).slice(0, 300) }));
  return { misses: calls.length, calls };
}

/**
 * A recording run's answers into the tree's fixtures, one file a conversation (`prepared`: `{ id, runDir }`), before
 * the run folders go. `record` keeps the fixtures' own answers, `refresh` replaces them; `replay` writes nothing.
 */
export function saveRunFixtures(prepared, tree, mode, log = (line) => process.stderr.write(line)) {
  if (mode === "replay") return;
  for (const p of prepared) {
    if (!p?.id) continue;
    const n = saveFixtures(fixturePath(tree, p.id), p.id, runMisses(p.runDir), mode);
    log(`world fixtures: ${n} answers written to ${FIXTURES_DIR}/${p.id}.json\n`);
  }
}

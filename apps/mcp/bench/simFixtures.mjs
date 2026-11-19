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
export function openWorldStore({ fixtures = null, runDir = null, mode = "replay", test = null } = {}) {
  // This process's own claims, by key, and the calls it asked the model for, in order.
  const own = new Map();
  const claimed = [];

  return {
    mode,

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
    const key = entry.key ?? worldKey(entry.kind, entry.request);
    if (byKey.has(key)) continue;
    byKey.set(key, { key, kind: entry.kind, request: entry.request, answer: entry.answer });
    written += 1;
  }
  const answers = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ conversation: id, answers }, null, 1)}\n`);
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

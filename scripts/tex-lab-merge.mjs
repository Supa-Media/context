#!/usr/bin/env node
/**
 * A LAB DRAFT IS MERGED ONTO MAIN, NEVER WRITTEN OVER IT (Dev2, 2026-11-17: "how are we avoiding merge conflicts";
 * chose "A + B + schema, no split").
 *
 * Before this, Promote wrote a draft's whole graph over main's config, so a draft made before someone else's change
 * merged quietly undid that change. Now a draft remembers the main it started from (`texConfigStamp.cjs`), and
 * Promote is a three-way merge:
 *
 *   mine   = what the draft changed since its base       (texLabOps `diffGraphs`, one edit per setting)
 *   theirs = what main changed since the same base
 *   result = main as it is now + mine
 *
 * Settings only one side changed merge on their own. A step's context list both sides changed merges as a list (the
 * draft's additions and removals onto main's order). A position both moved keeps main's. Anything else both changed,
 * a prompt module's words both changed, or an edit main has made impossible (a wire to a step main removed) is a clash:
 * Promote is refused and the refusal names each one with main's value and the draft's, so nobody's change is lost
 * without a person choosing. The person then picks a side for each, in the Lab or with tex_dev's promote `picks`
 * ({ "<what>": "main" | "draft" }), and promotes again: "main" drops the draft's edit, "draft" applies it over main's.
 * An edit main has made impossible has no "draft" side to pick; it is made again in a fresh draft.
 *
 *   node scripts/tex-lab-merge.mjs --self-test
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH } from "./lib/texConfigFile.mjs";

const require = createRequire(import.meta.url);
const { applyOps, conflicts, diffGraphs, keysOf } = require("../packages/shared/src/texLabOps.cjs");
const { configStamp, isStamp } = require("../packages/shared/src/texConfigStamp.cjs");

export { CONFIG_PATH };
export const WORDS_PATH = "packages/shared/src/texPrompt";
/** How far back on main a draft's base is looked for. */
const LOOK_BACK = 400;
/** List fields both sides may change at once: merged as lists, not clashed. */
const LIST_FIELDS = new Set(["ctx", "areas"]);
/** A step's input and output fields: merged by field name; one field both changed differently is a clash. */
const IO_FIELDS = new Set(["inSchema", "outSchema"]);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v, max = 40) => {
  const s = v === undefined ? "nothing" : typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};
/** One side of a clash on a list (a context list, an io schema): what it added and took out since the base, by name. */
const listSide = (was, now) => {
  if (!Array.isArray(was) || !Array.isArray(now)) return short(now);
  const key = (x) => (x && typeof x === "object" && typeof x.name === "string" ? x.name : JSON.stringify(x));
  const before = new Map(was.map((x) => [key(x), JSON.stringify(x)]));
  const after = new Map(now.map((x) => [key(x), JSON.stringify(x)]));
  const added = [...after.keys()].filter((k) => !before.has(k));
  const gone = [...before.keys()].filter((k) => !after.has(k));
  const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));
  const parts = [added.length ? `adds ${added.join(", ")}` : "", gone.length ? `takes out ${gone.join(", ")}` : "", changed.length ? `changes ${changed.join(", ")}` : ""].filter(Boolean);
  return short(parts.length ? parts.join("; ") : "reorders it", 120);
};
const core = (c) => ({ nodes: c.nodes, edges: c.edges, ...(c.groups ? { groups: c.groups } : {}) });

/** Two edits to a list of named fields (`inSchema`, `outSchema`) merged by name, or null when both changed one field. */
export function mergeIo(base = [], mine = [], theirs = []) {
  const by = (list) => new Map(list.map((f) => [f.name, f]));
  const [b, m, t] = [by(base), by(mine), by(theirs)];
  const names = mergeList([...b.keys()], [...m.keys()], [...t.keys()]);
  const out = [];
  for (const name of names) {
    const was = b.get(name);
    const ours = m.get(name);
    const theirsNow = t.get(name);
    const mineChanged = !same(was, ours);
    if (mineChanged && !same(was, theirsNow) && !same(ours, theirsNow)) return null;
    const pick = mineChanged ? ours : theirsNow;
    if (pick) out.push(pick);
  }
  return out;
}

/** The draft's list edits laid onto main's list: its removals taken out, its additions put after what came before them. */
export function mergeList(base = [], mine = [], theirs = []) {
  const removed = new Set(base.filter((x) => !mine.includes(x)));
  const out = theirs.filter((x) => !removed.has(x));
  mine.forEach((x, i) => {
    if (out.includes(x) || base.includes(x)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(mine[j]);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    out.splice(at, 0, x);
  });
  return out;
}

/** What one edit is about, for a clash line a person reads. */
function about(op, labelOf) {
  switch (op.op) {
    case "set":
      return { what: `${labelOf(op.node)} ${op.field}`, node: op.node, field: op.field };
    case "add":
    case "remove":
      return { what: `step ${labelOf(op.node?.id ?? op.node)}` };
    case "wire":
    case "unwire":
      return { what: `wire ${op.from} → ${op.to}${op.mode ? " (" + op.mode + ")" : ""}` };
    case "group":
      return { what: `group ${op.id}` };
    default:
      return { what: op.op };
  }
}

/**
 * Merge a draft onto main. `configFrom(graph, current, words, shelf)` is the promote script's own reading of a graph
 * (passed in, so the two files don't import each other). Answers `{ config, words, unshelved, kept, theirs, clashes }`
 * or `{ refused }`; `clashes` non-empty means nothing should be written.
 */
export function mergeOntoMain({ graph, base, main, shelf = [], configFrom, picks = {} }) {
  // The draft as a config over its own base: the same checks Promote always made, against the main it started from.
  const drafted = configFrom(graph, base.config, base.words, shelf);
  if (drafted.refused) return drafted;
  const labels = new Map([...base.config.nodes, ...main.config.nodes].map((n) => [n.id, n.label || n.id]));
  const labelOf = (id) => labels.get(id) ?? id;

  const mine = diffGraphs(core(base.config), core(drafted.config));
  const theirs = diffGraphs(core(base.config), core(main.config));
  const theirKeys = theirs.flatMap(keysOf);
  const mainNode = (id) => main.config.nodes.find((n) => n.id === id);
  const draftNode = (id) => drafted.config.nodes.find((n) => n.id === id);
  const baseNode = (id) => base.config.nodes.find((n) => n.id === id);

  const kept = [];
  const clashes = [];
  let merged = core(main.config);
  for (const op of mine) {
    if (op.op === "put") {
      clashes.push({ what: "the whole graph", main: "changed", draft: "changed in a way that has no smaller edit" });
      continue;
    }
    let edit = op;
    const touched = conflicts(keysOf(op), theirKeys);
    if (touched.length > 0) {
      // Main already has exactly this edit.
      if (theirs.some((t) => same(t, op))) continue;
      const a = about(op, labelOf);
      if (op.op === "move") continue; // a position both moved keeps main's
      if (op.op === "set" && LIST_FIELDS.has(op.field) && theirs.some((t) => t.op === "set" && t.node === op.node && t.field === op.field)) {
        const value = mergeList(baseNode(op.node)?.[op.field] ?? [], draftNode(op.node)?.[op.field] ?? [], mainNode(op.node)?.[op.field] ?? []);
        edit = { ...op, value };
      } else if (op.op === "set" && IO_FIELDS.has(op.field) && theirs.some((t) => t.op === "set" && t.node === op.node && t.field === op.field) && mergeIo(baseNode(op.node)?.[op.field] ?? [], draftNode(op.node)?.[op.field] ?? [], mainNode(op.node)?.[op.field] ?? [])) {
        edit = { ...op, value: mergeIo(baseNode(op.node)?.[op.field] ?? [], draftNode(op.node)?.[op.field] ?? [], mainNode(op.node)?.[op.field] ?? []) };
      } else if (picks[a.what] === "main") {
        continue;
      } else if (picks[a.what] !== "draft") {
        const was = op.op === "set" ? baseNode(op.node)?.[op.field] : undefined;
        const now = op.op === "set" ? mainNode(op.node)?.[op.field] : undefined;
        const drafted_ = op.op === "set" ? draftNode(op.node)?.[op.field] : undefined;
        const side = (v) => (Array.isArray(v) && Array.isArray(was) ? listSide(was, v) : short(v));
        clashes.push({ what: a.what, main: op.op === "set" ? (mainNode(op.node) ? side(now) : "step removed") : "changed it", draft: op.op === "set" ? side(drafted_) : "changed it", pick: true });
        continue;
      }
    }
    try {
      const done = applyOps(merged, [edit]);
      merged = done.graph;
      kept.push(...done.said);
    } catch (error) {
      clashes.push({ what: about(op, labelOf).what, main: "changed so this edit no longer applies", draft: String(error?.message ?? error).replace(/^edit 1 \([^)]*\): /, ""), pick: false });
    }
  }

  // Prompt words: the draft's changed modules, unless main changed the same module's words too.
  const words = {};
  for (const [name, text] of Object.entries(drafted.words)) {
    const was = base.words[name];
    const now = main.words[name];
    if (now === text) continue;
    if (now !== was) {
      const what = `the words of prompt module ${name}`;
      if (picks[what] === "main") continue;
      if (picks[what] !== "draft") {
        clashes.push({ what, main: "changed them", draft: "changed them", pick: true });
        continue;
      }
    }
    words[name] = text;
  }

  if (clashes.length > 0) return { clashes, kept, theirs: theirs.length };
  const modules = Object.fromEntries(Object.entries({ ...main.words, ...words }).map(([k, t]) => [`p-${k}`, { text: t }]));
  const made = configFrom({ ...merged, modules }, main.config, main.words, shelf);
  if (made.refused) return made;
  return { config: made.config, words: made.words, unshelved: made.unshelved, kept, theirs: theirs.length, clashes: [] };
}

/** Picks as the Lab and tex_dev send them, checked: `{ "<what>": "main" | "draft" }`, at most 200, else {}. */
export function picksOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [what, side] of Object.entries(value).slice(0, 200)) if (typeof what === "string" && what.length <= 300 && (side === "main" || side === "draft")) out[what] = side;
  return out;
}

/** A clash list as one refusal a person reads in the Lab. */
export function clashText(clashes, baseCommit) {
  const lines = clashes.slice(0, 6).map((c) => `${c.what} (main: ${c.main}; this draft: ${c.draft})`);
  const more = clashes.length > 6 ? `; and ${clashes.length - 6} more` : "";
  return `main changed the same ${clashes.length === 1 ? "thing" : "things"} since this draft was made${baseCommit ? ` (${baseCommit.slice(0, 7)})` : ""}: ${lines.join("; ")}${more}. Pick main's or this draft's for each in the Lab (or tex_dev promote picks) and promote again`;
}

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** `texConfig.json` and the prompt words at a commit. */
export function sideAt(commit, run = git) {
  const config = JSON.parse(run(["show", `${commit}:${CONFIG_PATH}`]));
  const words = {};
  for (const file of run(["ls-tree", "--name-only", `${commit}:${WORDS_PATH}`]).split("\n").filter((f) => f.endsWith(".md"))) {
    const text = run(["show", `${commit}:${WORDS_PATH}/${file}`]).replace(/^\uFEFF/, "").trim();
    if (text) words[file.slice(0, -3)] = text;
  }
  return { config, words };
}

/**
 * The commit on `ref` a draft started from: main as it was when the draft was made, if its config has the draft's
 * stamp; else the newest commit whose config has it (the Lab can run a minute behind a merge). A draft saved before
 * drafts kept a stamp is taken to start from main as it was when it was made, and says so (`guessed`). Answers
 * `{ commit, guessed }`, or null when no such commit is within reach.
 */
export function findBase({ stamp, made }, ref = "origin/main", run = git) {
  const atTime = Number.isFinite(made) && made > 0 ? run(["rev-list", "-1", `--before=${Math.floor(made / 1000)}`, ref]).trim() : "";
  if (!isStamp(stamp)) return atTime ? { commit: atTime, guessed: true } : null;
  const stampAt = (c) => {
    try {
      return configStamp(JSON.parse(run(["show", `${c}:${CONFIG_PATH}`])));
    } catch {
      return null;
    }
  };
  if (atTime && stampAt(atTime) === stamp) return { commit: atTime, guessed: false };
  for (const c of run(["log", "--format=%H", "-n", String(LOOK_BACK), ref, "--", CONFIG_PATH]).split("\n").filter(Boolean)) {
    if (stampAt(c) === stamp) return { commit: c, guessed: false };
  }
  return null;
}

async function selfTest() {
  const expect = (cond, what) => {
    if (!cond) throw new Error(`tex-lab-merge self-test: ${what}`);
  };
  const { configFrom } = await import("./tex-lab-promote.mjs");
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { wordsOf } = await import("./tex-prompt-module.mjs");
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const config = JSON.parse(readFileSync(join(ROOT, CONFIG_PATH), "utf8"));
  const words = wordsOf(ROOT);
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const side = (c, w = words) => ({ config: c, words: w });
  const graph = (c) => copy({ nodes: c.nodes, edges: c.edges });
  const node = (c, id) => c.nodes.find((n) => n.id === id);
  const run = (g, base, main, picks) => mergeOntoMain({ graph: g, base, main, configFrom, picks });

  expect(same(mergeList(["a", "b", "c"], ["a", "x", "c"], ["a", "b", "c", "d"]), ["a", "x", "c", "d"]), "a list merge lost a side");
  expect(same(mergeList([], ["x"], ["y"]), ["x", "y"]), "a list merge with nothing before put the addition in the wrong place");
  const f = (name, type = "text") => ({ name, type });
  expect(same(mergeIo([f("a"), f("b")], [f("a"), f("b"), f("d")], [f("a"), f("b"), f("t")]), [f("a"), f("b"), f("d"), f("t")]), "fields both sides added were not both kept");
  expect(same(mergeIo([f("a"), f("b")], [f("a")], [f("a"), f("b"), f("t")]), [f("a"), f("t")]), "a field the draft took out came back");
  expect(mergeIo([f("a")], [f("a", "number")], [f("a", "yesno")]) === null, "one field changed two ways did not clash");

  // The bug this file exists for: main changed one step after the draft was made; the draft changed another.
  const base = copy(config);
  const main = copy(config);
  node(main, "reviewer").effort = "high";
  const draft = graph(base);
  node(draft, "fd").effort = "low";
  const m1 = run(draft, side(base), side(main));
  expect(m1.clashes.length === 0, `two edits to different steps clashed: ${JSON.stringify(m1.clashes)}`);
  expect(node(m1.config, "reviewer").effort === "high", "a stale draft wrote over main's newer change (the overwrite bug)");
  expect(node(m1.config, "fd").effort === "low", "the draft's own change was lost");

  // Different settings of the same step both land.
  const main2 = copy(config);
  node(main2, "fd").rounds = 3;
  const m2 = run(draft, side(base), side(main2));
  expect(m2.clashes.length === 0 && node(m2.config, "fd").rounds === 3 && node(m2.config, "fd").effort === "low", "two settings of one step did not both land");

  // The same setting changed both ways is a clash, named, and nothing is written.
  const main3 = copy(config);
  node(main3, "fd").effort = "high";
  const m3 = run(draft, side(base), side(main3));
  expect(m3.clashes.length === 1 && /Front door effort/.test(m3.clashes[0].what) && m3.clashes[0].main === "high" && m3.clashes[0].draft === "low" && !m3.config, "a clash on one setting was not named");
  expect(/main changed the same thing/.test(clashText(m3.clashes, "abcdef1234")), "the clash refusal does not say what happened");
  // A person's pick settles it: "main" keeps main's value, "draft" writes the draft's over it; the rest still merges.
  expect(m3.clashes[0].pick === true, "a setting both changed was not offered as a pick");
  const pickMain = run(draft, side(base), side(main3), picksOf({ [m3.clashes[0].what]: "main" }));
  expect(pickMain.clashes.length === 0 && node(pickMain.config, "fd").effort === "high", "picking main's did not keep main's value");
  const pickDraft = run(draft, side(base), side(main3), picksOf({ [m3.clashes[0].what]: "draft" }));
  expect(pickDraft.clashes.length === 0 && node(pickDraft.config, "fd").effort === "low", "picking the draft's did not write the draft's value");
  expect(run(draft, side(base), side(main3), picksOf({ "something else": "draft" })).clashes.length === 1, "a pick for another clash settled this one");
  expect(Object.keys(picksOf({ a: "main", b: "mine", c: 1 })).join() === "a" && Object.keys(picksOf(["x"])).length === 0, "picks were not checked");

  // Main made the same change: no clash.
  const main4 = copy(config);
  node(main4, "fd").effort = "low";
  expect(run(draft, side(base), side(main4)).clashes.length === 0, "the same change on both sides clashed");

  // Context lists both sides changed merge as lists.
  const draft5 = graph(base);
  node(draft5, "fd").ctx = [...node(base, "fd").ctx, "p-rules-extra-test"];
  const main5 = copy(config);
  node(main5, "fd").ctx = node(base, "fd").ctx.filter((c) => c !== "date");
  const m5 = run({ ...draft5, modules: { "p-rules-extra-test": { text: "Extra." } } }, side(base), side(main5));
  expect(m5.clashes.length === 0, `context lists clashed: ${JSON.stringify(m5.clashes)}`);
  expect(node(m5.config, "fd").ctx.includes("p-rules-extra-test") && !node(m5.config, "fd").ctx.includes("date"), "a context list merge lost a side");
  expect(m5.words["rules-extra-test"] === "Extra.", "a new module's words were lost in the merge");

  // A wire main added is kept; a wire the draft added lands.
  const main6 = copy(config);
  main6.edges.push({ from: "send", to: "learn", mode: "background", when: ["merge-test"] });
  const draft6 = graph(base);
  draft6.edges.push({ from: "send", to: "afterReply", mode: "background", when: ["merge-test"] });
  const m6 = run(draft6, side(base), side(main6));
  expect(m6.config?.edges.some((e) => e.to === "learn" && e.when[0] === "merge-test") && m6.config?.edges.some((e) => e.to === "afterReply" && e.when[0] === "merge-test"), "a wire from one side was lost");

  // Words: main changed a module the draft did not touch, and the draft changed another: both kept. Both changed one: clash.
  const names = Object.keys(words);
  const mainWords = { ...words, [names[0]]: words[names[0]] + "\n\nMain's line." };
  const m7 = run({ ...graph(base), modules: { [`p-${names[1]}`]: { text: words[names[1]] + "\n\nDraft's line." } } }, side(base), side(config, mainWords));
  expect(m7.clashes.length === 0 && m7.words[names[1]]?.endsWith("Draft's line.") && m7.words[names[0]] === undefined, "words merged wrong");
  const m8 = run({ ...graph(base), modules: { [`p-${names[0]}`]: { text: words[names[0]] + "\n\nDraft's line." } } }, side(base), side(config, mainWords));
  expect(m8.clashes.length === 1 && /words of prompt module/.test(m8.clashes[0].what), "both changing one module's words did not clash");
  const m8d = run({ ...graph(base), modules: { [`p-${names[0]}`]: { text: words[names[0]] + "\n\nDraft's line." } } }, side(base), side(config, mainWords), { [m8.clashes[0].what]: "draft" });
  expect(m8d.clashes.length === 0 && m8d.words[names[0]]?.endsWith("Draft's line."), "picking the draft's words did not write them");
  const m8m = run({ ...graph(base), modules: { [`p-${names[0]}`]: { text: words[names[0]] + "\n\nDraft's line." } } }, side(base), side(config, mainWords), { [m8.clashes[0].what]: "main" });
  expect(m8m.clashes.length === 0 && m8m.words[names[0]] === undefined, "picking main's words still wrote the draft's");

  // A draft with no changes merges to main exactly.
  const m9 = run(graph(base), side(base), side(main));
  expect(same(m9.config.nodes, main.nodes) && same(m9.config.edges, main.edges), "an unchanged draft did not merge to main");

  // Base finding: a stamp found by content, a draft with none taken from its time.
  const commits = { t: "c-time", a: "c-a", b: "c-b" };
  const configs = { "c-time": { v: 2 }, "c-a": { v: 2 }, "c-b": { v: 1 } };
  const fake = (args) => {
    if (args[0] === "rev-list") return commits.t + "\n";
    if (args[0] === "log") return "c-a\nc-b\n";
    if (args[0] === "show") return JSON.stringify(configs[args[1].split(":")[0]]);
    throw new Error("unexpected git " + args.join(" "));
  };
  expect(findBase({ stamp: configStamp({ v: 2 }), made: 1 }, "main", fake)?.commit === "c-time", "the base at the draft's time was not used");
  expect(findBase({ stamp: configStamp({ v: 1 }), made: 1 }, "main", fake)?.commit === "c-b", "a base not at the draft's time was not found by its config");
  expect(findBase({ stamp: configStamp({ v: 9 }), made: 1 }, "main", fake) === null, "a stamp no commit has found a base");
  const guess = findBase({ made: 1 }, "main", fake);
  expect(guess?.commit === "c-time" && guess.guessed, "a draft with no stamp was not based on its time");
  console.log("tex-lab-merge self-test: ok");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Not awaited: the self-test imports the promote script, which imports this file.
  if (process.argv.includes("--self-test"))
    selfTest().catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
  else {
    console.error("usage: node scripts/tex-lab-merge.mjs --self-test (Promote merges through scripts/tex-lab-promote.mjs --base)");
    process.exit(2);
  }
}

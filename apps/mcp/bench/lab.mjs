/**
 * THE TEX ARCHITECTURE LAB, BENCH HALF (Dev2, 2026-11-13).
 *
 *   pnpm ai lab plan  --config <lab config.json>            what a Lab version would run and change
 *   pnpm ai lab apply --config <lab config.json> [--force]  write its setup and modules into the bench copy
 *   pnpm ai lab run   --config <lab config.json> --base <main checkout> --socket <dir> [--held-out <dir>]
 *                     [--scratch <dir>] [--log <file>] [--force]
 *                                                          apply, then run the replay gate on the examiner path
 *   pnpm ai lab notes  --config <lab config.json>          the notes a version's picked texts need fetched (one a line)
 *   pnpm ai lab replay --config <lab config.json> --notes <dir> --socket <dir> --scratch <dir> [--log <file>]
 *                                                          apply, then replay the person's own picked texts read only
 *                                                          (`labReplay.mjs`), Then beside Now
 *
 * The Lab (the Tex Architecture Lab in the app) exports a config: the version's setup, its prompt modules, the steps
 * it changes, and the cases it reruns. This file turns that config into what the examiner can run. Nothing here
 * spends credits: the areas run are answered through the model socket (`SOCKET_AREAS` in `replayGate.mjs`), and
 * an area whose calls don't go through the socket is skipped with its reason, never called for real.
 *
 * A change in a Lab version is one of four kinds, and only two can be applied here:
 *   setup    a field of the bench's copy of the setup (`production.md`), or a prompt module written to its file;
 *   fixture  a test person's note, which lives in the bench fixtures, not in the setup;
 *   code     a change to the branch's code, which must be built by hand (the Lab cannot write code);
 *   unapplied a module from code, a built file or a special one, which must be edited by hand.
 * The plan says which is which, so a person sees what the run did and did not include before it spends anything.
 */
import { execFile, spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { SOCKET_AREAS } from "./replayGate.mjs";
import { readSetups } from "./run.mjs";
import { notesToFetch, readReplays, runReplays } from "./labReplay.mjs";

const execFileAsync = promisify(execFile);

/** Where the bench copy of the texting assistant's setup lives, relative to the bench folder (`bench/ai`). */
export const SETUP_DIR = "setups/texting-assistant";

const LAB_USAGE = "usage: pnpm ai lab plan|apply|run|notes|replay --config <lab config.json> [--force]; run also takes --base <main checkout> --socket <dir> [--held-out <dir>] [--scratch <dir>] [--log <file>]; replay takes --notes <dir> --socket <dir> --scratch <dir> [--log <file>]";

const AREA_NAME = /^[a-z-]+$/;
const MODULE_KEY = /^[\w:-]+$/;
// The only places a module may come from: the production setup's own notes, never a path out of them.
const MODULE_PATH = /^ai\/production\/(?:(?:prompt|skills)\/)?[\w.-]+\.md$/;
const LIST_KEYS = ["steps", "changes", "wires", "areas", "caseEdits"];
const MAP_KEYS = ["setup", "modules", "models", "cases"];

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * FNV-1a, 32 bit, over UTF-16 code units, as lowercase hex padded to eight digits. The Lab fingerprints each module
 * with this, and the bench compares it with the bench copy, so a module changed by hand is caught rather than
 * silently overwritten. The constants are the standard FNV ones; the test pins them to known values.
 */
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The Lab config, checked. Everything the bench reads from it is validated here, because a module path is a file the
 * bench writes: a path that leaves `ai/production/` would let a config overwrite anything the process can reach.
 * Missing lists and maps are defaults, not errors, so an export that leaves a part out still runs.
 */
export function readLabConfig(value) {
  const fail = (why) => {
    throw new Error(`not a Tex Lab config: ${why}`);
  };
  let config = value;
  if (typeof value === "string") {
    try {
      config = JSON.parse(value);
    } catch (error) {
      fail(`not JSON (${error.message})`);
    }
  }
  if (!isObject(config)) fail("not an object");
  if (config.texLab !== 1) fail("texLab must be 1");
  if (!isObject(config.version) || typeof config.version.name !== "string") fail("version.name must be a string");

  const out = { ...config, version: config.version };
  for (const key of LIST_KEYS) {
    if (config[key] === undefined) out[key] = [];
    else if (!Array.isArray(config[key])) fail(`${key} must be a list`);
    else out[key] = config[key];
  }
  for (const key of MAP_KEYS) {
    if (config[key] === undefined) out[key] = {};
    else if (!isObject(config[key])) fail(`${key} must be an object`);
    else out[key] = config[key];
  }
  for (const area of out.areas) {
    if (typeof area !== "string" || !AREA_NAME.test(area)) fail(`area "${area}" is not an area name (lowercase words and dashes)`);
  }
  for (const key of ["steps", "changes", "wires", "caseEdits"]) {
    if (!out[key].every(isObject)) fail(`${key} entries must be objects`);
  }
  for (const [key, module] of Object.entries(out.modules)) {
    if (!MODULE_KEY.test(key)) fail(`module key "${key}" has characters a module key cannot have`);
    if (!isObject(module)) fail(`module ${key} must be an object`);
    if (module.path !== undefined) {
      if (typeof module.path !== "string" || !MODULE_PATH.test(module.path) || module.path.includes("..")) {
        fail(`module ${key} path "${module.path}" is not a production note (ai/production/, prompt/ or skills/)`);
      }
    }
    if (module.text !== undefined && typeof module.text !== "string") fail(`module ${key} text must be a string`);
  }
  return out;
}

/**
 * Where a production note lives in the bench copy of the setup: the setup itself is `production.md`, a prompt module
 * keeps its name under `prompt/`, a skill under `skills/`. Anything else has no file, so the Lab cannot write it.
 */
export function setupFileFor(path) {
  if (typeof path !== "string" || path.includes("..")) return null;
  if (path === "ai/production/texting-assistant.md") return `${SETUP_DIR}/production.md`;
  const match = /^ai\/production\/(prompt|skills)\/([\w.-]+\.md)$/.exec(path);
  return match ? `${SETUP_DIR}/${match[1]}/${match[2]}` : null;
}

/**
 * What a Lab version would do, without doing it. The areas run are the ones the examiner can answer (`examinable`);
 * `pipeline` is the free plumbing suite and runs on its own; every other area is skipped and says why, so a version
 * that asks for `jobs` is visibly not measured here rather than quietly dropped.
 */
export function labPlan(value, { examinable = SOCKET_AREAS } = {}) {
  const config = readLabConfig(value);
  const run = [];
  const skipped = [];
  let pipeline = false;
  for (const area of config.areas) {
    if (area === "pipeline") pipeline = true;
    else if (examinable.has(area)) run.push(area);
    else skipped.push({ area, why: "needs API credits" });
  }

  const moduleEdits = [];
  const storeModules = [];
  const unapplied = [];
  const warnings = [];
  for (const [key, module] of Object.entries(config.modules)) {
    const hasText = typeof module.text === "string";
    // The fingerprint says what the Lab exported; a text that no longer matches it was edited after export.
    if (hasText && module.fingerprint !== undefined && module.fingerprint !== fnv1a(module.text)) {
      warnings.push(`module ${key}: its text changed after export (the fingerprint does not match); applied as it is`);
    }
    const file = module.from === "ailc" ? setupFileFor(module.path) : null;
    if (file && hasText) {
      moduleEdits.push({ key, name: module.name ?? key, file, text: module.text, fingerprint: module.fingerprint, mainFingerprint: module.mainFingerprint ?? null });
    } else if (module.from === "store") {
      storeModules.push({ key, name: module.name ?? key });
    } else if (hasText) {
      // Code, built and special modules are assembled by the app, so the Lab's text is a hand edit on the branch.
      unapplied.push({ key, name: module.name ?? key, from: module.from ?? null });
    } else if (module.from !== "store") {
      warnings.push(`module ${key} has no text, so it is not applied`);
    }
  }

  const fixtureChanges = config.changes.filter((change) => change.how === "fixture");
  const named = new Set(fixtureChanges.map((change) => change.step));
  for (const module of storeModules) {
    // A store module is a test person's note; a change that already names it is not listed twice.
    if (!named.has(`module:${module.key}`)) fixtureChanges.push({ step: `module:${module.key}`, what: "context module changed", how: "fixture", name: module.name });
  }

  for (const change of config.changes) {
    // A model change makes the examiner answer as that model, so the run proves the wiring but not that model's quality.
    if (change.what === "model") warnings.push(`${change.step} (${change.to}): examiner answers as the named model: proves wiring, not quality`);
  }
  if (config.areas.includes("jobs")) warnings.push("jobs is asked: it needs API credits, so it is skipped here (run it with pnpm ai jobs)");

  return {
    version: config.version,
    areas: { run, pipeline, skipped },
    setupFields: setupFieldsOf(config, warnings),
    moduleEdits,
    codeChanges: config.changes.filter((change) => change.how === "code"),
    fixtureChanges,
    unapplied,
    cases: config.cases,
    caseEdits: config.caseEdits,
    warnings,
  };
}

/** The Lab's own name for the decision model a router runs on (`SETUP_FIELDS` "router.on" in the Lab). */
const ROUTER_MODEL = "@cf/cloudflare/clef";
/** The setup key the Lab uses for a reading-order change of the front door's prompt modules. */
const ORDER_KEY = /^ai\/production\/texting-assistant\.md modules:?$/;
const FIELD_KEY = /^[\w-]+(?:\.[\w-]+)?$/;

/**
 * The Lab's `setup` map as front-matter fields. The Lab writes switches as on/off; the setup says a router by its
 * model and a switch that is off by leaving the line out (`production.js`), so `off` becomes a removal (`null`).
 * A reading-order change is the front door's `p-` modules in their new order, written as `modules.texts`.
 * Anything else that isn't a front-matter key is a warning, never a guessed edit.
 */
export function setupFieldsOf(config, warnings = []) {
  const fields = [];
  for (const [key, raw] of Object.entries(config.setup)) {
    const value = raw === null || raw === undefined ? null : String(raw);
    if (ORDER_KEY.test(key)) {
      const front = config.steps.find((step) => step.id === "fd");
      const names = (front?.reads ?? []).filter((id) => typeof id === "string" && id.startsWith("p-")).map((id) => id.slice(2));
      if (names.length && names.every((name) => /^[\w-]+$/.test(name))) fields.push({ key: "modules.texts", value: `[${names.join(", ")}]` });
      else warnings.push("the prompt's new order names no prompt modules on the front door, so it is not applied");
    } else if (!FIELD_KEY.test(key)) {
      warnings.push(`setup "${key}" is not a front-matter field, so it is not applied`);
    } else if (key === "models.router") {
      fields.push({ key, value: value === "on" ? ROUTER_MODEL : value === "off" ? null : value });
    } else {
      fields.push({ key, value: value === "off" && key === "plan_big_asks" ? null : value });
    }
  }
  return fields;
}

/** The plan as short plain lines a person reads before anything runs. */
export function planText(plan) {
  const { version } = plan;
  const lines = [`Lab: ${version.name}${version.id ? ` (${version.id})` : ""}${version.base ? `, base ${version.base}` : ""}`];
  lines.push(`Runs on the examiner path: ${plan.areas.run.join(", ") || "nothing"}`);
  // `run` starts only the gate; the plumbing replays need no model and run with the suite, so the person runs them.
  if (plan.areas.pipeline) lines.push("Pipeline: free, not started by lab run: run `pnpm test` in apps/mcp (test/replay.test.mjs)");
  for (const skip of plan.areas.skipped) lines.push(`Skipped: ${skip.area} (${skip.why})`);
  if (plan.setupFields.length) {
    lines.push("Setup written to the bench copy (production.md):");
    for (const field of plan.setupFields) lines.push(field.value === null ? `  ${field.key} removed` : `  ${field.key} = ${field.value}`);
  }
  if (plan.moduleEdits.length) {
    lines.push("Modules written to the bench copy:");
    for (const edit of plan.moduleEdits) lines.push(`  ${edit.key} -> ${edit.file}`);
  }
  if (plan.codeChanges.length) {
    lines.push("Code to build by hand on the branch (the Lab cannot write code):");
    for (const change of plan.codeChanges) lines.push(`  ${change.step}: ${change.what}${change.to ? ` -> ${change.to}` : ""}`);
  }
  if (plan.fixtureChanges.length) {
    lines.push("Test person's fixtures (not written by the Lab):");
    for (const change of plan.fixtureChanges) lines.push(`  ${change.step}: ${change.what ?? "fixture"}`);
  }
  if (plan.unapplied.length) {
    lines.push("Modules to edit by hand (their text is in the export, not in the setup):");
    for (const module of plan.unapplied) lines.push(`  ${module.key}${module.from ? ` (from ${module.from})` : ""}`);
  }
  const cases = Object.entries(plan.cases).map(([area, ids]) => `${area} ${ids.join(" ")}`);
  // The gate scores a whole area against main, so the picks are for the person reading the report, not a filter.
  if (cases.length) lines.push(`Cases picked (the gate still runs every case in each area): ${cases.join("; ")}`);
  for (const edit of plan.caseEdits) lines.push(`Case edit: ${edit.area} ${edit.id}${edit.isNew ? " (new)" : ""}`);
  if (plan.warnings.length) {
    lines.push("Warnings:");
    for (const warning of plan.warnings) lines.push(`  - ${warning}`);
  }
  return lines.join("\n");
}

const keyLine = (text, name) => new RegExp(`^${name}:(\\s|$)`).test(text);
const SUB_LINE = /^ {2}[\w-]+:(\s|$)/;
const eolOf = (line) => (line.endsWith("\r\n") ? "\r\n" : "\n");
const contentOf = (line) => line.replace(/\r?\n$/, "");

/**
 * One front-matter field of a Markdown note, changed in place: every other byte is kept, including line endings.
 * `key` is `top` or `top.sub` (the bench reads one level of YAML, `frontMatter.mjs`). A missing key is added at the
 * end of the front matter, a missing parent is created with it. The Lab writes only what the export says, so a
 * value that would break the front matter (a newline) or a key deeper than one level is refused.
 */
export function setFrontField(raw, key, value) {
  if (value === null) return removeFrontField(raw, key);
  const text = String(value);
  if (/[\r\n]/.test(text)) throw new Error(`${key}: a front-matter value cannot have a newline`);
  const parts = key.split(".");
  if (parts.length > 2) throw new Error(`${key}: front matter is one level deep, so a key is top or top.sub`);
  if (!/^[\w-]+$/.test(parts[0]) || (parts[1] !== undefined && !/^[\w-]+$/.test(parts[1]))) throw new Error(`${key}: not a front-matter key`);

  const lines = raw.split(/(?<=\n)/);
  if (!/^---\r?\n$/.test(lines[0] ?? "")) throw new Error("the note has no front matter (it must start with ---)");
  const end = lines.findIndex((line, i) => i > 0 && /^---[ \t]*\r?\n?$/.test(line));
  if (end < 0) throw new Error("the note's front matter is not closed with ---");
  const eol = eolOf(lines[0]);
  const front = lines.slice(1, end);
  const [top, sub] = parts;
  const at = front.findIndex((line) => keyLine(contentOf(line), top));

  if (sub === undefined) {
    if (at >= 0 && SUB_LINE.test(contentOf(front[at + 1] ?? ""))) throw new Error(`${key} has sub-keys: set ${key}.<name> instead`);
    if (at >= 0) front[at] = `${top}: ${text}${eolOf(front[at])}`;
    else front.push(`${top}: ${text}${eol}`);
  } else if (at < 0) {
    front.push(`${top}:${eol}`, `  ${sub}: ${text}${eol}`);
  } else {
    if (contentOf(front[at]).slice(top.length + 1).trim() !== "") throw new Error(`${top} has a value, so it cannot take the sub-key ${sub}`);
    let next = at + 1;
    while (next < front.length && SUB_LINE.test(contentOf(front[next]))) next += 1;
    const existing = front.slice(at + 1, next).findIndex((line) => new RegExp(`^ {2}${sub}:(\\s|$)`).test(contentOf(line)));
    if (existing >= 0) front[at + 1 + existing] = `  ${sub}: ${text}${eolOf(front[at + 1 + existing])}`;
    else front.splice(next, 0, `  ${sub}: ${text}${eol}`);
  }
  return lines[0] + front.join("") + lines.slice(end).join("");
}

/** `setFrontField` with nothing to set: the line goes, and a parent left with no sub-keys goes with it. */
function removeFrontField(raw, key) {
  const [top, sub] = key.split(".");
  const lines = raw.split(/(?<=\n)/);
  if (!/^---\r?\n$/.test(lines[0] ?? "")) throw new Error("the note has no front matter (it must start with ---)");
  const end = lines.findIndex((line, i) => i > 0 && /^---[ \t]*\r?\n?$/.test(line));
  if (end < 0) throw new Error("the note's front matter is not closed with ---");
  const front = lines.slice(1, end);
  const at = front.findIndex((line) => keyLine(contentOf(line), top));
  if (at < 0) return raw;
  let next = at + 1;
  while (next < front.length && SUB_LINE.test(contentOf(front[next]))) next += 1;
  if (sub === undefined) front.splice(at, next - at);
  else {
    const subs = front.slice(at + 1, next);
    const kept = subs.filter((line) => !new RegExp(`^ {2}${sub}:(\\s|$)`).test(contentOf(line)));
    if (kept.length === subs.length) return raw;
    front.splice(at, next - at, ...(kept.length ? [front[at], ...kept] : []));
  }
  return lines[0] + front.join("") + lines.slice(end).join("");
}

/** The bench folder a Lab run writes into: the repo's own copy, as `folder.mjs` names it. */
export function benchFolderFor(cwd) {
  const repoCopy = join(cwd, "apps/mcp/bench/ai");
  return existsSync(repoCopy) ? repoCopy : join(cwd, "ai");
}

const defaultRead = (path) => readFile(path, "utf8");
const defaultWrite = (path, text) => writeFile(path, text);

/**
 * Write the plan into the bench copy. Everything is read and checked first, so a module that refuses (its bench copy
 * was changed by hand since main's copy was made) stops the whole apply: nothing is written half-way.
 * A file must resolve inside `benchDir/SETUP_DIR`; a crafted path that leaves it is refused before it is read.
 */
export async function applyLab(plan, { benchDir, force = false, readFile: read = defaultRead, writeFile: write = defaultWrite, validate = null }) {
  const setupRoot = resolve(benchDir, SETUP_DIR);
  const inside = (file) => {
    if (typeof file !== "string" || isAbsolute(file)) return null;
    const target = resolve(benchDir, file);
    const rel = relative(setupRoot, target);
    return rel === "" || rel.split(sep)[0] === ".." || isAbsolute(rel) ? null : target;
  };
  const readCopy = async (target, file) => {
    try {
      return await read(target);
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`${file} is missing from the bench copy: copy the live setup first (docs/testing/examiner.md step 2)`);
      throw error;
    }
  };

  const writes = [];
  const applied = [];
  for (const edit of plan.moduleEdits) {
    const target = inside(edit.file);
    if (!target) throw new Error(`${edit.file} is outside the setup folder (${SETUP_DIR}); refused`);
    const current = await readCopy(target, edit.file);
    if (edit.mainFingerprint && !force && fnv1a(current) !== edit.mainFingerprint) {
      throw new Error(`${edit.file} is not main's copy any more (${fnv1a(current)} vs ${edit.mainFingerprint}): pull the live setup again, or pass --force`);
    }
    // A module keeps the newline it had: a file that ended with one still does, and one that didn't is written as it is.
    const text = current.endsWith("\n") && !edit.text.endsWith("\n") ? `${edit.text}\n` : edit.text;
    writes.push({ path: target, text });
    applied.push({ file: edit.file, did: `module ${edit.key}` });
  }

  if (plan.setupFields.length) {
    const file = `${SETUP_DIR}/production.md`;
    const target = inside(file);
    let text = await readCopy(target, file);
    for (const field of plan.setupFields) {
      text = setFrontField(text, field.key, field.value);
      applied.push({ file, did: field.value === null ? `${field.key} removed` : `${field.key} = ${field.value}` });
    }
    writes.push({ path: target, text });
  }

  for (const { path, text } of writes) await write(path, text);
  // The product refuses a setup it can't read and falls back to its built-in words, so a run of one measures nothing:
  // say so now, while the person can still fix the version (`readSetups` is the check every bench run makes).
  if (writes.length && validate) {
    try {
      await validate(benchDir);
    } catch (error) {
      throw new Error(`the bench copy no longer reads as a setup after this version's changes (${error.message}): fix the version in the Lab`);
    }
  }
  return applied;
}

/** The texting assistant's bench copy, read the way every run reads it; throws when the product would refuse it. */
const validateCopy = (benchDir) => readSetups(benchDir, "texting-assistant", ["production"]);

/** The HEAD commit of a checkout, so a run can tell whether the branch is main. */
async function headOf(dir) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
  return stdout.trim();
}

/**
 * The `lab` command. `spawn` and `cwd` are injectable so a test can run the whole command against a fake gate and a
 * temporary tree; `out` takes the printed text.
 */
export async function labCommand(options, { spawn = nodeSpawn, cwd = process.cwd(), out = (text) => process.stdout.write(text) } = {}) {
  const sub = options.job;
  if (!["plan", "apply", "run", "notes", "replay"].includes(sub) || !options.config) throw new Error(LAB_USAGE);
  const config = readLabConfig(await readFile(options.config, "utf8"));
  const plan = labPlan(config);

  if (sub === "notes") {
    out(`${notesToFetch(readReplays(config).replays).join("\n")}\n`);
    return;
  }
  if (sub === "replay") return await replayCommand(config, plan, options, { cwd, out });

  if (sub === "plan") {
    out(`${planText(plan)}\n`);
    return;
  }
  const benchDir = benchFolderFor(cwd);
  const force = options.force === true;

  if (sub === "apply") {
    const applied = await applyLab(plan, { benchDir, force, validate: validateCopy });
    out(applied.length ? applied.map((entry) => `${entry.file}: ${entry.did}\n`).join("") : "Nothing to apply.\n");
    return;
  }

  // `run`: every refusal is checked before anything is written, so a refused run leaves the bench copy as it was.
  if (!options.base || !options.socket) throw new Error(LAB_USAGE);
  if (plan.areas.run.length === 0) throw new Error(`this Lab version names no area the examiner can run (${config.areas.join(", ") || "none"}): nothing to run`);
  if (plan.codeChanges.length && !force) {
    const [head, mainHead] = await Promise.all([headOf(cwd), headOf(options.base)]);
    // The Lab can't write code, so a branch still at main's commit has not built the change it describes.
    if (head === mainHead) throw new Error(`this Lab version has ${plan.codeChanges.length} code change(s) and this tree is at main's commit (${head.slice(0, 7)}): they were not built. Build them on the branch, or pass --force`);
  }

  const scratch = options.scratch ?? join(cwd, ".replay-gate");
  const log = options.log ?? join(scratch, "lab-steps.jsonl");
  const gateOut = join(scratch, "lab-gate.json");
  await mkdir(scratch, { recursive: true });
  await rm(gateOut, { force: true });
  const applied = await applyLab(plan, { benchDir, force, validate: validateCopy });
  out(applied.length ? applied.map((entry) => `${entry.file}: ${entry.did}\n`).join("") : "Nothing to apply.\n");

  const args = ["apps/mcp/bench/run.mjs", "gate", "--base", options.base, "--areas", plan.areas.run.join(","), ...(options["held-out"] ? ["--held-out", options["held-out"]] : []), "--scratch", scratch, "--out", gateOut];
  // The socket answers the gate's calls; the step log keeps each answer's shape for the Lab; the branch variable says
  // which tree's lines are the Lab's (`stepLog.mjs`), since the gate also runs main's tree.
  // Clef and GLM come to the socket too, and the session runs each for real with Context's `manage` action
  // `run_model` (docs/testing/examiner.md, "A Tex Architecture Lab version"): no key is ever on this machine.
  const env = { ...process.env, BENCH_MODEL_SOCKET: options.socket, BENCH_MODEL_SOCKET_KINDS: process.env.BENCH_MODEL_SOCKET_KINDS || "claude,workers-ai", BENCH_LAB_REAL_MODELS: "1", BENCH_STEP_LOG: log, BENCH_LAB_BRANCH: cwd, BENCH_LAB_MAIN: resolve(options.base) };
  const code = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", resolveRun);
  });

  const result = await readFile(gateOut, "utf8").then(JSON.parse, () => null);
  if (!result) throw new Error(`the gate exited ${code} and wrote no result (${gateOut})`);
  const steps = await readFile(log, "utf8").then((text) => text.split("\n").filter(Boolean).length, () => 0);
  out(`\n## Lab run: ${config.version.name}\n\n${result.report}\n\nStep log: ${log} (${steps} lines)\n`);
  if (code !== 0) process.exitCode = code;
}

/**
 * `lab replay`: the version's setup into the bench copy, then each picked text of the person's own run again in a
 * throwaway world on the model socket (`labReplay.mjs`). Read only: nothing in it can text, write a real note or
 * change a setting.
 */
async function replayCommand(config, plan, options, { cwd, out }) {
  if (!options.notes || !options.socket || !options.scratch) throw new Error(LAB_USAGE);
  if (readReplays(config).replays.length === 0) throw new Error("this Lab version picks no texts to replay");
  const benchDir = benchFolderFor(cwd);
  const applied = await applyLab(plan, { benchDir, force: options.force === true, validate: validateCopy });
  out(applied.length ? applied.map((entry) => `${entry.file}: ${entry.did}\n`).join("") : "Nothing to apply.\n");
  const log = options.log ?? join(options.scratch, "lab-steps.jsonl");
  const env = { ...process.env, BENCH_MODEL_SOCKET: options.socket, BENCH_MODEL_SOCKET_KINDS: process.env.BENCH_MODEL_SOCKET_KINDS || "claude,workers-ai", BENCH_LAB_REAL_MODELS: "1", BENCH_STEP_LOG: log, BENCH_LAB_BRANCH: cwd };
  const { report } = await runReplays({ config, notesDir: resolve(options.notes), scratch: resolve(options.scratch), benchDir, env });
  out(`\n${report}\nStep log: ${log}\n`);
}

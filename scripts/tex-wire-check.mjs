#!/usr/bin/env node
/**
 * NO NODE RUNS OUTSIDE THE GRAPH (Dev2, 2026-11-20: "if we see that there's like a function call outside of the
 * runner, then that should be breaking some type of CI/CD"; the lookup ladder's Hand-off had started jobs with no wire).
 *
 * Nodes are code and wires are config (`packages/tex/src/texConfig.json`): the runner calls a node's function, over a
 * wire, from the one registry (`graph/gatewayNodes.js`). This fails CI when code reaches past it:
 *
 *   1. A node's function (what a registry entry returns) is imported by no other file, unless OUTSIDE_CALLS names the
 *      file, the wire it runs over and the gate that checks that wire. The wire must be in the config, and the gate is
 *      run: it must say yes with the config as it is and no once the wire is taken out.
 *   2. A job is started (`background.call(`) only in a file STARTERS names, with the node it starts for. That node's
 *      wire into the Job start node must be in the config, unless the node is off it (then nothing may start there),
 *      and the code that checks the wire (`text`, in `in`) must still be there.
 *
 * A file put on either list says which wire it rides; neither list is a way round a wire.
 *
 * Usage:
 *   node scripts/tex-wire-check.mjs
 *   node scripts/tex-wire-check.mjs --self-test
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readTexConfig } from "./lib/texConfigFile.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const AGENT = "packages/tex/gateway/agent";
const REGISTRY = `${AGENT}/graph/gatewayNodes.js`;
/** Where a node's function could be imported from: every folder of gateway and Worker code that runs Tex. */
const SCANNED = ["packages/tex", "packages/lab/gateway", "apps/mcp/src", "apps/agent/src"];

/**
 * Files that call a node's function themselves, each over a wire of the config and behind a gate that reads it.
 * `gate` is an export of `gateFrom` that takes a config and says whether the call may run.
 */
export const OUTSIDE_CALLS = {
  // Decide's route asks Clef for its reason again in the gateway's own Decide path, not on a runner turn.
  [`${AGENT}/textsDecide.js`]: { node: "decideWhy", wire: ["decide", "decideWhy"], gateFrom: `${AGENT}/graph/nodes/decideWhy.js`, gate: "decideWhyOn" },
};

/** Files that start a job, the node each starts it for, and the code that checks its wire into Job start. */
export const STARTERS = {
  [`${AGENT}/background.js`]: { node: "fd", in: `${AGENT}/texEntryPoint/runTheModel.js`, text: 'drawn.wired("fd", "jobStart")' },
  [`${AGENT}/handoff.js`]: { node: "handoff", in: `${AGENT}/texEntryPoint/runTheModel.js`, text: 'drawn.wired("handoff", "jobStart")' },
  [`${AGENT}/planBigAsk.js`]: { node: "planner", in: `${AGENT}/texEntryPoint/runTheModel.js`, text: 'e.from === "planner" && e.to === "jobStart"' },
};

const START = /\bbackground\.call\(/;

function filesUnder(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "test" || entry === "__tests__" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (/\.(js|ts|mjs|cjs)$/.test(entry) && !/\.(test|spec|testing)\./.test(entry) && !/\.generated\./.test(entry)) out.push(path);
  }
  return out;
}

/** Each import in a source: the module it names and what it binds (`default`, or the exported names). */
export function importsOf(source) {
  const out = [];
  const re = /import\s+([\w$]+\s*,?\s*)?(\{[^}]*\})?\s*from\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(re)) {
    const names = [];
    if (m[1] && m[1].replace(/[\s,]/g, "")) names.push("default");
    if (m[2]) for (const part of m[2].slice(1, -1).split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
    out.push({ from: m[3], names });
  }
  for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push({ from: m[1], names: ["*"] });
  return out;
}

/** The registry's node functions: for each entry, the module (relative to the registry) and export it returns. */
export function registeredFunctions(registry) {
  const imported = new Map();
  for (const m of registry.matchAll(/import\s+([\w$]+)?\s*,?\s*(\{[^}]*\})?\s*from\s*["']([^"']+)["']/g)) {
    if (m[1]) imported.set(m[1], { from: m[3], name: "default" });
    if (m[2]) for (const part of m[2].slice(1, -1).split(",")) {
      const [name, alias] = part.trim().split(/\s+as\s+/).map((x) => x.trim());
      if (name) imported.set(alias || name, { from: m[3], name });
    }
  }
  const out = [];
  for (const m of registry.matchAll(/\bget\s+([\w$]+)\(\)\s*\{\s*return\s+([\w$]+)\s*;?\s*\}/g)) {
    const at = imported.get(m[2]);
    if (at) out.push({ node: m[1], from: at.from, name: at.name });
  }
  return out;
}

/**
 * Problems with node functions called outside the runner. `files` are `{ path, source }` (paths from the repository
 * root), `fns` what `registeredFunctions` read, `resolveFrom(path, spec)` the repository path an import names.
 */
export function outsideProblems(files, fns, resolveFrom, outside = OUTSIDE_CALLS) {
  const problems = [];
  const fromRegistry = new Map(fns.map((f) => [`${resolveFrom(REGISTRY, f.from)}#${f.name}`, f.node]));
  const seen = new Set();
  for (const { path, source } of files) {
    if (path === REGISTRY) continue;
    for (const { from, names } of importsOf(source)) {
      const target = resolveFrom(path, from);
      for (const [key, node] of fromRegistry) {
        const [file, name] = key.split("#");
        if (file !== target) continue;
        if (path === file) continue;
        if (!(names.includes(name) || names.includes("*"))) continue;
        const listed = outside[path];
        if (listed && listed.node === node) {
          seen.add(path);
          continue;
        }
        problems.push(`${path} calls the ${node} node's function (${name}) outside the runner: run it over a wire (io.use / drawn.fire), or list it in OUTSIDE_CALLS (scripts/tex-wire-check.mjs) with the wire it rides and its gate`);
      }
    }
  }
  for (const path of Object.keys(outside)) if (!seen.has(path)) problems.push(`OUTSIDE_CALLS lists ${path}, which no longer calls ${outside[path].node}'s function: take it off`);
  return problems;
}

/** Problems with a listed outside call's wire and gate, given each gate function. */
export function gateProblems(config, outside, gates) {
  const problems = [];
  for (const [path, entry] of Object.entries(outside)) {
    const [from, to] = entry.wire;
    const has = config.edges.some((e) => e.from === from && e.to === to);
    const gate = gates[path];
    if (typeof gate !== "function") {
      problems.push(`${path}: its gate ${entry.gate} in ${entry.gateFrom} is gone`);
      continue;
    }
    const without = { ...config, edges: config.edges.filter((e) => !(e.from === from && e.to === to)) };
    if (gate(without) !== false) problems.push(`${path} calls ${entry.node} even with no ${from} -> ${to} wire: ${entry.gate} must read the wire`);
    if (has && config.nodes.some((n) => n.id === entry.node && n.on === true) && gate(config) !== true) problems.push(`${path}: ${entry.gate} refuses the config as it is, though ${from} -> ${to} is wired`);
  }
  return problems;
}

/** Problems with job starts: a file that starts one unlisted, a listed one whose node has no wire into Job start, or whose gate is gone. */
export function startProblems(files, config, starters = STARTERS, read = (path) => files.find((f) => f.path === path)?.source ?? null) {
  const problems = [];
  const starting = new Set(files.filter((f) => START.test(f.source)).map((f) => f.path));
  for (const path of starting) if (!starters[path]) problems.push(`${path} starts a job (background.call) and is no node's start: start it over its node's wire into jobStart, or list it in STARTERS (scripts/tex-wire-check.mjs) with that node and its gate`);
  for (const [path, entry] of Object.entries(starters)) {
    if (!starting.has(path)) {
      problems.push(`STARTERS lists ${path}, which no longer starts a job: take it off`);
      continue;
    }
    const inConfig = config.nodes.some((n) => n.id === entry.node);
    const wired = config.edges.some((e) => e.from === entry.node && e.to === "jobStart");
    if (inConfig && !wired) problems.push(`${path} starts jobs for ${entry.node}, which has no ${entry.node} -> jobStart wire in the config`);
    const gateFile = read(entry.in);
    if (gateFile === null || !gateFile.includes(entry.text)) problems.push(`${path} starts jobs for ${entry.node}, but ${entry.in} no longer checks its wire (${entry.text})`);
  }
  return problems;
}

/** The repository path an import names, from the importing file's own path. */
export function resolveFrom(path, spec) {
  if (!spec.startsWith(".")) return spec;
  return relative(ROOT, resolve(ROOT, dirname(path), spec));
}

async function check() {
  const config = readTexConfig(ROOT);
  const files = SCANNED.flatMap((dir) => filesUnder(join(ROOT, dir))).map((file) => ({ path: relative(ROOT, file), source: readFileSync(file, "utf8") }));
  const registry = readFileSync(join(ROOT, REGISTRY), "utf8");
  const fns = registeredFunctions(registry);
  const problems = [];
  if (fns.length < 20) problems.push(`read only ${fns.length} node functions from ${REGISTRY}: the registry's shape changed, so this check reads it no more`);
  problems.push(...outsideProblems(files, fns, resolveFrom));
  const gates = {};
  for (const [path, entry] of Object.entries(OUTSIDE_CALLS)) gates[path] = (await import(pathToFileURL(join(ROOT, entry.gateFrom)).href))[entry.gate];
  problems.push(...gateProblems(config, OUTSIDE_CALLS, gates));
  problems.push(...startProblems(files, config, STARTERS, (path) => {
    try {
      return readFileSync(join(ROOT, path), "utf8");
    } catch {
      return null;
    }
  }));
  return problems;
}

function selfTest() {
  const expect = (cond, what) => {
    if (!cond) throw new Error(`self-test: ${what}`);
  };
  const reg = 'import { fdNode } from "./nodes/fd.js";\nimport dream from "./nodes/dream.js";\nimport { a as b } from "./nodes/a.js";\nexport const N = {\n  get fd() { return fdNode; },\n  get dream() { return dream; },\n  get a() { return b; },\n};';
  const fns = registeredFunctions(reg);
  expect(fns.length === 3 && fns.some((f) => f.node === "dream" && f.name === "default") && fns.some((f) => f.node === "a" && f.name === "a"), `registry misread: ${JSON.stringify(fns)}`);
  const file = (path, source) => ({ path, source });
  const at = `${AGENT}/other.js`;
  expect(outsideProblems([file(at, 'import { fdNode } from "./graph/nodes/fd.js";')], fns, resolveFrom, {}).length === 1, "a node function imported outside the runner passed");
  expect(outsideProblems([file(at, 'import { helper } from "./graph/nodes/fd.js";')], fns, resolveFrom, {}).length === 0, "a node file's helper refused");
  expect(outsideProblems([file(at, 'import d from "./graph/nodes/dream.js";')], fns, resolveFrom, {}).length === 1, "a default-export node function passed");
  expect(outsideProblems([file(at, 'const m = await import("./graph/nodes/fd.js");')], fns, resolveFrom, {}).length === 1, "a dynamic import of a node file passed");
  expect(outsideProblems([file(at, 'import { fdNode } from "./graph/nodes/fd.js";')], fns, resolveFrom, { [at]: { node: "fd" } }).length === 0, "a listed outside call refused");
  expect(outsideProblems([], fns, resolveFrom, { [at]: { node: "fd" } }).length === 1, "a stale outside call stayed listed");
  const config = { nodes: [{ id: "decide", on: true }, { id: "w", on: true }, { id: "fd", on: true }, { id: "jobStart", on: true }], edges: [{ from: "decide", to: "w" }, { from: "fd", to: "jobStart" }] };
  const listed = { [at]: { node: "w", wire: ["decide", "w"], gate: "on", gateFrom: "x" } };
  const reads = (c) => c.nodes.some((n) => n.id === "w" && n.on) && c.edges.some((e) => e.from === "decide" && e.to === "w");
  expect(gateProblems(config, listed, { [at]: reads }).length === 0, "a gate that reads its wire refused");
  expect(gateProblems(config, listed, { [at]: (c) => c.nodes.some((n) => n.id === "w" && n.on) }).length === 1, "a gate that ignores its wire passed");
  expect(gateProblems(config, listed, {}).length === 1, "a missing gate passed");
  const starter = `${AGENT}/s.js`;
  const gateAt = `${AGENT}/g.js`;
  const starts = [file(starter, "await background.call({})"), file(gateAt, 'drawn.wired("fd", "jobStart")')];
  const listedStart = { [starter]: { node: "fd", in: gateAt, text: 'drawn.wired("fd", "jobStart")' } };
  expect(startProblems(starts, config, listedStart).length === 0, "a gated, wired start refused");
  expect(startProblems(starts, config, {}).length === 1, "an unlisted job start passed");
  expect(startProblems(starts, { ...config, edges: [] }, listedStart).length === 1, "a start with no wire into jobStart passed");
  expect(startProblems([starts[0], file(gateAt, "true")], config, listedStart).length === 1, "a start whose gate is gone passed");
  expect(startProblems([file(gateAt, "")], config, listedStart).length === 1, "a stale starter stayed listed");
  console.log("tex-wire-check self-test: ok");
}

const args = process.argv.slice(2);
const direct = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (!direct) {
  // imported for its lists and readers
} else if (args.includes("--self-test")) selfTest();
else {
  const problems = await check();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`tex-wire-check: ${problem}`);
    process.exit(1);
  }
  console.log("tex-wire-check: every node function runs from the runner or over a listed wire, and every job start over its node's wire into jobStart");
}

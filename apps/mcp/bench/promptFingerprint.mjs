/**
 * PROMPT FINGERPRINTS: WHICH MODEL AREAS A CHANGE'S PROMPTS REACH (Dev2, 2026-11-13: "reordering or changing the
 * prompts ... even if it's a letter different, we need to check that"; chose "Prompt fingerprints" for the gate).
 *
 * `replayAreas.mjs` names an area's files, and a file it does not name (the drawing's map, the capability list, a
 * tool's description) still reaches every prompt. So each area also runs here, in a tree, with the model socket in
 * fingerprint mode (`modelSocket.mjs` FINGERPRINT_ENV): every prompt its cases build is hashed, a Claude call gets
 * stand-in words back, nothing is spent and no key is read. An area's fingerprint is the hash of its prompts' hashes.
 * Run on main and on the change, an area whose fingerprint differs by one byte of one prompt is reached, and its
 * replay is required (`scripts/tex-replay-required.mjs`, `tex-replay.yml`).
 *
 * The core and jobs areas read the live setup from `@context-lc ai/production/`, which no tree holds: both trees run
 * on one stand-in setup in its shape (`fingerprint/setups/`, this tree's copy). It names no models and no modules, as
 * production's note names none, so each tree builds its prompts from its own config and prompt words
 * (`packages/shared/src/texPrompt/`, Dev2, 2026-11-14): one word changed there is a fingerprint changed.
 *
 *   pnpm ai gate fingerprint --base-tree <main checkout> [--areas a,b] [--json <file>]
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AREAS } from "./replayAreas.mjs";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
/** The stand-in setup both trees run the core and jobs areas on. */
export const STAND_IN_SETUPS = join(HERE, "fingerprint", "setups");
/** What a fingerprint run's bench folder takes from the tree it runs in (a run reads the README too). */
const BENCH_PARTS = ["README.md", "tests", "workspaces", "sites", "pictures"];
/** One area's run can take no longer than this. */
const AREA_TIMEOUT_MS = 10 * 60 * 1000;

/** The bench commands each area's prompts are built by: `run.mjs` arguments, `{dir}` the stand-in bench folder. */
export const FINGERPRINT_RUNS = {
  respond: [["respond"]],
  review: [["review"]],
  core: ["core", "simple-asks"].map((test) => ["run", "texting-assistant", "--dir", "{dir}", "--test", test, "--setups", "production", "--runs", "1", "--out", "{out}"]),
  "advisor-chat": [["advisor-chat"]],
  "advisor-job-check": [["advisor-job-check"]],
  "advisor-planner": [["advisor-planner"]],
  "advisor-job-mail": [["advisor-job-mail"]],
  jobs: [["jobs", "--dir", "{dir}"]],
};

/** An area's fingerprint from its prompts' hashes, in any order and any number of times each. */
export function fingerprintOf(hashes) {
  const unique = [...new Set(hashes)].sort();
  return { hash: createHash("sha256").update(unique.join("\n")).digest("hex").slice(0, 16), prompts: unique.length };
}

/** The hashes a fingerprint file holds, one JSON line a call. */
export function readCalls(text) {
  return String(text)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).hash);
}

/** Whether a tree can fingerprint at all: main before this module was merged cannot, and then nothing is compared. */
export const canFingerprint = (tree) => existsSync(join(tree, "apps/mcp/bench/promptFingerprint.mjs"));

/**
 * Nothing a fingerprint run sees may reach a model or a key: the environment is the process's bare minimum and the
 * fingerprint file. A key left in it would not be read (every call is hashed first), but none is there to be read.
 */
export function fingerprintEnv(file, env = process.env) {
  const keep = ["PATH", "HOME", "TMPDIR", "LANG", "TZ", "NODE_OPTIONS"];
  return { ...Object.fromEntries(keep.filter((key) => env[key] !== undefined).map((key) => [key, env[key]])), BENCH_MODEL_FINGERPRINT: file };
}

/** A bench folder for `tree`: its own tests, workspaces, sites and pictures, and the stand-in setups. */
async function benchFolderFor(tree, scratch) {
  const dir = await mkdtemp(join(scratch, "bench-"));
  for (const part of BENCH_PARTS) {
    const from = join(tree, "apps/mcp/bench/ai", part);
    if (existsSync(from)) await symlink(from, join(dir, part));
  }
  await symlink(STAND_IN_SETUPS, join(dir, "setups"));
  return dir;
}

/**
 * Each area's fingerprint in `tree`: `{ [area]: { hash, prompts } }`, or `{ error }` for an area whose runs built no
 * prompt at all (it then differs from any tree where they did, so its replay is required: a broken area is never
 * read as unchanged).
 */
export async function treeFingerprints(tree, { areas = Object.keys(AREAS), scratch, runner = run } = {}) {
  await mkdir(scratch, { recursive: true });
  const dir = await benchFolderFor(tree, scratch);
  const out = {};
  try {
    for (const area of areas) {
      const commands = FINGERPRINT_RUNS[area];
      if (!commands) {
        out[area] = { error: "no fingerprint run for this area" };
        continue;
      }
      const file = join(scratch, `fingerprint-${area}-${createHash("sha256").update(tree).digest("hex").slice(0, 8)}.jsonl`);
      await writeFile(file, "");
      const failures = [];
      for (const [i, command] of commands.entries()) {
        const args = command.map((arg) => arg.replace("{dir}", dir).replace("{out}", join(scratch, `${area}-${i}.md`)));
        if (!args.includes("--json") && !args.includes("--out")) args.push("--json", join(scratch, `${area}-${i}-rows.json`));
        // A bench that fails part way still hashed what it built: its exit is noted, never trusted.
        await runner(process.execPath, [join(tree, "apps/mcp/bench/run.mjs"), ...args], { cwd: tree, env: fingerprintEnv(file), maxBuffer: 64 * 1024 * 1024, timeout: AREA_TIMEOUT_MS }).catch((error) => failures.push(String(error?.message ?? error).split("\n")[0].slice(0, 200)));
      }
      const hashes = readCalls(await readFile(file, "utf8"));
      out[area] = hashes.length ? { ...fingerprintOf(hashes), ...(failures.length ? { failures } : {}) } : { error: failures[0] ?? "built no prompt" };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return out;
}

/** The areas whose fingerprints differ between main's and the change's, in `AREAS` order. */
export function changedAreas(base, head) {
  return Object.keys(AREAS).filter((area) => area in head && (!(area in base) || base[area].hash === undefined || head[area].hash === undefined || base[area].hash !== head[area].hash));
}

/**
 * Both trees' fingerprints and the areas they differ in. `null` when main cannot fingerprint yet (the change that
 * brings this in): then the file rules alone decide.
 */
export async function fingerprintChanges({ head, base, areas = Object.keys(AREAS), scratch = null }) {
  if (!canFingerprint(base)) return null;
  const dir = scratch ?? (await mkdtemp(join(tmpdir(), "prompt-fingerprints-")));
  const onHead = await treeFingerprints(head, { areas, scratch: join(dir, "head") });
  const onBase = await treeFingerprints(base, { areas, scratch: join(dir, "base") });
  return { head: onHead, base: onBase, changed: changedAreas(onBase, onHead) };
}

/** One line an area, for a run's summary: same or changed, and how many prompts it built. */
export function fingerprintLines(result) {
  if (result === null) return ["Prompt fingerprints: main can't build them yet, so only the file rules decided."];
  return Object.keys(result.head).map((area) => {
    const h = result.head[area];
    const b = result.base[area] ?? {};
    const same = !result.changed.includes(area);
    const size = h.prompts === undefined ? h.error : `${h.prompts} prompts`;
    return `- ${area}: ${same ? "same prompts as main" : "prompts differ from main"} (${size}${b.prompts !== undefined && b.prompts !== h.prompts ? `, main ${b.prompts}` : ""})`;
  });
}

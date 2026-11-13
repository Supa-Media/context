/**
 * THE LAB'S REPLAYS: A PERSON'S OWN OLD TEXTS, RUN AGAIN READ-ONLY (Dev2, 2026-11-13: "give me the ability to change
 * the user to my user, and essentially replay old messages ... it also should probably be read only").
 *
 *   pnpm ai lab replay --config <lab config.json> --notes <dir> --scratch <dir> [--dir <bench folder>]
 *
 * The Lab (tex.lc/lab, signed in) reads the person's own chat ledger, and a version's config carries the texts they
 * picked under `replays`: each text as it was sent, the chat just before it, what Tex answered then and which Tex
 * that was (the reply's `version`, `src/agent/texVersion.js`), and the notes that turn read. The session running the
 * version fetches those notes through its own Context connection, read only, into `--notes`. This builds a throwaway
 * bench folder in `--scratch` where the person is the only one there, their personal workspace holds just those notes,
 * and each picked text is one case; then it runs each through the real answer maker (`pnpm ai run`), on the model
 * socket like every Lab run, and prints Then beside Now.
 *
 * Read only by construction. Nothing here can text anybody, write a real note or change a real setting: the world is
 * the bench's (`world.mjs`: in-memory buckets, a stub control plane, no Sendblue, no mail), every write lands in it
 * and is thrown away with the scratch folder. The person's words and notes never enter the repository: `--notes` and
 * `--scratch` must both be outside it, and this refuses otherwise, because the repository is public.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseResult } from "./resultNote.mjs";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
/** The repository's root: nothing a replay reads or writes may sit under it. */
export const REPO_ROOT = resolve(HERE, "..", "..", "..");

/** The most texts one run replays, and how much of each part is kept. */
export const MAX_REPLAYS = 20;
const MAX_TEXT = 3_000;
const MAX_EARLIER = 20;
const MAX_THEN = 4_000;
const MAX_READS = 60;
/** The most bytes of notes one replay's workspace takes. */
export const MAX_NOTES_BYTES = 8 * 1024 * 1024;

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const HANDLE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const NAME = /^[\p{L}\p{N} .'-]{1,40}$/u;
const VERSION_PART = /^[0-9a-f-]{6,64}$/i;
// A note path as Context names one: no leading slash, no `..`, no dot folder, Markdown only.
const NOTE_PATH = /^(?!\/)(?!.*(?:^|\/)\.)(?!.*\/\/)[\w ().,'&+-]+(?:\/[\w ().,'&+-]+)*\.md$/u;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const cut = (value, max) => String(value ?? "").slice(0, max);

/** Whether `path` is inside `root` (or is it). */
export function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== ".." && !/^[A-Za-z]:/.test(rel));
}

/** A version stamp as the Lab passes it, kept only when every part has its shape. */
function readVersion(value) {
  if (!isObject(value)) return null;
  const out = {};
  for (const key of ["code", "deploy", "setup"]) if (typeof value[key] === "string" && VERSION_PART.test(value[key])) out[key] = value[key].toLowerCase();
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * A config's replays and who they run as, checked; `{as: null, replays: []}` when it has none. Every field the bench
 * writes into a test or a folder name is shape-checked here, so a crafted config can't name a path outside the
 * scratch folder or break a case line.
 */
export function readReplays(config) {
  const list = config?.replays;
  if (list === undefined || list === null) return { as: null, replays: [] };
  const fail = (why) => {
    throw new Error(`not a Lab replay: ${why}`);
  };
  if (!Array.isArray(list)) fail("replays must be a list");
  if (list.length > MAX_REPLAYS) fail(`at most ${MAX_REPLAYS} texts a run, got ${list.length}`);
  const as = config.replayAs;
  if (!isObject(as) || typeof as.handle !== "string" || !HANDLE.test(as.handle)) fail("replayAs.handle must be a handle");
  if (typeof as.name !== "string" || !NAME.test(as.name.trim())) fail("replayAs.name must be a plain name");
  const seen = new Set();
  const replays = list.map((item, i) => {
    if (!isObject(item)) fail(`replay ${i + 1} is not an object`);
    if (typeof item.id !== "string" || !ID.test(item.id)) fail(`replay ${i + 1} has no id`);
    if (seen.has(item.id)) fail(`replay ${item.id} is picked twice`);
    seen.add(item.id);
    if (typeof item.text !== "string" || item.text.trim() === "") fail(`replay ${item.id} has no text`);
    if (!Number.isFinite(item.at) || item.at <= 0) fail(`replay ${item.id} has no time`);
    const earlier = (Array.isArray(item.earlier) ? item.earlier : []).slice(-MAX_EARLIER).map((line) => {
      if (!isObject(line) || (line.from !== "person" && line.from !== "tex") || typeof line.text !== "string") fail(`replay ${item.id} has an earlier line that is not {from, text}`);
      return { from: line.from, text: cut(line.text, MAX_TEXT) };
    });
    const reads = [...new Set((Array.isArray(item.reads) ? item.reads : []).filter((path) => typeof path === "string" && NOTE_PATH.test(path)))].slice(0, MAX_READS);
    const then = isObject(item.then) ? { text: cut(item.then.text, MAX_THEN), version: readVersion(item.then.version) } : { text: "", version: null };
    return { id: item.id, text: cut(item.text, MAX_TEXT), at: Math.round(item.at), earlier, reads, then };
  });
  return { as: { handle: as.handle, name: as.name.trim() }, replays };
}

/** The notes each replay's workspace needs: what its turns read, and the person's `tex/about.md`. */
export function notesToFetch(replays) {
  return [...new Set(["tex/about.md", ...replays.flatMap((replay) => replay.reads)])].sort();
}

/** `YYYY-MM-DD` of a time, in UTC: the day a replay's world reads (`clock.mjs` pins noon of it). */
const dayOf = (at) => new Date(at).toISOString().slice(0, 10);

/** One replay's test file: its day pinned, one case, the person's text and the chat before it. */
export function replayTest(replay, as) {
  const lines = [
    "---",
    "job: texting-assistant",
    `run_as: ${as.name}`,
    `today: ${dayOf(replay.at)}`,
    "runs: 1",
    "---",
    "",
    "# Lab replay",
    "",
    "One of the person's own texts, run again read only in a throwaway world (`apps/mcp/bench/labReplay.mjs`).",
    "",
    `## 1. Replay ${replay.id}`,
    "",
    "- kind: replay",
    `- person texts: ${JSON.stringify(replay.text)}`,
    ...replay.earlier.map((line) => `- earlier ${line.from}: ${JSON.stringify(line.text)}`),
    "",
  ];
  return lines.join("\n");
}

/** Every Markdown file under `dir`, as paths relative to it. */
async function markdownUnder(dir) {
  const out = [];
  const walk = async (at) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  if (existsSync(dir)) await walk(dir);
  return out.sort();
}

/**
 * The throwaway bench folder: the person's workspace from the fetched notes, a `people.md` naming only them, one test
 * per replay, and the bench's own setup copy beside it (what `pnpm ai lab apply` wrote). Returns the tests' names.
 */
export async function buildReplayBench({ config, notesDir, scratch, benchDir }) {
  const { as, replays } = readReplays(config);
  if (replays.length === 0) throw new Error("the config picks no texts to replay (replays)");
  for (const [flag, path] of [["--notes", notesDir], ["--scratch", scratch]]) {
    if (!path) throw new Error(`${flag} is required`);
    if (inside(REPO_ROOT, path)) throw new Error(`${flag} ${path} is inside the repository, which is public: keep a person's notes and words outside it`);
  }
  const setups = join(benchDir, "setups", "texting-assistant", "production.md");
  if (!existsSync(setups)) throw new Error(`no setup copy at ${setups}: copy the live setup first (docs/testing/examiner.md), then pnpm ai lab apply`);
  const root = join(scratch, "replay-bench");
  const workspace = join(root, "workspaces", as.handle);
  await mkdir(workspace, { recursive: true });
  let bytes = 0;
  const copied = [];
  for (const path of await markdownUnder(notesDir)) {
    if (!NOTE_PATH.test(path)) continue;
    const size = (await stat(join(notesDir, path))).size;
    if (bytes + size > MAX_NOTES_BYTES) throw new Error(`the fetched notes pass ${MAX_NOTES_BYTES} bytes; pick fewer texts`);
    bytes += size;
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await cp(join(notesDir, path), join(workspace, path));
    copied.push(path);
  }
  await writeFile(join(root, "workspaces", "people.md"), `# People\n\nThe one person a Lab replay runs as.\n\n| Person | Workspace | Role |\n|---|---|---|\n| ${as.name} | ${as.handle} (personal) | owner |\n`);
  await mkdir(join(root, "tests"), { recursive: true });
  const tests = [];
  for (const [i, replay] of replays.entries()) {
    const name = `lab-replay-${i + 1}`;
    await writeFile(join(root, "tests", `${name}.md`), replayTest(replay, as));
    tests.push({ name, replay });
  }
  await cp(join(benchDir, "setups"), join(root, "setups"), { recursive: true });
  // A run reads the bench folder's README; the repository's own, since it names no person.
  await cp(join(HERE, "ai", "README.md"), join(root, "README.md"));
  return { root, as, tests, notes: copied };
}

const short = (version) => (version ? [version.code ? `code ${version.code.slice(0, 7)}` : null, version.setup ? `setup ${version.setup}` : null].filter(Boolean).join(", ") || "unknown" : "before versions were kept");

/** The block a session pastes back into the Lab: each text, what Tex said then, and what this version says now. */
export function replayReport(versionName, results) {
  const lines = [`## Lab replay: ${versionName}`, ""];
  for (const { replay, now, error } of results) {
    lines.push(`### ${replay.id}`, "", `**Text:** ${JSON.stringify(replay.text)}`, "", `**Then** (${short(replay.then.version)}): ${JSON.stringify(replay.then.text)}`, "", error ? `**Now:** failed (${error})` : `**Now:** ${JSON.stringify(now)}`, "");
  }
  return lines.join("\n");
}

/** Runs every replay through `pnpm ai run` in the throwaway folder, one at a time, and returns the report. */
export async function runReplays({ config, notesDir, scratch, benchDir, env = process.env, fake = false, write = (line) => process.stderr.write(line) }) {
  const built = await buildReplayBench({ config, notesDir, scratch, benchDir });
  write(`Replay folder: ${built.root} (${built.notes.length} note${built.notes.length === 1 ? "" : "s"} as ${built.as.handle})\n`);
  const results = [];
  for (const { name, replay } of built.tests) {
    const out = join(scratch, "replay-results", `${name}.md`);
    await mkdir(dirname(out), { recursive: true });
    try {
      await run(process.execPath, [join(HERE, "run.mjs"), "run", "texting-assistant", "--dir", built.root, "--test", name, "--setups", "production", "--runs", "1", "--out", out, ...(fake ? ["--fake"] : [])], { env, maxBuffer: 64 * 1024 * 1024 });
      const conversation = parseResult(await readFile(out, "utf8")).answers[0]?.conversation ?? [];
      const said = conversation.filter((line) => line.from !== "person").map((line) => line.text);
      results.push({ replay, now: said.join("\n\n") });
    } catch (error) {
      results.push({ replay, now: "", error: (String(error?.stderr ?? "").trim().split("\n").filter(Boolean).at(-1) ?? String(error?.message ?? error)).slice(0, 300) });
    }
    write(`${name}: ${results.at(-1).error ? "failed" : "answered"}\n`);
  }
  return { report: replayReport(config?.version?.name ?? "version", results), results, root: built.root };
}

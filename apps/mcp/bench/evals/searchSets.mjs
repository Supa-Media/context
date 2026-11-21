/**
 * THE HARD SEARCH SET, LOADED: the questions in `apps/mcp/bench/search/hard/questions.md` and the notes they are
 * asked over (`apps/mcp/bench/search/hard/workspaces/<workspace>/<path>.md`), in the shape `searchSuite.mjs` runs:
 * `{ today, runAs, notes, cases }`, where a case is `{ id, query, as, in, expect, forbid, kind }` and `notes` is
 * keyed "@workspace/path.md" for `overlay(bench, notes)`.
 *
 * A case's expected note is either one of these overlay notes or a note the base bench already has; a case that
 * names neither throws, so a typo can never be a case that cannot pass.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_BENCH_FOLDER } from "../folder.mjs";
import { parseTest, readBenchFolder } from "../load.mjs";

/** The repository's root, from this file (apps/mcp/bench/evals/ is four levels down). */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The folder the hard set lives in, under the repository root. */
export const HARD_SET_FOLDER = join("apps", "mcp", "bench", "search", "hard");

/** The kinds a question can be (its `- kind:` line). */
export const HARD_KINDS = Object.freeze([
  "quotes-question",
  "cross-workspace",
  "long-note",
  "archive",
  "paraphrase",
  "title-only",
  "person",
  "date",
  "link-only",
  "near-duplicate",
]);

/** "@ws/path" → ["ws", "path"], or null. */
function splitAddress(address) {
  const m = /^@([a-z0-9][a-z0-9-]*)\/(.+\.md)$/.exec(String(address ?? ""));
  return m ? [m[1], m[2]] : null;
}

/** Every .md file under `dir`, as forward-slash paths relative to it. */
async function markdownUnder(dir, rel = "") {
  const out = [];
  for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await markdownUnder(dir, path)));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(path);
  }
  return out.sort();
}

/** The overlay notes: "@ws/path.md" → text, read from the workspaces folder of the hard set. */
async function readOverlay(setFolder) {
  const wsRoot = join(setFolder, "workspaces");
  const notes = {};
  for (const ws of (await readdir(wsRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    for (const rel of await markdownUnder(join(wsRoot, ws))) {
      notes[`@${ws}/${rel.split(sep).join("/")}`] = await readFile(join(wsRoot, ws, rel), "utf8");
    }
  }
  return notes;
}

/**
 * The expected addresses that are in neither the overlay notes nor the base bench. A base note is a file of the
 * bench's own workspace (as `readBenchFolder` returns it); fluff-generated notes are not counted.
 */
export function missingExpected(bench, notes = {}, cases = []) {
  const missing = [];
  for (const c of cases) {
    for (const address of c.expect ?? []) {
      if (Object.hasOwn(notes, address)) continue;
      const parts = splitAddress(address);
      if (parts && bench.workspaces[parts[0]]?.files?.[parts[1]] !== undefined) continue;
      missing.push({ id: c.id, address });
    }
  }
  return missing;
}

/**
 * The hard set: `{ today, runAs, notes, cases }`. Throws when a question has no known kind, or an expected note is
 * in neither the overlay nor the base bench.
 */
export async function loadHardSet(root = REPO_ROOT) {
  const setFolder = join(root, HARD_SET_FOLDER);
  const raw = await readFile(join(setFolder, "questions.md"), "utf8");
  const test = parseTest(raw);
  const notes = await readOverlay(setFolder);
  const cases = test.questions.map((q) => {
    if (!HARD_KINDS.includes(q.kind)) throw new Error(`questions.md question ${q.n}: kind "${q.kind}" is not one of ${HARD_KINDS.join(", ")}`);
    return {
      id: `hard-${q.n}`,
      query: q.text,
      as: q.as ?? test.front.run_as,
      in: q.in ?? null,
      expect: q.expect,
      forbid: q.forbid,
      kind: q.kind,
    };
  });
  const base = await readBenchFolder(REPO_BENCH_FOLDER);
  const missing = missingExpected(base, notes, cases);
  if (missing.length > 0) {
    throw new Error(`expected notes that exist nowhere: ${missing.map((m) => `${m.id} ${m.address}`).join(", ")}`);
  }
  return { today: test.front.today ?? null, runAs: test.front.run_as, notes, cases };
}

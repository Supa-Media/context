/**
 * THE HARD SEARCH SET: the questions in `questions.md` and the notes they are asked over
 * (`workspaces/<workspace>/<path>.md`), laid over the bench's own seven workspaces (the runner's base world, Priya's).
 * A case is `{ id, query, as, in, expect, forbid, kind }`; `notes` is keyed "@workspace/path.md".
 *
 * `questions.md` is written in the bench's test format (front matter, then one `## n. question` with `- expect:`,
 * `- kind:` lines each), which the runner's `parseTest` reads; the runner hands it in, so this folder holds data and
 * no copy of the parser. An expected note that is in neither these notes nor the base world fails the run, there.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));

/** The kinds a question can be (its `- kind:` line). */
export const KINDS = Object.freeze([
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
  "opened",
]);

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

/** The overlay notes: "@ws/path.md" → text, read from `workspaces/`. */
export async function readNotes(folder = HERE) {
  const wsRoot = join(folder, "workspaces");
  const notes = {};
  for (const ws of (await readdir(wsRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    for (const rel of await markdownUnder(join(wsRoot, ws))) {
      notes[`@${ws}/${rel.split(sep).join("/")}`] = await readFile(join(wsRoot, ws, rel), "utf8");
    }
  }
  return notes;
}

/** The hard set: `{ today, runAs, notes, cases }`. Throws when a question has no known kind. */
export async function loadHardSet({ parseTest, folder = HERE }) {
  const test = parseTest(await readFile(join(folder, "questions.md"), "utf8"));
  const cases = test.questions.map((q) => {
    if (!KINDS.includes(q.kind)) throw new Error(`questions.md question ${q.n}: kind "${q.kind}" is not one of ${KINDS.join(", ")}`);
    return { id: `hard-${q.n}`, query: q.text, as: q.as ?? test.front.run_as, in: q.in ?? null, expect: q.expect, forbid: q.forbid, kind: q.kind };
  });
  // The world's open history (`opens.json`): "@ws/path" → { person: count, ai: count } (`search/opens.js`).
  const opens = JSON.parse(await readFile(join(folder, "opens.json"), "utf8").catch(() => "{}"));
  return { today: test.front.today ?? null, runAs: test.front.run_as, notes: await readNotes(folder), opens, cases };
}

/** The run's one world: the hard set over the bench's own workspaces. */
export async function worlds({ helpers }) {
  const hard = await loadHardSet({ parseTest: helpers.parseTest });
  return { total: hard.cases.length, worlds: [{ id: "search-hard", base: "repo", notes: hard.notes, opens: hard.opens, cases: hard.cases, today: hard.today }] };
}

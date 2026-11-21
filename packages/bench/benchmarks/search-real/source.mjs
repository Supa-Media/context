/**
 * THE REAL-QUERY SET: real searches that failed (nothing opened, or searched again), rewritten never verbatim, each
 * case with the notes that make it hard (`notes`, "@ws/path" → text), laid over the bench's own workspaces. Training
 * and Dev are the JSON files here; Test lives only in the eval service, and the search gate hands its copy in as
 * `cases` (a file path), never kept in the repository.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
/** The visible parts; the Test part lives only in the eval service. */
export const PARTS = Object.freeze(["training", "dev"]);
/** Pinned, so a recency prior ranks the same today and next month: the day the real set was written. */
export const TODAY = "2026-11-21";

/**
 * A part as one overlay and its cases. Two cases naming the same address must agree on its text; a case with no
 * query, person or expected note fails.
 */
export function realSetOf(cases) {
  if (!Array.isArray(cases)) throw new Error("a real-query set is a JSON array of cases");
  const notes = {};
  for (const c of cases) {
    for (const key of ["id", "query", "as"]) if (typeof c?.[key] !== "string" || !c[key]) throw new Error(`case ${c?.id ?? "?"}: ${key} is missing`);
    if (!Array.isArray(c.expect) || c.expect.length === 0) throw new Error(`case ${c.id}: expect names no note`);
    for (const [address, text] of Object.entries(c.notes ?? {})) {
      if (Object.hasOwn(notes, address) && notes[address] !== text) throw new Error(`case ${c.id}: ${address} differs from another case's note of that name`);
      notes[address] = text;
    }
  }
  return { notes, cases: cases.map(({ notes: _notes, ...c }) => ({ ...c, in: c.in ?? null, forbid: c.forbid ?? [] })) };
}

/** A visible part, or the file the gate hands in. */
export async function readPart(part, file = null) {
  if (!file && !PARTS.includes(part)) throw new Error(`--part is one of ${PARTS.join(", ")}`);
  return JSON.parse(await readFile(file ?? join(HERE, `${part}.json`), "utf8"));
}

/** The run's one world: a part (Dev by default) over the bench's own workspaces. */
export async function worlds({ part = "dev", cases = null, today = null }) {
  const set = realSetOf(await readPart(part, cases));
  return { total: set.cases.length, worlds: [{ id: "search-real", base: "repo", notes: set.notes, cases: set.cases, today: today ?? TODAY }] };
}

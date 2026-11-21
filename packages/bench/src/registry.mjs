/**
 * The benchmarks, as the runner reads them: the generated list (`benchmarks.generated.json`, built from the folders
 * by `scripts/registry.mjs`) and, for one run, its folder's `bench.json` and `source.mjs`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `{ benchmarks, runs }`: every folder's benchmark, and every run the Lab offers. */
export const LIST = Object.freeze(JSON.parse(readFileSync(join(ROOT, "benchmarks.generated.json"), "utf8")));

/** A run of the list by its id, or null. */
export const runOf = (id) => LIST.runs.find((run) => run.id === id) ?? null;

/**
 * One run, whole: `run` (its `bench.json` entry with the benchmark's own settings beneath it: kind, score, notes,
 * slice, caseIds), `bench` (the folder's `bench.json`) and `source` (its `source.mjs`). Throws on an id no folder has.
 */
export async function benchmarkOf(id) {
  const listed = runOf(id);
  if (!listed) throw new Error(`no benchmark run ${id}: one of ${LIST.runs.map((r) => r.id).join(", ")}`);
  const folder = join(ROOT, "benchmarks", listed.benchmark);
  const bench = JSON.parse(readFileSync(join(folder, "bench.json"), "utf8"));
  const own = bench.runs.find((r) => r.id === id);
  const run = { notes: bench.notes ?? {}, slice: bench.slice ?? "first", caseIds: bench.caseIds ?? "set", format: bench.format, ...own, kind: own.kind ?? bench.kind, score: own.score ?? bench.score ?? null, title: bench.title, benchmark: bench.id };
  const source = await import(pathToFileURL(join(folder, "source.mjs")).href);
  return { run, bench, source };
}

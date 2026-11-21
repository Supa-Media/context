#!/usr/bin/env node
/**
 * THE ONE LIST OF BENCHMARKS, BUILT FROM THE FOLDERS (Dev2, 2026-11-21: "maybe create a new benchmark package or
 * app? and then we can create and define new bench marks in folders").
 *
 * Every folder under `packages/bench/benchmarks/` is one benchmark: a `bench.json` (what it is, where its data comes
 * from and under what license, and the runs the Lab offers) and a `source.mjs` (how its data is read). This script
 * checks every folder and writes `packages/bench/benchmarks.generated.json`, the list everything else reads: the
 * Lab's Evals tab and tex_dev (through `apps/convex/functions/labEvals.ts`), the eval workflow's bench check, and the
 * runner. Adding a benchmark is adding a folder and running this.
 *
 *   node packages/bench/scripts/registry.mjs           write the list
 *   node packages/bench/scripts/registry.mjs --check   fail when a folder is wrong or the list is stale (fast guards)
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FOLDER = join(ROOT, "benchmarks");
export const OUT = join(ROOT, "benchmarks.generated.json");

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const KINDS = ["search", "memory"];
const FORMATS = ["beir", "custom"];
const SCORES = ["beir", "first", "retrieval"];
const SLICES = ["first", "per-set", "spread", "source"];

const text = (x) => typeof x === "string" && x.trim() !== "";

/** What is wrong with one folder's `bench.json` (an empty list when nothing is). */
export function problemsOf(folder, bench) {
  const out = [];
  const say = (line) => out.push(`${folder}: ${line}`);
  if (!bench || typeof bench !== "object") return [`${folder}: bench.json is not an object`];
  if (bench.id !== folder) say(`id is "${bench.id}", not the folder's name`);
  if (!ID.test(folder)) say("the folder's name is not lower-case words joined by hyphens");
  for (const key of ["title", "about"]) if (!text(bench[key])) say(`${key} is missing`);
  if (!KINDS.includes(bench.kind)) say(`kind is one of ${KINDS.join(", ")}`);
  if (!FORMATS.includes(bench.format)) say(`format is one of ${FORMATS.join(", ")}`);
  if (!text(bench.source?.name)) say("source.name is missing: say where the benchmark comes from");
  if (!text(bench.source?.license)) say("source.license is missing: say what lets us run it");
  if (bench.slice !== undefined && !SLICES.includes(bench.slice)) say(`slice is one of ${SLICES.join(", ")}`);
  if (!Array.isArray(bench.runs) || bench.runs.length === 0) return [...out, `${folder}: runs is empty`];
  for (const run of bench.runs) {
    if (!ID.test(String(run?.id ?? ""))) say(`a run's id "${run?.id}" is not lower-case words joined by hyphens`);
    for (const key of ["variant", "about"]) if (!text(run?.[key])) say(`run ${run?.id}: ${key} is missing`);
    if (!Number.isSafeInteger(run?.total) || run.total < 1) say(`run ${run?.id}: total is the number of questions`);
    const kind = run?.kind ?? bench.kind;
    if (!KINDS.includes(kind)) say(`run ${run?.id}: kind is one of ${KINDS.join(", ")}`);
    if (kind === "search" && !SCORES.includes(run?.score ?? bench.score)) say(`run ${run?.id}: a search run's score is one of ${SCORES.join(", ")}`);
    if (run?.sets !== undefined && !(Array.isArray(run.sets) && run.sets.every(text))) say(`run ${run.id}: sets is a list of names`);
  }
  return out;
}

/** The folders' benchmarks and their runs, checked; throws naming every problem. */
export async function build(folder = FOLDER) {
  const names = readdirSync(folder, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const problems = [];
  const benchmarks = [];
  const runs = [];
  for (const name of names) {
    const file = join(folder, name, "bench.json");
    if (!existsSync(file)) {
      problems.push(`${name}: no bench.json`);
      continue;
    }
    let bench;
    try {
      bench = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      problems.push(`${name}: bench.json is not JSON (${error.message})`);
      continue;
    }
    const found = problemsOf(name, bench);
    const source = join(folder, name, "source.mjs");
    if (!existsSync(source)) found.push(`${name}: no source.mjs`);
    else {
      const mod = await import(pathToFileURL(source).href);
      const searchRuns = bench.runs?.filter((r) => (r.kind ?? bench.kind) === "search") ?? [];
      if (searchRuns.length && bench.format === "beir" && typeof mod.load !== "function") found.push(`${name}: a BEIR benchmark's source.mjs exports load()`);
      if (searchRuns.length && bench.format === "custom" && typeof mod.worlds !== "function") found.push(`${name}: a custom search benchmark's source.mjs exports worlds()`);
    }
    problems.push(...found);
    if (found.length) continue;
    benchmarks.push({ id: bench.id, title: bench.title, kind: bench.kind, format: bench.format, about: bench.about, source: bench.source });
    for (const run of bench.runs) {
      const kind = run.kind ?? bench.kind;
      runs.push({
        id: run.id,
        benchmark: bench.id,
        title: bench.title,
        variant: run.variant,
        total: run.total,
        kind,
        search: kind === "search",
        ...(kind === "search" ? { score: run.score ?? bench.score } : {}),
        about: run.about,
        ...(run.sets ? { sets: run.sets } : {}),
      });
    }
  }
  const seen = new Set();
  for (const run of runs) {
    if (seen.has(run.id)) problems.push(`run id ${run.id} is used twice`);
    seen.add(run.id);
  }
  if (problems.length) throw new Error(`benchmark folders:\n  ${problems.join("\n  ")}`);
  return { benchmarks, runs };
}

export const render = (list) => `${JSON.stringify(list, null, 2)}\n`;

async function main(argv) {
  const out = render(await build());
  if (argv.includes("--check")) {
    const now = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (now !== out) {
      console.error("packages/bench/benchmarks.generated.json is stale: run node packages/bench/scripts/registry.mjs");
      process.exit(1);
    }
    console.log("benchmarks: every folder checks, and the list is current");
    return;
  }
  writeFileSync(OUT, out);
  console.log(`wrote ${OUT}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

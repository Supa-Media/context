/**
 * The Tex graph as it was when a text ran (Lab live sandbox, Dev2 2026-11-16: a real text's ▶ plays "on the graph Tex
 * had then"). Every reply logs the commit that ran it (`version.code`, `agent/texVersion.js`); `texConfig.json` AT that
 * commit is the graph, fetched the way the prompt catalogue is (`promptAt.ts`), turned into the graph the Lab draws
 * main with (`mainGraph0`: the config's steps and wires, each group folded into its box), and kept per commit.
 * Where it can't be loaded the version open is drawn and the run says so (`graphNote`), never a guess.
 */
import { migrateGraph, SCHEMA_VERSION } from "@context/tex/src/texConfigSchema.cjs";
import { GROUPS } from "../data/graph";
import type { LabGraph, LabNode } from "../types";
import { foldGroups } from "./groups";
import { REPO } from "./promptAt";

export const CONFIG_PATH = "packages/tex/src/texConfig.json";
const COMMIT = /^[0-9a-f]{7,40}$/;
const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** A graph from one commit's `texConfig.json`, or null when it isn't one (an older shape, an error page). */
export function graphOfConfig(config: unknown): LabGraph | null {
  const c = rec(config);
  // An older commit's config is brought to today's schema by the same migrations a draft runs; a newer one is not read.
  if (!c || !Number.isInteger(c.texConfig) || (c.texConfig as number) > SCHEMA_VERSION || !Array.isArray(c.nodes) || !Array.isArray(c.edges) || !c.nodes.length) return null;
  const m = migrateGraph(c) as Record<string, unknown>;
  const copy = JSON.parse(JSON.stringify({ nodes: m.nodes, edges: m.edges })) as { nodes: LabNode[]; edges: LabGraph["edges"] };
  return foldGroups({ nodes: copy.nodes, edges: copy.edges }, (rec(c.groups) as typeof GROUPS | null) ?? GROUPS);
}

const fetched = new Map<string, Promise<LabGraph | null>>();

/** The graph at `code`, or null when that commit has no readable config. Cached per commit; a failed read is tried again. */
export function graphAt(code: string | null | undefined, get: typeof fetch = (...a) => fetch(...a)): Promise<LabGraph | null> {
  if (!code || !COMMIT.test(code)) return Promise.resolve(null);
  let p = fetched.get(code);
  if (!p) {
    p = get(`https://raw.githubusercontent.com/${REPO}/${code}/${CONFIG_PATH}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(graphOfConfig)
      .catch(() => null);
    fetched.set(code, p);
    p.then((g) => {
      if (!g) fetched.delete(code);
    });
  }
  // Whoever asks gets their own copy: a run's graph is never shared with the cache.
  return p.then((g) => (g ? (JSON.parse(JSON.stringify(g)) as LabGraph) : null));
}

/** What a run says when it falls back to the graph open: which day's graph it could not draw. */
export const graphNoteFor = (at: number, code: string | null | undefined) =>
  `graph of ${new Date(at).toISOString().slice(0, 10)}${code ? " (" + code.slice(0, 7) + ")" : ""} unavailable, showing today's`;

/** For tests: forget what was fetched. */
export const forgetGraphs = () => fetched.clear();

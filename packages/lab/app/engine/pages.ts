/**
 * The Lab's pages (Dev2, 2026-11-20: "the nightly cleanup is a different type of AI job. It's not really texting, so it
 * should probably live in a different graph"). Tex's config is still one graph; each step names the page it lives on
 * (`graph`, `texConfigSchema.cjs` `GRAPHS`), and a step with none is on Texting. The canvas, and `tex_dev snapshot`,
 * draw one page at a time: its steps and the wires among them. Speed and cost, Run and Tests read the whole graph.
 *
 * Pure, so the canvas, the snapshot the gateway draws (`views/canvas/snapshot.ts`) and the tests share one filter.
 */
import { GRAPHS, graphOf } from "@context/tex/src/texConfigSchema.cjs";
import type { LabGraph, LabNode } from "../types";

export type GraphPage = "texting" | "nightly";
/** Every page, in the switcher's order, with the name it shows. */
export const GRAPH_PAGES: ReadonlyArray<readonly [GraphPage, string]> = [
  ["texting", "Texting"],
  ["nightly", "Nightly"],
];
export const DEFAULT_PAGE: GraphPage = "texting";

/** A page name from anywhere (an address, a tool argument): one of the config's pages, or Texting. */
export const pageNamed = (v: unknown): GraphPage => ((GRAPHS as readonly string[]).includes(v as string) ? (v as GraphPage) : DEFAULT_PAGE);

/**
 * The page a drawn step is on: its own `graph`, or, for a folded group's box (which has none), its steps': the box is on
 * every page one of its steps is on. A box with no steps behind it is on Texting.
 */
export function pagesOfStep(n: LabNode, g: LabGraph): Set<GraphPage> {
  if (n.graph !== undefined) return new Set([pageNamed(graphOf(n))]);
  const inside = g.folded?.[n.id]?.nodes;
  if (inside && inside.length > 0) return new Set(inside.map((m) => pageNamed(graphOf(m))));
  return new Set([DEFAULT_PAGE]);
}

/** Whether a drawn step (a step or a group's box) is on `page`. */
export const isOnPage = (n: LabNode, g: LabGraph, page: GraphPage) => pagesOfStep(n, g).has(page);

/**
 * The graph as one page draws it: the steps on that page, the wires whose two ends are both on it, and the folded
 * groups whose box is still drawn. A group box with no step on the page is gone with its steps. Answers `g` itself when
 * nothing is left out, so the canvas keeps its graph object (and its edits land on the Lab's own graph).
 */
export function onPage(g: LabGraph, page: GraphPage): LabGraph {
  const keep = g.nodes.filter((n) => isOnPage(n, g, page));
  if (keep.length === g.nodes.length) return g;
  const ids = new Set(keep.map((n) => n.id));
  const out: LabGraph = { ...g, nodes: keep, edges: g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  if (g.folded) {
    const folded = Object.fromEntries(Object.entries(g.folded).filter(([id]) => ids.has(id)));
    if (Object.keys(folded).length > 0) out.folded = folded;
    else delete out.folded;
  }
  return out;
}

/** How many config steps each page holds (folded groups opened), for the switcher's titles. */
export function stepCountsByPage(g: LabGraph): Record<GraphPage, number> {
  const out: Record<GraphPage, number> = { texting: 0, nightly: 0 };
  const all: LabNode[] = [...g.nodes.filter((n) => !g.folded?.[n.id]), ...Object.values(g.folded ?? {}).flatMap((f) => f.nodes)];
  for (const n of all) out[pageNamed(graphOf(n))]++;
  return out;
}

/** What a step added on `page` carries: `graph` only off the default page, so a Texting step stays as it always was. */
export const pageField = (page: GraphPage): { graph?: GraphPage } => (page === DEFAULT_PAGE ? {} : { graph: page });

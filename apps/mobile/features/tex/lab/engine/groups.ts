/**
 * Folding a step group into one box, and opening it again (Dev2, 2026-11-14: "Focus on it opens all eleven steps").
 *
 * Tex's config puts code steps in a group: each node names its `group`, and the config's top-level `groups` says how the
 * box is drawn. The Lab shows a group folded, as one box whose id is the group's id, so the canvas, the sim and the
 * tests keep seeing the step ids they always did ("door" among them). Focus on the box opens its steps again, and "Whole
 * graph" folds them. A saved version and Promote need the config's own steps, so a save unfolds (`unfoldGroups`).
 *
 * A folded graph keeps each group's steps and the wires that touch them in `folded[id]`: unfolding needs them to put an
 * outside wire back on the step it came from (a wire from the box that came from `checkItMayRun` goes back there, not to
 * the chain's last step). A wire the user draws to or from the box with no such step behind it goes to the chain's first
 * or last step. The functions are pure: the graphs they are given are not changed.
 *
 * Groups nest: a group's `parent` names the group it sits in. A step folds into the outermost group around it that is
 * not open, so on the whole graph a nested group's steps fold into its top group's box, and with that group open its
 * child group is a box of its own inside it (`foldAround`).
 */
import { migrateGraph } from "@context/shared/src/texConfigSchema.cjs";
import type { LabEdge, LabGraph, LabNode } from "../types";

/** `parent`: the group this one sits inside (Dev2, 2026-11-16: "make sure that groups can be nested"). */
export type GroupInfo = { label: string; goal?: string; icon?: string; x?: number; y?: number; parent?: string };
export type GroupDefs = Record<string, GroupInfo>;
/** `at`: where each step stood in the graph's order when folded, so a save puts it back there (the config's own order). */
export type FoldedGroup = { nodes: LabNode[]; edges: LabEdge[]; at?: number[] };

const copy = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const wireKey = (e: LabEdge) => [e.from, e.to, e.mode, e.when.join(",")].join("|");
const sameMode = (a: LabEdge, b: LabEdge) => a.mode === b.mode && a.when.join(",") === b.when.join(",");

/** The box that stands for a folded group: its steps' time and areas added up, drawn as the config describes it. */
function boxFor(id: string, members: LabNode[], info: GroupInfo | undefined): LabNode {
  const areas: string[] = [];
  for (const m of members) for (const a of m.areas) if (!areas.includes(a)) areas.push(a);
  return {
    id,
    label: info?.label ?? id,
    goal: info?.goal ?? "",
    log: false,
    on: true,
    rounds: 1,
    out: 300,
    ctx: [],
    ms: members.reduce((sum, m) => sum + m.ms, 0),
    timeoutS: 0,
    areas,
    file: "",
    note: "",
    icon: info?.icon ?? "code",
    model: "code",
    x: info?.x ?? members[0].x,
    y: info?.y ?? members[0].y,
  };
}

/** The group `id` and every group around it, innermost first; a parent that loops back or is not defined ends it. */
export function groupChain(groups: GroupDefs, id: string): string[] {
  const out: string[] = [];
  for (let at: string | undefined = id; at && !out.includes(at); at = groups[at]?.parent) out.push(at);
  return out;
}

/**
 * The graph with each group's steps folded into one box, placed where its first step was. Wires from or to a step
 * point at the box instead; a wire inside the group is dropped, and duplicate wires collapse into one. A step folds
 * into the outermost group around it that `open` leaves shut, so an open group draws its own steps and its child
 * groups' boxes.
 */
export function foldGroups(graph: LabGraph, groups: GroupDefs = {}, open: ReadonlySet<string> = new Set()): LabGraph {
  const owner = new Map<string, string>();
  for (const n of graph.nodes) {
    if (!n.group) continue;
    const chain = groupChain(groups, n.group);
    for (let i = chain.length - 1; i >= 0; i--)
      if (!open.has(chain[i])) {
        owner.set(n.id, chain[i]);
        break;
      }
  }
  if (owner.size === 0) return graph;

  const folded: Record<string, FoldedGroup> = { ...(graph.folded ?? {}) };
  for (const id of new Set(owner.values())) {
    folded[id] = {
      nodes: graph.nodes.filter((n) => owner.get(n.id) === id).map(copy),
      edges: graph.edges.filter((e) => owner.get(e.from) === id || owner.get(e.to) === id).map(copy),
      at: graph.nodes.flatMap((n, i) => (owner.get(n.id) === id ? [i] : [])),
    };
  }

  const nodes: LabNode[] = [];
  const placed = new Set<string>();
  for (const n of graph.nodes) {
    const id = owner.get(n.id);
    if (id === undefined) nodes.push(n);
    else if (!placed.has(id)) {
      placed.add(id);
      nodes.push(boxFor(id, graph.nodes.filter((m) => owner.get(m.id) === id), groups[id]));
    }
  }

  const seen = new Set<string>();
  const edges: LabEdge[] = [];
  for (const e of graph.edges) {
    const from = owner.get(e.from) ?? e.from;
    const to = owner.get(e.to) ?? e.to;
    if (from === to) continue;
    const w: LabEdge = { ...copy(e), from, to };
    const k = wireKey(w);
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push(w);
  }

  return { ...graph, nodes, edges, folded };
}

/**
 * The graph with the listed folded groups opened (every folded group when `ids` is left out): each box becomes its steps
 * again, and the wires to and from it go back to the steps they came from (see the note at the top). A folded group whose
 * box was deleted is dropped with its steps.
 */
export function unfoldGroups(graph: LabGraph, ids?: string[]): LabGraph {
  const sides = graph.folded ?? {};
  const isBox = (id: string) => graph.nodes.some((n) => n.id === id) && !!sides[id];
  const targets = (ids ?? Object.keys(sides)).filter(isBox);
  const keep: Record<string, FoldedGroup> = {};
  for (const id of Object.keys(sides)) if (isBox(id) && !targets.includes(id)) keep[id] = sides[id];

  const out: LabGraph = { ...graph, nodes: graph.nodes, edges: graph.edges };
  delete out.folded;
  if (Object.keys(keep).length > 0) out.folded = keep;
  if (targets.length === 0) return out;

  const owner = new Map<string, string>();
  for (const id of targets) for (const m of sides[id].nodes) owner.set(m.id, id);
  const entry = (id: string) => sides[id].nodes[0].id;
  const exit = (id: string) => sides[id].nodes[sides[id].nodes.length - 1].id;

  const opened = graph.nodes.flatMap((n) => (targets.includes(n.id) ? sides[n.id].nodes.map(copy) : [n]));
  // Fully open (a save, Promote), the steps go back in the config's order; a focus that opens one group needs no order.
  out.nodes = Object.keys(keep).length === 0 ? inOrder(opened, targets.map((id) => sides[id])) : opened;

  const seen = new Set<string>();
  const edges: LabEdge[] = [];
  const push = (e: LabEdge) => {
    const k = wireKey(e);
    if (!seen.has(k)) {
      seen.add(k);
      edges.push(e);
    }
  };
  const isOpen = new Set<string>();
  // A group's own wires go in once, where its first outside wire is, so the chain stays with the box it belongs to.
  const open = (id: string) => {
    if (isOpen.has(id)) return;
    isOpen.add(id);
    for (const r of sides[id].edges) if (owner.get(r.from) === id && owner.get(r.to) === id) push(copy(r));
  };
  for (const e of graph.edges) {
    for (const id of targets) if (id === e.from || id === e.to) open(id);
    if (targets.includes(e.from) && targets.includes(e.to)) {
      // A wire between two boxes goes back to the steps it joined (job -> tools stays job -> tools), from either side's record.
      const joined = (r: LabEdge) => owner.get(r.from) === e.from && owner.get(r.to) === e.to && sameMode(r, e);
      const back = [...sides[e.from].edges, ...sides[e.to].edges].filter(joined);
      if (back.length > 0) back.forEach((r) => push(copy(r)));
      else push({ ...copy(e), from: exit(e.from), to: entry(e.to) });
      continue;
    }
    if (targets.includes(e.to)) {
      const id = e.to;
      const back = sides[id].edges.filter((r) => owner.get(r.to) === id && owner.get(r.from) !== id && r.from === e.from && sameMode(r, e));
      if (back.length > 0) back.forEach((r) => push(copy(r)));
      else push({ ...copy(e), to: entry(id) });
    } else if (targets.includes(e.from)) {
      const id = e.from;
      const back = sides[id].edges.filter((r) => owner.get(r.from) === id && owner.get(r.to) !== id && r.to === e.to && sameMode(r, e));
      if (back.length > 0) back.forEach((r) => push(copy(r)));
      else push({ ...copy(e), from: exit(id) });
    } else push(copy(e));
  }
  for (const id of targets) open(id);
  out.edges = edges;
  return out;
}

/**
 * The opened steps put back where they stood when folded, so a save keeps the config's order: a step with a recorded
 * place sorts by it, and any other step (one drawn since) keeps its place after the step before it.
 */
function inOrder(nodes: LabNode[], groups: FoldedGroup[]): LabNode[] {
  const place = new Map<string, number>();
  for (const g of groups) g.nodes.forEach((m, i) => g.at?.[i] !== undefined && place.set(m.id, g.at[i]));
  if (place.size === 0) return nodes;
  // Opened steps go back in their recorded slots; every other step fills the free slots in the order it has now.
  const slots: Array<LabNode | undefined> = new Array(nodes.length);
  const rest: LabNode[] = [];
  for (const n of nodes) {
    const at = place.get(n.id);
    if (at !== undefined && at < slots.length && !slots[at]) slots[at] = n;
    else rest.push(n);
  }
  const out: LabNode[] = [];
  let k = 0;
  for (const n of slots) {
    const next = n ?? rest[k++];
    if (next) out.push(next);
  }
  return [...out, ...rest.slice(k)];
}

/** What the canvas draws for step `id`: the step itself, or the folded group's box that holds it. */
export function drawnFor(graph: LabGraph, id: string): LabNode | undefined {
  const own = graph.nodes.find((n) => n.id === id);
  if (own) return own;
  const box = Object.entries(graph.folded ?? {}).find(([, f]) => f.nodes.some((n) => n.id === id))?.[0];
  return box ? graph.nodes.find((n) => n.id === box) : undefined;
}

/** True when `focusId` names a group drawn open (its steps and child boxes on the canvas), not a step or a shut box. */
export function isGroupFocus(graph: LabGraph, focusId: string | null, groups: GroupDefs): boolean {
  if (!focusId || graph.nodes.some((n) => n.id === focusId)) return false;
  return !!groups[focusId] || stepsOfFold(graph).some((n) => n.group === focusId);
}

/** What an open group draws: its own steps and the boxes of the groups inside it; nothing when it is not open. */
export function groupItems(graph: LabGraph, focusId: string | null, groups: GroupDefs): LabNode[] {
  if (!isGroupFocus(graph, focusId, groups)) return [];
  return graph.nodes.filter((n) => (graph.folded?.[n.id] ? groups[n.id]?.parent === focusId : n.group === focusId));
}

/** The steps a focused group draws: its members while it is open, and none while it is folded or the focus is not a group. */
export function stepsShownFor(graph: LabGraph, focusId: string | null): LabNode[] {
  return focusId ? graph.nodes.filter((n) => n.group === focusId && !graph.folded?.[n.id]) : [];
}

/** The group a focus on this step opens: the step's own group, or the box of a folded group; undefined for other steps. */
export function groupToOpen(graph: LabGraph, id: string): string | undefined {
  const n = graph.nodes.find((x) => x.id === id);
  if (n?.group) return n.group;
  return graph.folded?.[id] ? id : undefined;
}

const stepsOfFold = (g: LabGraph): LabNode[] => [...g.nodes, ...Object.values(g.folded ?? {}).flatMap((f) => f.nodes)];

/** The groups a focus opens: a group and every group around it, or the groups around a step; none for the whole graph. */
export function openFor(graph: LabGraph, focusId: string | null, groups: GroupDefs): string[] {
  if (!focusId) return [];
  const step = stepsOfFold(graph).find((n) => n.id === focusId && !graph.folded?.[n.id]);
  if (step) return step.group ? groupChain(groups, step.group) : [];
  return groups[focusId] || stepsOfFold(graph).some((n) => n.group === focusId) ? groupChain(groups, focusId) : [];
}

/**
 * The working graph as the Lab shows it: every group folded, except the ones a focus on `focusId` opens (the group and
 * the groups around it, or the groups around a step). Each Lab action that replaces the graph (focus, Whole graph,
 * undo, opening a version) goes through here, so a graph is never half open. A box keeps the place it was drawn at.
 */
export function foldAround(graph: LabGraph, focusId: string | null, groups: GroupDefs): LabGraph {
  const open = new Set(openFor(graph, focusId, groups));
  const full = graph.folded ? unfoldGroups(graph) : graph;
  const out = foldGroups(full, groups, open);
  // Already folded this way (an undo, a redraw): the graph as it is, so nothing moves and its order stays.
  const drawn = (g: LabGraph) => g.nodes.map((n) => n.id).sort().join("|");
  if (graph.folded && drawn(graph) === drawn(out)) return graph;
  if (!graph.folded || !out.folded) return out;
  const drawnAt = new Map(graph.nodes.filter((n) => graph.folded?.[n.id]).map((n) => [n.id, n] as const));
  out.nodes = out.nodes.map((n) => {
    const was = out.folded?.[n.id] ? drawnAt.get(n.id) : undefined;
    return was ? { ...n, x: was.x, y: was.y } : n;
  });
  return out;
}

/**
 * A version saved under an older shape of the config reads in the current one: the schema's migrations, the same ones
 * Promote runs (`texConfigSchema.cjs`; the first renamed the "behind" wire "background", Dev2, 2026-11-14).
 */
export const withCurrentModes = <G extends { edges?: Array<{ mode: string }> },>(g: G): G => migrateGraph(g);

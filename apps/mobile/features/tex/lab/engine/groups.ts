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
 */
import type { LabEdge, LabGraph, LabNode } from "../types";

export type GroupInfo = { label: string; goal?: string; icon?: string; x?: number; y?: number };
export type GroupDefs = Record<string, GroupInfo>;
export type FoldedGroup = { nodes: LabNode[]; edges: LabEdge[] };

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

/**
 * The graph with each group's steps folded into one box, placed where its first step was. Wires from or to a step
 * point at the box instead; a wire inside the group is dropped, and duplicate wires collapse into one.
 */
export function foldGroups(graph: LabGraph, groups: GroupDefs = {}): LabGraph {
  const owner = new Map<string, string>();
  for (const n of graph.nodes) if (n.group) owner.set(n.id, n.group);
  if (owner.size === 0) return graph;

  const folded: Record<string, FoldedGroup> = { ...(graph.folded ?? {}) };
  for (const id of new Set(owner.values())) {
    folded[id] = {
      nodes: graph.nodes.filter((n) => n.group === id).map(copy),
      edges: graph.edges.filter((e) => owner.get(e.from) === id || owner.get(e.to) === id).map(copy),
    };
  }

  const nodes: LabNode[] = [];
  const placed = new Set<string>();
  for (const n of graph.nodes) {
    const id = owner.get(n.id);
    if (id === undefined) nodes.push(n);
    else if (!placed.has(id)) {
      placed.add(id);
      nodes.push(boxFor(id, graph.nodes.filter((m) => m.group === id), groups[id]));
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

  out.nodes = graph.nodes.flatMap((n) => (targets.includes(n.id) ? sides[n.id].nodes.map(copy) : [n]));

  const seen = new Set<string>();
  const edges: LabEdge[] = [];
  const push = (e: LabEdge) => {
    const k = wireKey(e);
    if (!seen.has(k)) {
      seen.add(k);
      edges.push(e);
    }
  };
  const opened = new Set<string>();
  // A group's own wires go in once, where its first outside wire is, so the chain stays with the box it belongs to.
  const open = (id: string) => {
    if (opened.has(id)) return;
    opened.add(id);
    for (const r of sides[id].edges) if (owner.get(r.from) === id && owner.get(r.to) === id) push(copy(r));
  };
  for (const e of graph.edges) {
    for (const id of targets) if (id === e.from || id === e.to) open(id);
    if (targets.includes(e.from) && targets.includes(e.to)) {
      push({ ...copy(e), from: exit(e.from), to: entry(e.to) });
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

/** The steps a focused group draws: its members while it is open, and none while it is folded or the focus is not a group. */
export function stepsShownFor(graph: LabGraph, focusId: string | null): LabNode[] {
  return focusId ? graph.nodes.filter((n) => n.group === focusId) : [];
}

/** The group a focus on this step opens: the step's own group, or the box of a folded group; undefined for other steps. */
export function groupToOpen(graph: LabGraph, id: string): string | undefined {
  const n = graph.nodes.find((x) => x.id === id);
  if (n?.group) return n.group;
  return graph.folded?.[id] ? id : undefined;
}

/**
 * The working graph as the Lab shows it: every group folded, except the one a focus on `focusId` opens. Each Lab action
 * that replaces the graph (focus, Whole graph, undo, opening a version) goes through here, so a graph is never half open.
 */
export function foldAround(graph: LabGraph, focusId: string | null, groups: GroupDefs): LabGraph {
  const keep = focusId ? groupToOpen(graph, focusId) : undefined;
  const folded = foldGroups(graph, groups);
  return keep && folded.folded?.[keep] ? unfoldGroups(folded, [keep]) : folded;
}

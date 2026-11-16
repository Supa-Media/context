/**
 * Where an open group's steps stand (mockup 5y8sZpxqRYNZEdqqXTjq6J, Dev2 2026-11-16: "when I click focus on a group,
 * I want it to open just that group"). A group open on its own draws only what it holds, so its steps need places that
 * read on their own: left to right along their wires. The places the config gives were made for the whole graph and
 * often pile up, so opening a group lays them out again when two of them overlap or a wire inside runs right to left;
 * a group someone has already arranged, with nothing overlapping and every wire running forward, keeps its places.
 *
 * Layers follow the longest path along the wires inside the group (send-back loops left out); a layer of more than six
 * wraps into columns side by side, so a group with no wires inside becomes a grid. Pure: the graph given is not changed.
 */
import type { LabGraph, LabNode } from "../types";
import { groupItems, type GroupDefs } from "./groups";

/** A step's box and a group's card, as the canvas draws them (`views/canvas/render.ts`, `groupCard.ts`). */
const STEP = { w: 180, h: 64 };
const CARD = { w: 204, h: 92, dx: -12, dy: -14 };
export const COL = 260;
export const ROW = 112;
const PER_COL = 6;

/** The rectangle a thing on the canvas covers: a step's box, or a folded group's card around its place. */
export function boxOf(g: LabGraph, n: LabNode): { x: number; y: number; w: number; h: number } {
  return g.folded?.[n.id] ? { x: n.x + CARD.dx, y: n.y + CARD.dy, w: CARD.w, h: CARD.h } : { x: n.x, y: n.y, w: STEP.w, h: STEP.h };
}

const overlaps = (a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The wires between two things an open group draws, as [from, to] ids (loops left out). */
function innerWires(g: LabGraph, ids: ReadonlySet<string>): Array<[string, string]> {
  return g.edges.filter((e) => e.mode !== "loop" && e.from !== e.to && ids.has(e.from) && ids.has(e.to)).map((e) => [e.from, e.to]);
}

/** True when the open group's things need placing: two of them overlap, or a wire inside runs right to left. */
export function needsLayout(g: LabGraph, items: LabNode[]): boolean {
  const boxes = items.map((n) => boxOf(g, n));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlaps(boxes[i], boxes[j])) return true;
  const at = new Map(items.map((n) => [n.id, n.x] as const));
  return innerWires(g, new Set(at.keys())).some(([a, b]) => (at.get(b) ?? 0) <= (at.get(a) ?? 0));
}

/** Each thing's place, layered along the wires: { id: { x, y } }, the first column at x = 0. */
export function layered(g: LabGraph, items: LabNode[]): Record<string, { x: number; y: number }> {
  const ids = new Set(items.map((n) => n.id));
  const wires = innerWires(g, ids);
  const layer = new Map<string, number>(items.map((n) => [n.id, 0]));
  // Longest path; a cycle stops growing after one pass per step.
  for (let k = 0; k < items.length; k++)
    for (const [a, b] of wires) if (layer.get(b)! < layer.get(a)! + 1) layer.set(b, Math.min(items.length, layer.get(a)! + 1));
  const cols: LabNode[][] = [];
  for (const n of items) (cols[layer.get(n.id)!] ??= []).push(n);
  const flat: LabNode[][] = [];
  for (const col of cols.filter(Boolean)) for (let i = 0; i < col.length; i += PER_COL) flat.push(col.slice(i, i + PER_COL));
  const tall = Math.max(1, ...flat.map((c) => c.length));
  const out: Record<string, { x: number; y: number }> = {};
  flat.forEach((col, ci) =>
    col.forEach((n, ri) => {
      out[n.id] = { x: ci * COL, y: Math.round((ri - (col.length - 1) / 2) * ROW + ((tall - 1) * ROW) / 2) };
    }),
  );
  return out;
}

/**
 * The graph with the open group `id`'s things laid out when they need it (see the note at the top), else the graph
 * itself. Steps and child boxes are copied before they move.
 */
export function laidOut(g: LabGraph, id: string, groups: GroupDefs): LabGraph {
  const items = groupItems(g, id, groups);
  if (items.length < 2 || !needsLayout(g, items)) return g;
  const at = layered(g, items);
  return { ...g, nodes: g.nodes.map((n) => (at[n.id] ? { ...n, x: at[n.id].x, y: at[n.id].y } : n)) };
}

/** A wire that leaves an open group: drawn as a pill at the frame's edge naming the thing outside. */
export type GroupPort = { other: string; item: string; mode: string; when: string[]; edge: number };

/**
 * What an open group draws (`views/canvas/groupView.ts`, and `tex_dev reference` topic groups): its things, the wires
 * between them (by their place in the graph), and the wires in from outside and out to outside, one per thing outside,
 * thing inside, kind and condition.
 */
export function groupParts(g: LabGraph, id: string, groups: GroupDefs): { items: LabNode[]; inner: number[]; ins: GroupPort[]; outs: GroupPort[] } {
  const items = groupItems(g, id, groups);
  const inside = new Set(items.map((n) => n.id));
  const drawn = new Set(g.nodes.map((n) => n.id));
  const inner: number[] = [];
  const ins: GroupPort[] = [];
  const outs: GroupPort[] = [];
  const seen = new Set<string>();
  g.edges.forEach((e, i) => {
    const a = inside.has(e.from),
      b = inside.has(e.to);
    if (a && b) inner.push(i);
    else if (a || b) {
      const other = a ? e.to : e.from;
      if (!drawn.has(other)) return;
      const key = [a ? "out" : "in", other, a ? e.from : e.to, e.mode, e.when.join(",")].join("|");
      if (seen.has(key)) return;
      seen.add(key);
      (a ? outs : ins).push({ other, item: a ? e.from : e.to, mode: e.mode, when: e.when, edge: i });
    }
  });
  return { items, inner, ins, outs };
}

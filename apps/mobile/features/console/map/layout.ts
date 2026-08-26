import type { GraphKind } from "../../design/tokens";
import type { Point } from "../../design/geometry";

/**
 * Layout maths for the constellation on the Map pane.
 *
 * The mockup draws this with `<canvas>`; here it is Views, so the maths has to
 * come out of the renderer and live somewhere it can be tested. Everything in
 * this file is pure — no React, no measurement, no side effects.
 *
 * Coordinates come in **normalised** (0–1 of the map box) and go out in
 * points, which is what lets the same graph render at any width.
 */

export interface MapNode {
  id: string;
  /** Normalised centre, 0–1 across the map box. */
  x: number;
  y: number;
  /** Node radius in points. */
  r: number;
  label: string;
  /** Second line under the label, e.g. "1,102 notes · owner". */
  sub?: string;
  kind: GraphKind;
}

export interface MapEdge {
  from: string;
  to: string;
  kind: GraphKind;
}

export interface MapGraph {
  nodes: MapNode[];
  edges: MapEdge[];
}

export interface Size {
  width: number;
  height: number;
}

export interface PlacedNode extends MapNode {
  /** Centre in points. */
  cx: number;
  cy: number;
  /** Radius of the soft radial glow behind the node — `n.r * 2.6` in the mockup. */
  glowRadius: number;
  /** Border width — clients are drawn lighter. */
  strokeWidth: number;
}

export interface PlacedEdge {
  from: Point;
  to: Point;
  kind: GraphKind;
  thickness: number;
  opacity: number;
  dashed: boolean;
}

export interface LayoutResult {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  /**
   * Edges naming a node that is not in the graph. Returned rather than silently
   * dropped so a caller building the graph from live data can notice that, say,
   * a grant points at a workspace the user can no longer see.
   */
  dropped: MapEdge[];
}

/** `cx.globalAlpha = e[2]==='client' ? .26 : .45` */
export function edgeOpacity(kind: GraphKind): number {
  return kind === "client" ? 0.26 : 0.45;
}

/** `cx.lineWidth = e[2]==='client' ? 1 : 1.6` */
export function edgeThickness(kind: GraphKind): number {
  return kind === "client" ? 1 : 1.6;
}

/** `cx.setLineDash(e[2]==='team' ? [5,5] : [])` — team access reads as borrowed. */
export function edgeDashed(kind: GraphKind): boolean {
  return kind === "team";
}

/** `cx.lineWidth = n.kind==='client' ? 1.2 : 1.8` */
export function nodeStrokeWidth(kind: GraphKind): number {
  return kind === "client" ? 1.2 : 1.8;
}

/** The glow behind each node reaches 2.6× its radius before fading to nothing. */
export const GLOW_SCALE = 2.6;

/** Label baseline offsets below a node, from the mockup's `fillText` calls. */
export const LABEL_OFFSET = 18;
export const SUBLABEL_OFFSET = 33;

/** Places every node in points for a map box of the given size. */
export function placeNodes(nodes: MapNode[], size: Size): PlacedNode[] {
  return nodes.map((node) => ({
    ...node,
    cx: node.x * size.width,
    cy: node.y * size.height,
    glowRadius: node.r * GLOW_SCALE,
    strokeWidth: nodeStrokeWidth(node.kind),
  }));
}

/**
 * Resolves each edge to two points and its stroke style. Edges referencing an
 * unknown node id are collected into `dropped` rather than thrown — a map that
 * renders most of the truth beats one that renders an error.
 */
export function placeEdges(
  placed: PlacedNode[],
  edges: MapEdge[],
): { edges: PlacedEdge[]; dropped: MapEdge[] } {
  const byId = new Map(placed.map((node) => [node.id, node]));
  const out: PlacedEdge[] = [];
  const dropped: MapEdge[] = [];

  for (const edge of edges) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (!a || !b) {
      dropped.push(edge);
      continue;
    }
    out.push({
      from: { x: a.cx, y: a.cy },
      to: { x: b.cx, y: b.cy },
      kind: edge.kind,
      thickness: edgeThickness(edge.kind),
      opacity: edgeOpacity(edge.kind),
      dashed: edgeDashed(edge.kind),
    });
  }

  return { edges: out, dropped };
}

export function layoutGraph(graph: MapGraph, size: Size): LayoutResult {
  const nodes = placeNodes(graph.nodes, size);
  const { edges, dropped } = placeEdges(nodes, graph.edges);
  return { nodes, edges, dropped };
}

// ─── deterministic placement for live data ──────────────────────────────────

/**
 * The mockup's node positions are hand-placed for its exact three contexts and
 * four clients. Live data has neither count, so real graphs get this instead:
 * contexts on an inner orbit around "you", each context's clients fanned out on
 * an outer orbit near their parent's bearing.
 *
 * It is deterministic — same input, same picture every render — because a map
 * that reshuffles itself on every reactive update is unreadable.
 */
export const ORBIT = {
  /** Where the first context sits, in degrees clockwise from the +x axis. */
  startAngle: -140,
  contextRadiusX: 0.25,
  contextRadiusY: 0.21,
  clientRadiusX: 0.43,
  clientRadiusY: 0.38,
  /** Angular spread between sibling clients of one context. */
  clientSpread: 17,
  /** Keeps labels inside the box — nodes carry text below them. */
  bounds: { minX: 0.07, maxX: 0.93, minY: 0.1, maxY: 0.84 },
} as const;

function clampTo(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function polar(angleDegrees: number, rx: number, ry: number): Point {
  const radians = (angleDegrees * Math.PI) / 180;
  return {
    x: clampTo(0.5 + rx * Math.cos(radians), ORBIT.bounds.minX, ORBIT.bounds.maxX),
    y: clampTo(0.5 + ry * Math.sin(radians), ORBIT.bounds.minY, ORBIT.bounds.maxY),
  };
}

/** Bearing of the `index`-th of `count` contexts, evenly spread around "you". */
export function contextAngle(index: number, count: number): number {
  if (count <= 0) return ORBIT.startAngle;
  return ORBIT.startAngle + (index * 360) / count;
}

/**
 * Bearing of one client, offset from its parent context so siblings fan out
 * symmetrically rather than stacking on the same bearing.
 */
export function clientAngle(parentAngle: number, index: number, count: number): number {
  const centred = index - (count - 1) / 2;
  return parentAngle + centred * ORBIT.clientSpread;
}

/** Normalised position of a context at the given orbit index. */
export function contextPosition(index: number, count: number): Point {
  return polar(contextAngle(index, count), ORBIT.contextRadiusX, ORBIT.contextRadiusY);
}

/** Normalised position of a client hanging off a context. */
export function clientPosition(
  contextIndex: number,
  contextCount: number,
  clientIndex: number,
  clientCount: number,
): Point {
  const parent = contextAngle(contextIndex, contextCount);
  return polar(
    clientAngle(parent, clientIndex, clientCount),
    ORBIT.clientRadiusX,
    ORBIT.clientRadiusY,
  );
}

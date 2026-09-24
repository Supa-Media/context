import type { MapEdge, MapGraph, MapNode } from "../map/layout";

/**
 * The signed-off demo constellation, with the mockup's exact hand-placed
 * coordinates.
 *
 * This renders only when there is no live data to draw yet — a signed-out
 * visitor, or a brand-new account with no context. Real accounts get
 * `buildConstellation`, which places nodes on orbits rather than by hand.
 */
const DEMO_NODES: MapNode[] = [
  { id: "you", x: 0.5, y: 0.5, r: 26, label: "You", kind: "you" },
  { id: "seyi", x: 0.26, y: 0.32, r: 34, label: "@seyi", sub: "1,102 notes · owner", kind: "own" },
  { id: "lk", x: 0.79, y: 0.3, r: 24, label: "@lk", sub: "team access", kind: "team" },
  {
    id: "pw",
    x: 0.7,
    y: 0.75,
    r: 22,
    label: "@public-worship",
    sub: "shared · 6 members",
    kind: "shared",
  },
  { id: "c1", x: 0.1, y: 0.62, r: 12, label: "Claude", kind: "client" },
  { id: "c2", x: 0.31, y: 0.09, r: 12, label: "ChatGPT", kind: "client" },
  { id: "c3", x: 0.08, y: 0.16, r: 12, label: "Codex", kind: "client" },
  { id: "c4", x: 0.93, y: 0.55, r: 12, label: "Notion AI", kind: "client" },
];

const DEMO_EDGES: MapEdge[] = [
  { from: "you", to: "seyi", kind: "own" },
  { from: "you", to: "lk", kind: "team" },
  { from: "you", to: "pw", kind: "shared" },
  { from: "seyi", to: "c1", kind: "client" },
  { from: "seyi", to: "c2", kind: "client" },
  { from: "seyi", to: "c3", kind: "client" },
  { from: "lk", to: "c4", kind: "client" },
];

export const DEMO_GRAPH: MapGraph = { nodes: DEMO_NODES, edges: DEMO_EDGES };

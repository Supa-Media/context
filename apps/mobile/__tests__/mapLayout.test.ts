import { describe, expect, test } from "@jest/globals";
import {
  angleDegrees,
  distance,
  midpoint,
  scalePoint,
  segment,
} from "../features/design/geometry";
import {
  clientAngle,
  clientPosition,
  contextAngle,
  contextPosition,
  edgeDashed,
  edgeOpacity,
  edgeThickness,
  layoutGraph,
  nodeStrokeWidth,
  ORBIT,
  placeEdges,
  placeNodes,
  type MapEdge,
  type MapNode,
} from "../features/console/map/layout";
import { buildConstellation, NODE_RADIUS } from "../features/console/map/graph";
import { describeGraph } from "../features/console/map/describe";
import { DEMO_GRAPH } from "../features/console/placeholderData";

const SIZE = { width: 800, height: 398 };

describe("segment geometry", () => {
  test("a horizontal segment has zero rotation and spans its length", () => {
    const box = segment({ x: 0, y: 10 }, { x: 100, y: 10 }, 2);
    expect(box.width).toBe(100);
    expect(box.height).toBe(2);
    expect(box.angle).toBe(0);
    // Centred on the midpoint, then rotated about that centre.
    expect(box.left).toBe(0);
    expect(box.top).toBe(9);
  });

  test("a vertical segment is a 90° rotation of a horizontal rectangle", () => {
    const box = segment({ x: 50, y: 0 }, { x: 50, y: 80 }, 4);
    expect(box.width).toBe(80);
    expect(box.angle).toBe(90);
    // The un-rotated rectangle straddles the midpoint (50, 40).
    expect(box.left).toBe(10);
    expect(box.top).toBe(38);
  });

  test("a reversed segment draws the same line, 180° around", () => {
    const forward = segment({ x: 0, y: 0 }, { x: 30, y: 40 }, 1);
    const backward = segment({ x: 30, y: 40 }, { x: 0, y: 0 }, 1);
    expect(forward.left).toBeCloseTo(backward.left);
    expect(forward.top).toBeCloseTo(backward.top);
    expect(forward.width).toBeCloseTo(backward.width);
    expect(Math.abs(forward.angle - backward.angle)).toBeCloseTo(180);
  });

  test("degenerate segments do not produce NaN", () => {
    const box = segment({ x: 10, y: 10 }, { x: 10, y: 10 }, 2);
    expect(box.width).toBe(0);
    expect(Number.isNaN(box.angle)).toBe(false);
  });

  test("distance, angle and midpoint agree on a 3-4-5 triangle", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(angleDegrees({ x: 0, y: 0 }, { x: 1, y: 1 })).toBeCloseTo(45);
    expect(midpoint({ x: 0, y: 0 }, { x: 4, y: 10 })).toEqual({ x: 2, y: 5 });
  });

  test("glyph coordinates scale from their design grid", () => {
    expect(scalePoint({ x: 22, y: 11 }, 44, 88)).toEqual({ x: 44, y: 22 });
  });
});

describe("edge and node styling", () => {
  test("client edges are thinner and fainter than context edges", () => {
    expect(edgeThickness("client")).toBeLessThan(edgeThickness("own"));
    expect(edgeOpacity("client")).toBeLessThan(edgeOpacity("own"));
    expect(nodeStrokeWidth("client")).toBeLessThan(nodeStrokeWidth("own"));
  });

  test("only team access is dashed — that is what the legend promises", () => {
    expect(edgeDashed("team")).toBe(true);
    expect(edgeDashed("own")).toBe(false);
    expect(edgeDashed("shared")).toBe(false);
    expect(edgeDashed("client")).toBe(false);
  });
});

describe("placeNodes", () => {
  test("normalised coordinates become points, and the glow scales with radius", () => {
    const nodes: MapNode[] = [
      { id: "you", x: 0.5, y: 0.5, r: 26, label: "You", kind: "you" },
    ];
    const [placed] = placeNodes(nodes, SIZE);
    expect(placed.cx).toBe(400);
    expect(placed.cy).toBe(199);
    expect(placed.glowRadius).toBeCloseTo(26 * 2.6);
  });

  test("the same graph at a different width keeps its proportions", () => {
    const wide = placeNodes(DEMO_GRAPH.nodes, { width: 1000, height: 398 });
    const narrow = placeNodes(DEMO_GRAPH.nodes, { width: 500, height: 398 });
    expect(wide[1].cx / 1000).toBeCloseTo(narrow[1].cx / 500);
    // Radii are in points and must NOT scale, or nodes would balloon on a wide
    // screen while their labels stayed put.
    expect(wide[1].r).toBe(narrow[1].r);
  });
});

describe("placeEdges", () => {
  const nodes: MapNode[] = [
    { id: "you", x: 0.5, y: 0.5, r: 26, label: "You", kind: "you" },
    { id: "a", x: 0.25, y: 0.25, r: 34, label: "@a", kind: "own" },
  ];

  test("resolves both endpoints to node centres", () => {
    const placed = placeNodes(nodes, SIZE);
    const { edges } = placeEdges(placed, [{ from: "you", to: "a", kind: "own" }]);
    expect(edges).toHaveLength(1);
    expect(edges[0].from).toEqual({ x: 400, y: 199 });
    expect(edges[0].to).toEqual({ x: 200, y: 99.5 });
  });

  test("an edge naming a node that is not on the map is reported, not drawn", () => {
    const placed = placeNodes(nodes, SIZE);
    const orphan: MapEdge = { from: "a", to: "ghost", kind: "client" };
    const { edges, dropped } = placeEdges(placed, [
      { from: "you", to: "a", kind: "own" },
      orphan,
    ]);
    expect(edges).toHaveLength(1);
    expect(dropped).toEqual([orphan]);
  });
});

describe("layoutGraph", () => {
  test("lays out the signed-off demo constellation intact", () => {
    const result = layoutGraph(DEMO_GRAPH, SIZE);
    expect(result.nodes).toHaveLength(8);
    expect(result.edges).toHaveLength(7);
    expect(result.dropped).toHaveLength(0);
  });

  test("the team edge is the dashed one", () => {
    const { edges } = layoutGraph(DEMO_GRAPH, SIZE);
    const dashed = edges.filter((edge) => edge.dashed);
    expect(dashed).toHaveLength(1);
    expect(dashed[0].kind).toBe("team");
  });
});

describe("orbital placement for live data", () => {
  test("contexts are spread evenly around the centre", () => {
    expect(contextAngle(0, 3)).toBe(ORBIT.startAngle);
    expect(contextAngle(1, 3)).toBe(ORBIT.startAngle + 120);
    expect(contextAngle(2, 3)).toBe(ORBIT.startAngle + 240);
  });

  test("a single context still gets a defined bearing", () => {
    expect(Number.isFinite(contextAngle(0, 1))).toBe(true);
    expect(Number.isFinite(contextAngle(0, 0))).toBe(true);
  });

  test("sibling clients fan out symmetrically about their parent", () => {
    expect(clientAngle(0, 0, 1)).toBe(0);
    expect(clientAngle(0, 0, 2)).toBeCloseTo(-ORBIT.clientSpread / 2);
    expect(clientAngle(0, 1, 2)).toBeCloseTo(ORBIT.clientSpread / 2);
  });

  test("every placed node stays inside the map box", () => {
    for (let count = 1; count <= 8; count += 1) {
      for (let index = 0; index < count; index += 1) {
        const context = contextPosition(index, count);
        expect(context.x).toBeGreaterThanOrEqual(ORBIT.bounds.minX);
        expect(context.x).toBeLessThanOrEqual(ORBIT.bounds.maxX);
        expect(context.y).toBeGreaterThanOrEqual(ORBIT.bounds.minY);
        expect(context.y).toBeLessThanOrEqual(ORBIT.bounds.maxY);

        const client = clientPosition(index, count, 0, 3);
        expect(client.x).toBeGreaterThanOrEqual(ORBIT.bounds.minX);
        expect(client.x).toBeLessThanOrEqual(ORBIT.bounds.maxX);
      }
    }
  });

  test("placement is deterministic — the map must not reshuffle on re-render", () => {
    expect(contextPosition(1, 4)).toEqual(contextPosition(1, 4));
    expect(clientPosition(1, 4, 2, 3)).toEqual(clientPosition(1, 4, 2, 3));
  });

  test("clients orbit further out than the contexts they hang off", () => {
    expect(ORBIT.clientRadiusX).toBeGreaterThan(ORBIT.contextRadiusX);
    expect(ORBIT.clientRadiusY).toBeGreaterThan(ORBIT.contextRadiusY);
  });
});

describe("buildConstellation", () => {
  const contexts = [
    { id: "w1", label: "@seyi", kind: "own" as const },
    { id: "w2", label: "@team", kind: "shared" as const },
  ];

  test("puts you at the centre with an edge to every context", () => {
    const graph = buildConstellation({ contexts, clients: [] });
    const you = graph.nodes.find((node) => node.id === "you");
    expect(you).toMatchObject({ x: 0.5, y: 0.5, kind: "you", r: NODE_RADIUS.you });
    expect(graph.edges).toEqual([
      { from: "you", to: "w1", kind: "own" },
      { from: "you", to: "w2", kind: "shared" },
    ]);
  });

  test("a client hangs off the context that granted it, never off you", () => {
    const graph = buildConstellation({
      contexts,
      clients: [{ id: "g1", label: "Claude", contextId: "w2" }],
    });
    expect(graph.edges).toContainEqual({ from: "w2", to: "g1", kind: "client" });
    expect(graph.edges).not.toContainEqual({ from: "you", to: "g1", kind: "client" });
  });

  test("a grant on a context you cannot see does not appear on the map", () => {
    const graph = buildConstellation({
      contexts,
      clients: [{ id: "g1", label: "Ghost", contextId: "someone-elses" }],
    });
    expect(graph.nodes.some((node) => node.id === "g1")).toBe(false);
    expect(graph.edges.some((edge) => edge.to === "g1")).toBe(false);
  });

  test("an account with no contexts is just you", () => {
    const graph = buildConstellation({ contexts: [], clients: [] });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
  });

  test("every edge resolves once the graph is laid out", () => {
    const graph = buildConstellation({
      contexts,
      clients: [
        { id: "g1", label: "Claude", contextId: "w1" },
        { id: "g2", label: "ChatGPT", contextId: "w1" },
        { id: "g3", label: "Codex", contextId: "w2" },
      ],
    });
    expect(layoutGraph(graph, SIZE).dropped).toHaveLength(0);
  });
});

describe("describeGraph", () => {
  test("summarises the demo constellation for screen readers", () => {
    const text = describeGraph(DEMO_GRAPH);
    expect(text).toContain("3 contexts");
    expect(text).toContain("@seyi");
    expect(text).toContain("4 AI clients connected");
  });

  test("says so when there is nothing connected yet", () => {
    expect(describeGraph({ nodes: [], edges: [] })).toContain("not connected to any context");
  });

  test("uses the singular for one context and no clients", () => {
    const text = describeGraph({
      nodes: [
        { id: "you", x: 0.5, y: 0.5, r: 26, label: "You", kind: "you" },
        { id: "w", x: 0.3, y: 0.3, r: 34, label: "@solo", kind: "own" },
      ],
      edges: [],
    });
    expect(text).toContain("1 context:");
    expect(text).toContain("No AI clients are connected.");
  });
});

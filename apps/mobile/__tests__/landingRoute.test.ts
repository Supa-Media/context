import { describe, expect, test } from "@jest/globals";
import { landingFor } from "../features/landing/route";
import { DEMO_LOOP_MS, DEMO_FROM, DEMO_TOUR, demoCounts, demoEvents, demoGraphs, tourStopAt } from "../features/landing/demoMap";

/**
 * The landing pages (Dev2, 2026-10-09): `/` is page a and `/a` to `/e` are
 * their own, while every address the website homepage already answered keeps
 * drawing it.
 */
describe("landingFor", () => {
  test("/ is page a, and /a to /e are their own", () => {
    expect(landingFor({ pathname: "/" })).toBe("a");
    for (const letter of ["a", "b", "c", "d", "e"]) expect(landingFor({ pathname: `/${letter}` })).toBe(letter);
    expect(landingFor({ pathname: "/c/" })).toBe("c");
  });

  test("a page of the website is still the website", () => {
    expect(landingFor({ pathname: "/", page: "pricing" })).toBeNull();
    expect(landingFor({ pathname: "/", page: ["devlog"] })).toBeNull();
    expect(landingFor({ pathname: "/", page: "" })).toBe("a");
  });

  test("a cast preview and the cast studio's stage are recordings of the website", () => {
    expect(landingFor({ pathname: "/", hash: "#cast-preview=abc" })).toBeNull();
    expect(landingFor({ pathname: "/", studio: true })).toBeNull();
    expect(landingFor({ pathname: "/", hash: "#top" })).toBe("a");
  });

  test("anything else is not a landing page", () => {
    for (const pathname of ["/f", "/A", "/ab", "/pricing", "/@seyi", "/a/b"]) expect(landingFor({ pathname })).toBeNull();
  });
});

describe("the demo map", () => {
  const graphs = demoGraphs();
  const events = demoEvents();

  test("every edge joins two notes of its own workspace, with no self-links", () => {
    for (const g of graphs) {
      for (const [a, b] of g.edges) {
        expect(a).not.toBe(b);
        expect(g.nodes[a]).toBeDefined();
        expect(g.nodes[b]).toBeDefined();
      }
      expect(new Set(g.nodes.map((n) => n.path)).size).toBe(g.nodes.length);
      const pairs = g.edges.map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`));
      expect(new Set(pairs).size).toBe(pairs.length);
    }
  });

  test("events stay inside the loop, in order, on the workspaces drawn", () => {
    const ids = new Set(graphs.map((g) => g.workspaceId));
    expect(events.length).toBeGreaterThan(30);
    let last = -Infinity;
    for (const e of events) {
      expect(e.at).toBeGreaterThanOrEqual(DEMO_FROM);
      expect(e.at).toBeLessThan(DEMO_FROM + DEMO_LOOP_MS);
      expect(e.at).toBeGreaterThanOrEqual(last);
      expect(ids.has(e.workspaceId)).toBe(true);
      last = e.at;
    }
  });

  test("a note is created once, and every other step is on a note the graph has", () => {
    const created = events.filter((e) => e.kind === "create");
    const keys = created.map((e) => (e.kind === "move" ? "" : `${e.workspaceId}|${e.path}`));
    expect(new Set(keys).size).toBe(keys.length);
    const createdKeys = new Set(keys);
    for (const e of events) {
      if (e.kind === "move" || e.kind === "create") continue;
      const g = graphs.find((x) => x.workspaceId === e.workspaceId)!;
      const known = g.nodes.some((n) => n.path === e.path) || createdKeys.has(`${e.workspaceId}|${e.path}`);
      expect(known).toBe(true);
    }
  });

  test("the counts a page shows are the demo's own", () => {
    expect(demoCounts()).toEqual({ people: 5, agents: 6 });
  });

  test("the camera tour starts on everything and holds each stop until the next", () => {
    expect(tourStopAt(0)).toBe(DEMO_TOUR[0]);
    expect(tourStopAt(5).workspaceId).toBe(DEMO_TOUR[1]!.workspaceId);
    expect(tourStopAt(10).folder).toBe("1-projects");
    expect(tourStopAt(29.9)).toBe(DEMO_TOUR[DEMO_TOUR.length - 1]);
  });
});

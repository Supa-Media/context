/**
 * The Lab's pages (Dev2, 2026-11-20: "the nightly cleanup is a different type of AI job. It's not really texting, so it
 * should probably live in a different graph"): the canvas draws one page, Texting or Nightly (`engine/pages.ts`), the
 * address keeps it (`?graph=nightly`, `views/labPlace.ts`), and a step added on the Nightly page lives there.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-20):
 *   `onPage` answering the graph whatever the page    "the canvas draws one page" fails
 *   `searchOf` leaving `graph` out of the address     "the address keeps the page" fails
 */
import { beforeEach, describe, expect, test } from "@jest/globals";
import { clone, G, lab, MAIN, node } from "@context/lab/app/engine/state";
import { onPage, pageField, pageNamed, pagesOfStep, stepCountsByPage } from "@context/lab/app/engine/pages";
import { placeOf, searchOf } from "@context/lab/app/views/labPlace";
import { addStep } from "@context/lab/app/views/canvas/actions";
import type { LabGraph, LabNode } from "@context/lab/app/types";

const NIGHTLY = ["aboutCheck", "aboutExpire", "daysum", "dream", "housekeep", "nightly"];
const ids = (g: LabGraph) => g.nodes.map((n) => n.id).sort();
const step = (id: string, extra: Partial<LabNode> = {}): LabNode =>
  ({ id, label: id, goal: "", log: false, on: true, rounds: 1, out: 300, ctx: [], ms: 0, timeoutS: 0, areas: [], file: "", note: "", icon: "", model: "code", x: 0, y: 0, ...extra }) as LabNode;

beforeEach(() => {
  lab.cur = clone(MAIN);
  lab.versions = [MAIN];
  lab.undoStack = [];
  lab.sel = null;
  lab.cfocus = null;
  lab.graphPage = "texting";
});

describe("the canvas draws one page", () => {
  test("main's Nightly page is the nightly cleanup and the wires among its steps, and Texting is everything else", () => {
    const night = onPage(G(), "nightly");
    expect(ids(night)).toEqual(NIGHTLY);
    expect(night.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["aboutExpire>aboutCheck", "dream>aboutExpire", "dream>daysum", "nightly>dream", "nightly>housekeep"]);
    const day = onPage(G(), "texting");
    expect(day.nodes.some((n) => NIGHTLY.includes(n.id))).toBe(false);
    // Search's steps are on their own page (Dev2, 2026-11-21): between the three pages every step is counted once.
    const search = onPage(G(), "search");
    expect(ids(search)).toEqual(["answer", "budget", "code", "floor", "fuse", "meaning", "merge", "open", "opens", "prior", "probes", "rerank", "rerankWords", "search", "snippets", "title", "visible", "words"]);
    expect(day.nodes.length + night.nodes.length + search.nodes.length).toBe(G().nodes.length);
    // Every wire is on one page or the other: none crosses.
    expect(day.edges.length + night.edges.length + search.edges.length).toBe(G().edges.length);
    // The folded groups (main's are all texting) stay with the texting page and leave the nightly one.
    expect(Object.keys(day.folded ?? {}).length).toBeGreaterThan(0);
    expect(night.folded).toBeUndefined();
  });

  test("a group box is on the page its steps are on, and gone from a page it has no step on", () => {
    const g: LabGraph = {
      nodes: [step("a"), step("box"), step("z", { graph: "nightly" })],
      edges: [{ from: "a", to: "box", mode: "wait", when: ["*"] }],
      folded: { box: { nodes: [step("b1", { graph: "nightly" }), step("b2", { graph: "nightly" })], edges: [] } },
    };
    expect([...pagesOfStep(g.nodes[1], g)]).toEqual(["nightly"]);
    const night = onPage(g, "nightly");
    expect(ids(night)).toEqual(["box", "z"]);
    expect(night.edges).toEqual([]);
    expect(Object.keys(night.folded ?? {})).toEqual(["box"]);
    const day = onPage(g, "texting");
    expect(ids(day)).toEqual(["a"]);
    expect(day.folded).toBeUndefined();
  });

  test("a page that leaves nothing out answers the same graph, so the canvas's edits land on the Lab's own", () => {
    const g: LabGraph = { nodes: [step("a"), step("b")], edges: [] };
    expect(onPage(g, "texting")).toBe(g);
    expect(onPage(g, "nightly").nodes).toEqual([]);
  });

  test("each page's steps are counted with the groups opened", () => {
    const counts = stepCountsByPage(G());
    expect(counts.nightly).toBe(6);
    expect(counts.texting).toBeGreaterThan(20);
    // Search is a page of its own (Dev2, 2026-11-21): every step a search runs.
    expect(counts.search).toBe(18);
  });

  test("a page's name from anywhere is a page, or Texting", () => {
    expect(pageNamed("nightly")).toBe("nightly");
    expect(pageNamed("search")).toBe("search");
    expect(pageNamed("weekly")).toBe("texting");
    expect(pageNamed(undefined)).toBe("texting");
    expect(pageField("texting")).toEqual({});
    expect(pageField("nightly")).toEqual({ graph: "nightly" });
  });
});

describe("the address keeps the page", () => {
  test("?graph=nightly reads back as the place it was written from; Texting stays out of the address", () => {
    const night = { mode: "lab" as const, view: "canvas" as const, chat: "me", moment: null, graph: "nightly" as const };
    expect(searchOf(night)).toBe("?graph=nightly");
    expect(placeOf(searchOf(night))).toEqual(night);
    expect(searchOf({ ...night, chat: "g1", node: "dream" })).toBe("?graph=nightly&node=dream&chat=g1");
    expect(searchOf({ ...night, graph: "texting" })).toBe("");
    expect(searchOf({ ...night, graph: null })).toBe("");
    // An unknown page, and a page in Testing, fall back to the texting graph.
    expect(placeOf("?graph=weekly")).toEqual({ mode: "lab", view: "canvas", chat: "me", moment: null });
    expect(placeOf("?mode=testing&graph=nightly").graph).toBeUndefined();
    expect(placeOf("?graph=search").graph).toBe("search");
  });
});

describe("adding a step", () => {
  test("on the Nightly page the new step lives there; on Texting it carries no graph", () => {
    lab.graphPage = "nightly";
    addStep("code", { x: 0, y: 0, k: 1 }, { width: 800, height: 600 });
    const added = node((lab.sel as { id: string }).id)!;
    expect(added.graph).toBe("nightly");
    expect(onPage(G(), "nightly").nodes.some((n) => n.id === added.id)).toBe(true);
    lab.graphPage = "texting";
    addStep("code", { x: 0, y: 0, k: 1 }, { width: 800, height: 600 });
    const plain = node((lab.sel as { id: string }).id)!;
    expect(plain.graph).toBeUndefined();
  });
});

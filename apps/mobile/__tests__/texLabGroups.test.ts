/**
 * The Lab folds a step group into one box (Dev2, 2026-11-14: "Focus on it opens all eleven steps"). Tex's config keeps
 * the eleven "door" steps as code nodes with `group: "door"`; the Lab shows them as one "door" box, so every Lab feature
 * that keys on the step id "door" keeps working. A save unfolds the box, because Promote writes the config's own steps.
 *
 * Sabotage record (temporary local edits, reverted):
 *   foldGroups keeping the members in the graph         "folds the real config into one door box" fails
 *   unfoldGroups sending a wire from the box to the chain's first step, and dropping an unmatched wire into it   "unfold(fold(config)) has exactly the config's wires" and the user-wire tests fail
 */
import { describe, expect, test } from "@jest/globals";
import TEX_CONFIG from "@context/shared/src/texConfig.json";
import { GROUPS, mainGraph } from "../features/tex/lab/data/graph";
import { foldAround, foldGroups, groupToOpen, stepsShownFor, unfoldGroups } from "../features/tex/lab/engine/groups";
import type { LabEdge, LabGraph, LabNode } from "../features/tex/lab/types";

const MEMBERS = TEX_CONFIG.nodes.filter((n) => n.group === "door").map((n) => n.id);
const wireKey = (e: { from: string; to: string; mode: string; when: string[] }) => [e.from, e.to, e.mode, e.when.join(",")].join("|");
const ids = (g: LabGraph) => g.nodes.map((n) => n.id).sort();
const wires = (g: LabGraph) => g.edges.map(wireKey).sort();
const configWires = TEX_CONFIG.edges.map(wireKey).sort();
const configIds = TEX_CONFIG.nodes.map((n) => n.id).sort();
const folded = () => foldGroups({ nodes: JSON.parse(JSON.stringify(TEX_CONFIG.nodes)), edges: JSON.parse(JSON.stringify(TEX_CONFIG.edges)) }, GROUPS);

describe("folding the config's door group", () => {
  test("the config has eleven door steps, and the folded graph shows one door box in their place", () => {
    expect(MEMBERS).toHaveLength(11);
    const g = folded();
    const box = g.nodes.find((n) => n.id === "door") as LabNode;
    expect(box).toBeDefined();
    expect(box.label).toBe("Door steps");
    expect(box.icon).toBe("door");
    expect([box.x, box.y]).toEqual([GROUPS.door.x, GROUPS.door.y]);
    expect(box.model).toBe("code");
    expect(g.nodes.map((n) => n.id).filter((id) => MEMBERS.includes(id))).toEqual([]);
  });

  test("the box's time is the members' time added up, and its areas are their union", () => {
    const box = folded().nodes.find((n) => n.id === "door") as LabNode;
    const members = TEX_CONFIG.nodes.filter((n) => n.group === "door");
    expect(box.ms).toBe(members.reduce((sum, n) => sum + n.ms, 0));
    expect([...box.areas].sort()).toEqual(["core", "pipeline"]);
  });

  test("the outside wires point at the box, collapsed, and the wires inside the group are gone", () => {
    const g = folded();
    const has = (from: string, to: string, mode: string, when: string[]) =>
      g.edges.some((e) => e.from === from && e.to === to && e.mode === mode && e.when.join(",") === when.join(","));
    expect(has("lanes", "door", "wait", ["*"])).toBe(true);
    expect(has("routine", "door", "wait", ["*"])).toBe(true);
    expect(has("door", "fd", "wait", ["*"])).toBe(true);
    expect(has("door", "router", "wait", ["*"])).toBe(true);
    expect(has("door", "send", "wait", ["answered"])).toBe(true);
    expect(g.edges.filter((e) => e.from === "door" && e.to === "send")).toHaveLength(1);
    expect(g.edges.filter((e) => e.from === "door" && e.to === "door")).toHaveLength(0);
    expect(g.edges.filter((e) => MEMBERS.includes(e.from) || MEMBERS.includes(e.to))).toHaveLength(0);
  });

  test("the Lab's main graph is the folded config", () => {
    expect(ids(mainGraph())).toContain("door");
    expect(ids(mainGraph()).filter((id) => MEMBERS.includes(id))).toEqual([]);
  });
});

describe("unfolding puts the config back", () => {
  test("unfold(fold(config)) has exactly the config's step ids and wires", () => {
    const u = unfoldGroups(folded());
    expect(ids(u)).toEqual(configIds);
    expect(wires(u)).toEqual(configWires);
    expect(u.folded).toBeUndefined();
  });

  test("the steps come back with their own fields, in the config's order", () => {
    const u = unfoldGroups(folded());
    expect(u.nodes.map((n) => n.id)).toEqual(TEX_CONFIG.nodes.map((n) => n.id));
    expect(u.nodes.find((n) => n.id === "checkItMayRun")).toEqual(TEX_CONFIG.nodes.find((n) => n.id === "checkItMayRun"));
  });

  test("an unfolded graph is left as it is", () => {
    const g = { nodes: TEX_CONFIG.nodes, edges: TEX_CONFIG.edges } as LabGraph;
    expect(wires(unfoldGroups(g))).toEqual(configWires);
    expect(ids(unfoldGroups(g))).toEqual(configIds);
  });

  test("a wire the user draws from the box leaves from the chain's last step, and one into it goes to the first", () => {
    const g = folded();
    g.edges.push({ from: "door", to: "reviewer", mode: "wait", when: ["action"] } as LabEdge);
    g.edges = g.edges.map((e) => (e.from === "lanes" && e.to === "door" ? { ...e, from: "decide" } : e));
    const u = unfoldGroups(g);
    expect(u.edges).toContainEqual({ from: "prepareTheAnswer", to: "reviewer", mode: "wait", when: ["action"] });
    expect(u.edges).toContainEqual({ from: "decide", to: "readTheText", mode: "wait", when: ["*"] });
  });

  test("a changed wire from the box replaces the step wires it stood for, and leaves from the last step", () => {
    const g = folded();
    g.edges = g.edges.map((e) => (e.from === "door" && e.to === "send" ? { ...e, when: ["answered", "group"] } : e));
    const u = unfoldGroups(g);
    expect(u.edges.filter((e) => e.to === "send" && e.when.join(",") === "answered,group")).toEqual([
      { from: "prepareTheAnswer", to: "send", mode: "wait", when: ["answered", "group"] },
    ]);
    expect(u.edges.filter((e) => MEMBERS.includes(e.from) && e.to === "send" && e.when.join(",") === "answered")).toEqual([]);
  });
});

describe("focus on the door box", () => {
  test("Focus opens all eleven steps, and each one is in the canvas with its own wires", () => {
    const opened = foldAround(folded(), "door", GROUPS);
    const shown = stepsShownFor(opened, "door");
    expect(shown.map((n) => n.id).sort()).toEqual([...MEMBERS].sort());
    expect(opened.nodes.find((n) => n.id === "door")).toBeUndefined();
    const chain = opened.edges.filter((e) => MEMBERS.includes(e.from) && MEMBERS.includes(e.to));
    expect(chain).toHaveLength(10);
    expect(opened.edges.filter((e) => e.to === "send" && MEMBERS.includes(e.from))).toHaveLength(5);
  });

  test("a folded graph shows no focused steps, and Whole graph folds the group again", () => {
    expect(stepsShownFor(folded(), "door")).toEqual([]);
    const back = foldAround(foldAround(folded(), "door", GROUPS), null, GROUPS);
    expect(ids(back)).toEqual(ids(folded()));
    expect(wires(back)).toEqual(wires(folded()));
  });

  test("a member can be focused on, and it keeps its group open", () => {
    expect(groupToOpen(folded(), "door")).toBe("door");
    const opened = foldAround(folded(), "door", GROUPS);
    expect(groupToOpen(opened, "checkItMayRun")).toBe("door");
    expect(stepsShownFor(foldAround(opened, "checkItMayRun", GROUPS), "door")).toHaveLength(11);
  });

  test("the saved version of an open group is the config again", () => {
    const opened = foldAround(folded(), "door", GROUPS);
    const saved = unfoldGroups(opened);
    expect(ids(saved)).toEqual(configIds);
    expect(wires(saved)).toEqual(configWires);
  });
});

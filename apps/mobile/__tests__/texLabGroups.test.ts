/**
 * The Lab folds a step group into one box (Dev2, 2026-11-14: "Focus on it opens all eleven steps"). Tex's config names
 * each step's `group` and draws each group from its top-level `groups`; the Lab shows a group as one box whose id is the
 * group's id. Here the "intake" group's seven steps (A text arrives through the Door) fold into one "intake" box, and
 * the "jobs" box takes the wire the Front door starts a job on. A save unfolds the boxes, because Promote writes the
 * config's own steps.
 *
 * Sabotage record (temporary local edits, reverted):
 *   foldGroups keeping the members in the graph         "the folded graph shows one intake box" fails
 *   unfoldGroups sending a wire from the box to the chain's first step, and dropping an unmatched wire into it   "unfold(fold(config)) has exactly the config's wires" and the user-wire tests fail
 */
import { describe, expect, test } from "@jest/globals";
import TEX_CONFIG from "@context/shared/src/texConfig.json";
import { GROUPS, mainGraph } from "../features/tex/lab/data/graph";
import { foldAround, foldGroups, groupToOpen, stepsShownFor, unfoldGroups } from "../features/tex/lab/engine/groups";
import type { LabEdge, LabGraph, LabNode } from "../features/tex/lab/types";

const MEMBERS = TEX_CONFIG.nodes.filter((n) => n.group === "intake").map((n) => n.id);
const wireKey = (e: { from: string; to: string; mode: string; when: string[] }) => [e.from, e.to, e.mode, e.when.join(",")].join("|");
const ids = (g: LabGraph) => g.nodes.map((n) => n.id).sort();
const wires = (g: LabGraph) => g.edges.map(wireKey).sort();
const configWires = TEX_CONFIG.edges.map(wireKey).sort();
const configIds = TEX_CONFIG.nodes.map((n) => n.id).sort();
const folded = () => foldGroups({ nodes: JSON.parse(JSON.stringify(TEX_CONFIG.nodes)), edges: JSON.parse(JSON.stringify(TEX_CONFIG.edges)) }, GROUPS);

describe("folding the config's intake group", () => {
  test("the config has seven intake steps, and the folded graph shows one intake box in their place", () => {
    expect(MEMBERS).toEqual(["text", "edit", "triage", "decide", "lanes", "react", "doorStep"]);
    const g = folded();
    const box = g.nodes.find((n) => n.id === "intake") as LabNode;
    expect(box).toBeDefined();
    expect(box.label).toBe("Intake");
    expect(box.icon).toBe("text");
    expect([box.x, box.y]).toEqual([GROUPS.intake.x, GROUPS.intake.y]);
    expect(box.model).toBe("code");
    expect(g.nodes.map((n) => n.id).filter((id) => MEMBERS.includes(id))).toEqual([]);
  });

  test("the box's time is the members' time added up, and its areas are their union", () => {
    const box = folded().nodes.find((n) => n.id === "intake") as LabNode;
    const members = TEX_CONFIG.nodes.filter((n) => n.group === "intake");
    expect(box.ms).toBe(members.reduce((sum, n) => sum + n.ms, 0));
    expect([...box.areas].sort()).toEqual(["core", "pipeline", "respond"]);
  });

  test("the outside wires point at the box, collapsed, and the wires inside the group are gone", () => {
    // A second member wire to the Front door on the same "next" collapses into the box's one wire.
    const c = { nodes: JSON.parse(JSON.stringify(TEX_CONFIG.nodes)), edges: JSON.parse(JSON.stringify(TEX_CONFIG.edges)) };
    c.edges.push({ from: "triage", to: "fd", mode: "wait", when: ["next"] });
    const g = foldGroups(c, GROUPS);
    const has = (from: string, to: string, mode: string, when: string[]) =>
      g.edges.some((e) => e.from === from && e.to === to && e.mode === mode && e.when.join(",") === when.join(","));
    // Out of the intake box: the Door's two wires. Into a box: the Front door starting a job, onto the jobs box.
    expect(has("intake", "fd", "wait", ["next"])).toBe(true);
    expect(has("intake", "bypass", "wait", ["answered"])).toBe(true);
    expect(has("fd", "jobs", "job", ["job"])).toBe(true);
    expect(has("jobs", "tools-subagents", "uses", ["job"])).toBe(true);
    expect(has("routine", "fd", "wait", ["run"])).toBe(true);
    expect(g.edges.filter((e) => e.from === "intake" && e.to === "fd")).toHaveLength(1);
    expect(g.edges.filter((e) => e.from === "intake" && e.to === "intake")).toHaveLength(0);
    expect(g.edges.filter((e) => MEMBERS.includes(e.from) || MEMBERS.includes(e.to))).toHaveLength(0);
  });

  test("the Lab's main graph is the folded config", () => {
    expect(ids(mainGraph())).toContain("intake");
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
    expect(u.nodes.find((n) => n.id === "doorStep")).toEqual(TEX_CONFIG.nodes.find((n) => n.id === "doorStep"));
  });

  test("an unfolded graph is left as it is", () => {
    const g = { nodes: TEX_CONFIG.nodes, edges: TEX_CONFIG.edges } as LabGraph;
    expect(wires(unfoldGroups(g))).toEqual(configWires);
    expect(ids(unfoldGroups(g))).toEqual(configIds);
  });

  test("a wire the user draws from the box leaves from the chain's last step, and one into it goes to the first", () => {
    const g = folded();
    g.edges.push({ from: "intake", to: "answerCheck", mode: "wait", when: ["action"] } as LabEdge);
    g.edges = g.edges.map((e) => (e.from === "fd" && e.to === "jobs" ? { ...e, from: "answerCheck" } : e));
    const u = unfoldGroups(g);
    expect(u.edges).toContainEqual({ from: "doorStep", to: "answerCheck", mode: "wait", when: ["action"] });
    expect(u.edges).toContainEqual({ from: "answerCheck", to: "job", mode: "job", when: ["job"] });
  });

  test("a changed wire from the box replaces the step wires it stood for, and leaves from the last step", () => {
    const g = folded();
    g.edges = g.edges.map((e) => (e.from === "intake" && e.to === "bypass" ? { ...e, when: ["answered", "group"] } : e));
    const u = unfoldGroups(g);
    expect(u.edges.filter((e) => e.to === "bypass" && e.when.join(",") === "answered,group")).toEqual([
      { from: "doorStep", to: "bypass", mode: "wait", when: ["answered", "group"] },
    ]);
    expect(u.edges.filter((e) => MEMBERS.includes(e.from) && e.to === "bypass" && e.when.join(",") === "answered")).toEqual([]);
  });
});

describe("focus on the intake box", () => {
  test("Focus opens all seven steps, and each one is in the canvas with its own wires", () => {
    const opened = foldAround(folded(), "intake", GROUPS);
    const shown = stepsShownFor(opened, "intake");
    expect(shown.map((n) => n.id).sort()).toEqual([...MEMBERS].sort());
    expect(opened.nodes.find((n) => n.id === "intake")).toBeUndefined();
    const chain = opened.edges.filter((e) => MEMBERS.includes(e.from) && MEMBERS.includes(e.to));
    expect(chain).toHaveLength(7);
    expect(opened.edges.filter((e) => MEMBERS.includes(e.from) && !MEMBERS.includes(e.to))).toEqual([
      { from: "doorStep", to: "fd", mode: "wait", when: ["next"] },
      { from: "doorStep", to: "bypass", mode: "wait", when: ["answered"] },
    ]);
  });

  test("a folded graph shows no focused steps, and Whole graph folds the group again", () => {
    expect(stepsShownFor(folded(), "intake")).toEqual([]);
    const back = foldAround(foldAround(folded(), "intake", GROUPS), null, GROUPS);
    expect(ids(back)).toEqual(ids(folded()));
    expect(wires(back)).toEqual(wires(folded()));
  });

  test("a member can be focused on, and it keeps its group open", () => {
    expect(groupToOpen(folded(), "intake")).toBe("intake");
    const opened = foldAround(folded(), "intake", GROUPS);
    expect(groupToOpen(opened, "doorStep")).toBe("intake");
    expect(stepsShownFor(foldAround(opened, "doorStep", GROUPS), "intake")).toHaveLength(7);
  });

  test("the saved version of an open group is the config again", () => {
    const opened = foldAround(folded(), "intake", GROUPS);
    const saved = unfoldGroups(opened);
    expect(ids(saved)).toEqual(configIds);
    expect(wires(saved)).toEqual(configWires);
  });
});

// Saving from the Lab unfolds every group (Promote ships what it gives). Sabotage: put a box-to-box wire back from the
// first box's last step to the second's first (job -> tools became jobadv -> tools), or put each group's steps where
// its first step was, and this fails.
test("a save gives back the config exactly: every wire on the steps it joined, every step in the config's order", () => {
  const config = { nodes: TEX_CONFIG.nodes as LabNode[], edges: TEX_CONFIG.edges as LabEdge[] };
  const saved = unfoldGroups(foldGroups(JSON.parse(JSON.stringify(config)), GROUPS));
  expect(saved.nodes.map((n) => n.id)).toEqual(config.nodes.map((n) => n.id));
  const key = (e: LabEdge) => [e.from, e.to, e.mode, e.when.join(",")].join("|");
  expect(saved.edges.map(key).sort()).toEqual(config.edges.map(key).sort());
  expect(config.edges.some((e) => e.from === "job" && e.to === "tools")).toBe(true);
});

/**
 * Components (Dev2, 2026-11-26: "a concept of components like figma has so we can reference something and reuse it
 * wherever it is"; "cant the components just stay inside the group"). A group marked `component: true` is still one
 * set of steps; the Lab only draws it differently: its box is left off a canvas where every wire to it meets another
 * group's box, an open group shows a reference card under the step that calls it, and the sidebar counts its uses.
 *
 * Sabotage record (temporary local edits, reverted):
 *   tuckedComponents ignoring a wire from a bare step     "a component wired to a bare step stays drawn" fails
 *   groupView drawing component outs as pills again       "an open group shows a reference card, not a pill" fails
 *   texLabOps group op dropping the component check       "the group op refuses a component that is not a boolean" fails
 */
import { describe, expect, test } from "@jest/globals";
import { componentUses, isComponent, tuckedComponents } from "@context/lab/app/engine/components";
import { foldAround, foldGroups, type GroupDefs } from "@context/lab/app/engine/groups";
import { renderGroupFocusHtml } from "@context/lab/app/views/canvas/groupView";
import { renderGraphHtml } from "@context/lab/app/views/canvas/render";
import { simulate } from "@context/lab/app/engine/sim";
import { groupsReference } from "@context/lab/app/engine/forMcpGroups";
import { configProblems } from "@context/tex/src/texConfigSchema.cjs";
import { applyOps } from "@context/lab/src/texLabOps.cjs";
import type { LabEdge, LabGraph, LabNode } from "@context/lab/app/types";

const step = (id: string, group: string | undefined, x: number, y = 0): LabNode =>
  ({ id, label: id[0].toUpperCase() + id.slice(1), goal: "", log: true, on: true, rounds: 1, out: 0, ctx: [], ms: 10, timeoutS: 10, areas: [], file: "", note: "", icon: "code", model: "code", x, y, ...(group ? { group } : {}) }) as LabNode;
const wire = (from: string, to: string, mode: LabEdge["mode"] = "wait"): LabEdge => ({ from, to, mode, when: [] });

// Front door (fd) and Check (chk) both use the Jobs component; Jobs reports back to Intake.
const GROUPS: GroupDefs = {
  intake: { label: "Intake", x: 0, y: 0 },
  front: { label: "Front door", x: 300, y: 0 },
  chk: { label: "Check", x: 600, y: 0 },
  jobs: { label: "Jobs", x: 600, y: 200, component: true },
};
const base = (): LabGraph => ({
  nodes: [step("text", "intake", 0), step("fd", "front", 300), step("helper", "front", 300, 120), step("claim", "chk", 600), step("jobStart", "jobs", 600, 200), step("part", "jobs", 860, 200)],
  edges: [wire("text", "fd"), wire("fd", "claim"), wire("fd", "jobStart", "job"), wire("helper", "jobStart", "background"), wire("claim", "jobStart", "job"), wire("jobStart", "part"), wire("part", "text", "generator")],
  groups: GROUPS,
} as LabGraph);

describe("components on the whole canvas", () => {
  test("a component every wire of which meets another group's box is not drawn, nor are its wires", () => {
    const g = foldGroups(base(), GROUPS);
    expect(isComponent(GROUPS, "jobs")).toBe(true);
    expect([...tuckedComponents(g, GROUPS)]).toEqual(["jobs"]);
    const html = renderGraphHtml(g, simulate(g, "own", null), [], null, null, "off", null, null, { groups: GROUPS });
    expect(html).not.toContain('data-id="jobs"');
    expect(html).toContain('data-id="front"');
  });

  test("a component wired to a bare step stays drawn, so no wire is hidden from a step someone can see", () => {
    const b = base();
    b.nodes.push(step("loose", undefined, 0, 300));
    b.edges.push(wire("loose", "jobStart", "job"));
    const g = foldGroups(b, GROUPS);
    expect(tuckedComponents(g, GROUPS).size).toBe(0);
  });

  test("uses count each group that wires into it once, and its own steps not at all", () => {
    expect(componentUses(base(), GROUPS)).toEqual({ jobs: ["chk", "front"] });
  });
});

describe("components inside an open group", () => {
  test("an open group shows a reference card, not a pill, one per step that calls it", () => {
    const g = foldAround(base(), "front", GROUPS);
    const { html } = renderGroupFocusHtml(g, simulate(g, "own", null), "front", GROUPS, { tags: [], sel: null, lit: null, counts: null, marks: null });
    const cards = html.match(/class="gref" data-gport="jobs"/g) ?? [];
    expect(cards).toHaveLength(2);
    expect(html).toContain("◇ Jobs · 2 uses");
    expect(html).not.toMatch(/class="gport" data-gport="jobs"/);
    // An ordinary wire out is still a pill.
    expect(html).toMatch(/class="gport" data-gport="chk"/);
  });

  test("tex_dev reference groups says the same: component, where it is used, and which wires are cards", () => {
    const g = foldGroups(base(), GROUPS);
    const ref = groupsReference(g);
    const jobs = ref.find((r) => r.group === "jobs")!;
    expect(jobs).toMatchObject({ component: true, usedBy: ["chk", "front"] });
    const front = ref.find((r) => r.group === "front")!;
    expect(front.to.filter((t) => t.outside === "jobs").every((t) => (t as { as?: string }).as === "card")).toBe(true);
    expect(front.to.find((t) => t.outside === "chk")).not.toHaveProperty("as");
  });
});

describe("the config and the Lab's group op keep component", () => {
  test("the schema takes component true or false, and nothing else", () => {
    const at = (component: unknown) => configProblems({ texConfig: 0, models: {}, nodes: [], edges: [], groups: { jobs: { label: "Jobs", component } } }).filter((p: string) => p.includes("component"));
    expect(at(true)).toEqual([]);
    expect(at("yes")).toEqual(['jobs.component: not boolean']);
  });

  test("the group op refuses a component that is not a boolean, and keeps one that is", () => {
    const g = { nodes: [], edges: [] };
    const op = (component: unknown) => [{ op: "group", id: "jobs", value: { label: "Jobs", component } }] as unknown as Parameters<typeof applyOps>[1];
    expect(() => applyOps(g, op("yes"))).toThrow(/component must be true or false/);
    const out = applyOps(g, op(true)) as unknown as { graph: { groups: Record<string, { component?: boolean }> } };
    expect(out.graph.groups.jobs.component).toBe(true);
  });
});

/**
 * The Lab's step groups for the MCP's `tex_dev reference` topic groups (Lab = MCP parity; mockup 5y8sZpxqRYNZEdqqXTjq6J
 * v3, Dev2 2026-11-16): each group, the group it sits in, its own steps and the groups inside it, and what opening it
 * on the canvas draws: the wires between its things and the wires in from outside and out to outside (the pills), each
 * naming the thing outside as the canvas does. Read from the same functions the canvas draws with.
 */
import { groupsOf } from "../data/graph";
import { groupParts } from "./groupLayout";
import { componentUses, isComponent } from "./components";
import { foldAround, groupChain, unfoldGroups } from "./groups";
import type { LabGraph } from "../types";

export function groupsReference(graph: LabGraph, only?: string | null) {
  const steps = graph.folded ? unfoldGroups(graph) : graph;
  const groups = groupsOf(graph);
  const ids = [...new Set([...Object.keys(groups), ...steps.nodes.flatMap((n) => (n.group ? [n.group] : []))])];
  if (only && !ids.includes(only)) throw new Error(`There is no group called "${only}". Groups: ${ids.join(", ")}.`);
  const uses = componentUses(steps, groups);
  const holds = (id: string) => steps.nodes.filter((n) => n.group && groupChain(groups, n.group).includes(id)).length;
  return (only ? [only] : ids).map((id) => {
    const open = foldAround(steps, id, groups);
    const { items, inner, ins, outs } = groupParts(open, id, groups);
    const name = (x: string) => open.nodes.find((n) => n.id === x)?.label ?? x;
    const kind = (x: string) => (open.folded?.[x] ? "group" : "step");
    const wire = (i: number) => {
      const e = open.edges[i];
      return { from: e.from, to: e.to, mode: e.mode, when: e.when };
    };
    return {
      group: id,
      label: groups[id]?.label ?? id,
      ...(groups[id]?.goal ? { goal: groups[id].goal } : {}),
      ...(groups[id]?.parent ? { parent: groups[id].parent } : {}),
      // A component (Dev2, 2026-11-26): where it is used, as the sidebar's Components list counts it.
      ...(isComponent(groups, id) ? { component: true, usedBy: uses[id] ?? [] } : {}),
      steps: items.filter((n) => !open.folded?.[n.id]).map((n) => n.id),
      groups: items.filter((n) => open.folded?.[n.id]).map((n) => n.id),
      holds: holds(id),
      inside: inner.map(wire),
      from: ins.map((p) => ({ outside: p.other, name: name(p.other), is: kind(p.other), to: p.item, mode: p.mode, when: p.when })),
      // A wire out to a component is drawn as a reference card under its step, not a pill (`as: "card"`).
      to: outs.map((p) => ({ from: p.item, outside: p.other, name: name(p.other), is: kind(p.other), mode: p.mode, when: p.when, ...(isComponent(groups, p.other) ? { as: "card" } : {}) })),
    };
  });
}

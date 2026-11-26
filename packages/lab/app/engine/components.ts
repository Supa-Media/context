/**
 * Components (Dev2, 2026-11-26: "what if we had a concept of components like figma has so we can reference something
 * and reuse it wherever it is"; "cant the components just stay inside the group"). A component is a group marked
 * `component: true` in the config's `groups`. It is still one set of steps, defined once; the Lab only draws it
 * differently:
 *
 *   - On a canvas where every wire to or from the component's box meets another group's box (or another component),
 *     the box and those wires are not drawn: each group that uses it holds it, and shows it when opened.
 *   - In an open group, a wire from a step inside to a component is drawn as a reference card below that step (dashed
 *     teal, "◇ Jobs · 2 uses ⤢"), not as a pill at the frame's edge. Clicking it opens the component.
 *   - The sidebar lists every component under Components, with how many places use it.
 *
 * Nothing here changes the graph: folding, saving and Promote see the same steps and wires as before. Pure.
 */
import type { LabGraph } from "../types";
import { groupChain, unfoldGroups, type GroupDefs } from "./groups";

/** Is `id` a group marked as a component? */
export const isComponent = (groups: GroupDefs, id: string): boolean => groups[id]?.component === true;

/**
 * The component boxes a canvas does not draw (see the note at the top): drawn as a folded box, with at least one wire,
 * and every wire meeting another folded box or component. A component wired to a bare step stays on the canvas, so no
 * wire is ever hidden from a step someone can see.
 */
export function tuckedComponents(g: LabGraph, groups: GroupDefs): Set<string> {
  const out = new Set<string>();
  const boxes = new Set(g.nodes.filter((n) => g.folded?.[n.id]).map((n) => n.id));
  for (const id of boxes) {
    if (!isComponent(groups, id)) continue;
    const touching = g.edges.filter((e) => e.from === id || e.to === id);
    if (touching.length === 0) continue;
    if (touching.every((e) => boxes.has(e.from === id ? e.to : e.from))) out.add(id);
  }
  return out;
}

/**
 * The places that use each component: the steps outside it, each counted by the innermost group it sits in (or by the
 * step itself), that wire into one of its steps. `{ [component]: string[] }`, read from the whole (unfolded) graph.
 */
export function componentUses(g: LabGraph, groups: GroupDefs): Record<string, string[]> {
  const full = g.folded ? unfoldGroups(g) : g;
  const groupOf = new Map(full.nodes.map((n) => [n.id, n.group] as const));
  const inside = (comp: string, id: string) => groupChain(groups, groupOf.get(id) ?? "").includes(comp);
  const out: Record<string, string[]> = {};
  for (const comp of Object.keys(groups).filter((id) => isComponent(groups, id))) {
    const users = new Set<string>();
    for (const e of full.edges) if (inside(comp, e.to) && !inside(comp, e.from)) users.add(groupOf.get(e.from) ?? e.from);
    out[comp] = [...users].sort();
  }
  return out;
}

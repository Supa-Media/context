/**
 * Make a component from steps (Dev, 2026-11-27: "there's no way to create new components?"; Dev chose "Select steps,
 * make component"; artboard /lab-new-component-artboards, spec `design-spec.md`). Pick steps on the canvas
 * (`engine/picks.ts`), press Make component (or ⌥⌘K), name it, Create.
 *
 * Create is one undoable draft change, written as the same edits `tex_dev` makes (`texLabOps.cjs`):
 *
 *   { op: "group", id, value: { label, goal?, icon, component: true } }, then { op: "set", node, field: "group", value: id }
 *   for each step, and a `move` each so they stack in one column where the first one was.
 *
 * The rules that keep a component callable are the shared ops' (`componentRefusal`), so the bar and `tex_dev` refuse
 * with the same sentence; only a group's card in the picks is the canvas's own refusal (the ops see steps only).
 */
import { applyOps, componentRefusal } from "@context/lab/src/texLabOps.cjs";
import type { LabGraphJson, LabOp } from "@context/lab/src/texLabOps.d.cts";
import { groupsOf } from "../data/graph";
import type { LabGraph } from "../types";
import { isGroupFocus, unfoldGroups, type GroupDefs } from "./groups";
import { ROW } from "./groupLayout";
import { GRAPH_PAGES } from "./pages";
import { edit, focusOn, G, lab, node, toast, undo, unfocus } from "./state";

/** What the popover's Name starts as, all selected so typing replaces it. */
export const NEW_NAME = "New component";

/** The canvas's own refusal: a group's card cannot go in a component yet (nesting groups in one is left out). */
export const GROUP_CARD = "Groups can't go in a component yet: open it and pick its steps.";

/** Why the picked things cannot become a component, with the name the bar draws bold; null when they can. */
export function whyNot(ids: string[], g: LabGraph = G()): { text: string; bold: string | null } | null {
  const full = unfoldGroups(g);
  const steps = ids.filter((id) => !g.folded?.[id]);
  const why = componentRefusal(full as unknown as LabGraphJson, steps);
  if (why) {
    const n = steps.map((id) => full.nodes.find((x) => x.id === id)).find((x) => x && why.startsWith(x.label + " "));
    return { text: why, bold: n?.label ?? null };
  }
  return ids.some((id) => g.folded?.[id]) ? { text: GROUP_CARD, bold: null } : null;
}

/**
 * A group id from the name: "Reply checks" is `replyChecks`, with a number added when that id is taken by a group or a
 * step ("replyChecks2"). Always a valid config id.
 */
export function componentId(name: string, taken: ReadonlySet<string>): string {
  const words = name.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  let id = words.map((w, i) => (i === 0 ? w[0].toLowerCase() + w.slice(1) : w[0].toUpperCase() + w.slice(1))).join("");
  if (!/^[A-Za-z]/.test(id)) id = "component" + id;
  id = id.slice(0, 44);
  if (!taken.has(id)) return id;
  for (let i = 2; ; i++) if (!taken.has(id + i)) return id + i;
}

/** The edits that make the component: its group, then each step's `group`, then each step's place in one column. */
export function componentOps(full: LabGraph, ids: string[], label: string, goal: string, groups: GroupDefs): { id: string; ops: LabOp[] } {
  const taken = new Set([...Object.keys(groups), ...full.nodes.map((n) => n.id)]);
  const id = componentId(label, taken);
  const steps = ids.map((x) => full.nodes.find((n) => n.id === x)!).filter(Boolean).sort((a, b) => a.y - b.y || a.x - b.x);
  const first = steps[0];
  const value: Record<string, unknown> = { label, ...(goal ? { goal } : {}), icon: first?.icon || "code", component: true };
  const ops: LabOp[] = [
    { op: "group", id, value },
    ...steps.map((n): LabOp => ({ op: "set", node: n.id, field: "group", value: id })),
    ...steps.map((n, i): LabOp => ({ op: "move", node: n.id, x: first.x, y: first.y + i * ROW })),
  ];
  return { id, ops };
}

/** "3 steps from Check & finish": where the picked steps are now, the open group or the page. */
export function fromWhere(): string {
  const groups = groupsOf(G());
  if (lab.cfocus && isGroupFocus(G(), lab.cfocus, groups)) return groups[lab.cfocus]?.label ?? lab.cfocus;
  return GRAPH_PAGES.find(([p]) => p === lab.graphPage)?.[1] ?? "this page";
}

/**
 * Create: one undoable draft change, then the canvas opens the component and a toast offers Undo, which also goes back
 * to where the steps were picked. Answers the new id, or null when refused.
 */
export function makeComponent(ids: string[], name: string, goal = ""): string | null {
  const why = whyNot(ids);
  if (why) {
    toast(why.text);
    return null;
  }
  const label = name.trim() || NEW_NAME;
  const back = lab.cfocus;
  const full = unfoldGroups(G());
  const { id, ops } = componentOps(full, ids, label, goal.trim(), groupsOf(G()));
  let next: LabGraph;
  try {
    next = applyOps(full as unknown as LabGraphJson, ops).graph as unknown as LabGraph;
  } catch (e) {
    toast(e instanceof Error ? e.message.replace(/^edit \d+ \([a-z_]+\): /, "") : String(e));
    return null;
  }
  edit(() => {
    lab.cur.graph = next;
    lab.picks = [];
    lab.sel = null;
  });
  focusOn(id);
  const n = ids.length;
  toast(`Made ${label} from ${n} step${n === 1 ? "" : "s"}`, {
    bold: label,
    undo: () => {
      undo();
      if (back && (node(back) || groupsOf(G())[back])) focusOn(back);
      else unfocus();
    },
  });
  return id;
}

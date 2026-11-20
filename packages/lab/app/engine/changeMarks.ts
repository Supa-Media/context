/**
 * What a draft changed, drawn on the graph (Dev2, 2026-11-15: "if there are changes being made in a revision, either
 * by AI or humans, it should be pretty visual which node has been changed, or if something's been deleted, mark it as
 * red, or maybe like a toggle to show what's been changed, like in a ghost"). Design:
 * https://claude.ai/artifact/VnAnSNDprEUJ4fFDEmXqhp, boards 3 and 4.
 *
 * The draft is compared with main, or with itself before a revision (`texLabDrafts.graphBefore`), both unfolded so a
 * change inside a folded group marks the group's box. Marks outlines a changed step in yellow, draws new steps and
 * wires green and removed ones red, and fades nothing; Ghost also draws the base's version under each changed step,
 * dashed. A step's place is never a change.
 */
import { unfoldGroups } from "./groups";
import { groupsOf } from "../data/graph";
import { edit, G, lab, MAIN, MODELS, toast } from "./state";
import type { LabEdge, LabGraph, LabNode } from "../types";

export type ChangeMode = "off" | "marks" | "ghost";
export type NodeMark = { kind: "changed" | "new"; fields: string[]; base: LabNode | null };
export type GoneWire = { from: LabNode; to: LabNode; mode: string };
export type Marks = {
  mode: "marks" | "ghost";
  /** What the draft is compared with: "main", or "rev N" (the draft before revision N). */
  vs: string;
  nodes: Record<string, NodeMark>;
  removed: LabNode[];
  newWires: Set<string>;
  goneWires: GoneWire[];
};

/** The fields a change is named by, in the order the panel lists them. */
export const FIELD_NAMES: Array<[keyof LabNode | "inSchema", string]> = [
  ["label", "name"],
  ["goal", "goal"],
  ["file", "code"],
  ["model", "model"],
  ["effort", "effort"],
  ["toolList", "tool list"],
  ["on", "running"],
  ["rounds", "rounds"],
  ["out", "tokens out"],
  ["timeoutS", "limit"],
  ["sendBack", "send-backs"],
  ["log", "record"],
  ["ctx", "reads"],
  ["inSchema", "input"],
  ["outSchema", "output"],
  ["icon", "icon"],
];

export const wireKey = (e: Pick<LabEdge, "from" | "to" | "mode" | "when" | "unless">) => `${e.from}>${e.to}:${e.mode}:${(e.when || []).join("/")}:${(e.unless || []).join("/")}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The fields of a step that differ from its base. */
export function changedFields(n: LabNode, o: LabNode): string[] {
  const rec = (x: LabNode) => x as unknown as Record<string, unknown>;
  return FIELD_NAMES.filter(([k]) => !same(rec(n)[k], rec(o)[k])).map(([, name]) => name);
}

/** A field's value as a person reads it, for the hover and the panel. */
export function fieldText(n: LabNode | null | undefined, name: string): string {
  if (!n) return "none";
  const k = FIELD_NAMES.find(([, nm]) => nm === name)?.[0];
  if (!k) return "";
  const v = (n as unknown as Record<string, unknown>)[k];
  if (k === "model") return MODELS[String(v)]?.full ?? String(v ?? "");
  if (k === "on" || k === "log") return v ? "yes" : "no";
  if (k === "outSchema" || k === "inSchema") return Array.isArray(v) && v.length ? (v as Array<{ name: string }>).map((f) => f.name).join(", ") : "free text";
  if (Array.isArray(v)) return v.join(", ") || "none";
  return v === undefined || v === null || v === "" ? "none" : String(v);
}

/** The step's wires in and out of a graph, as keys. */
const wiresOf = (g: LabGraph, id: string) => g.edges.filter((e) => e.from === id || e.to === id).map(wireKey).sort();

/**
 * Marks for the draft `cur` against `base`. Both are compared unfolded; a step drawn inside a folded box marks the box.
 */
export function computeMarks(cur: LabGraph, base: LabGraph, mode: "marks" | "ghost", vs: string): Marks {
  const a = unfoldGroups(base);
  const b = unfoldGroups(cur);
  const drawn = new Set(cur.nodes.map((n) => n.id));
  const boxOf = (n: LabNode) => (drawn.has(n.id) ? n.id : n.group && drawn.has(n.group) ? n.group : null);
  const byA = new Map(a.nodes.map((n) => [n.id, n]));
  const byB = new Map(b.nodes.map((n) => [n.id, n]));
  const nodes: Record<string, NodeMark> = {};
  const touch = (id: string | null, field: string, base: LabNode | null) => {
    if (!id) return;
    const m = nodes[id] ?? (nodes[id] = { kind: "changed", fields: [], base });
    if (!m.fields.includes(field)) m.fields.push(field);
  };
  for (const n of b.nodes) {
    const o = byA.get(n.id);
    const box = boxOf(n);
    if (!o) {
      if (box === n.id) nodes[n.id] = { kind: "new", fields: [], base: null };
      else touch(box, `${n.label} added inside`, null);
      continue;
    }
    const fields = changedFields(n, o);
    if (!same(wiresOf(a, n.id), wiresOf(b, n.id))) fields.push("wires");
    // Moving a step (x, y) is never a change (Dev2, 2026-11-16): only fields and wires mark.
    if (box === n.id) {
      if (fields.length) nodes[n.id] = { kind: "changed", fields, base: o };
    } else if (fields.length) touch(box, `${n.label} inside`, cur.nodes.find((x) => x.id === box) ?? null);
  }
  const removed: LabNode[] = [];
  for (const o of a.nodes) {
    if (byB.has(o.id)) continue;
    // A removed step inside a group still folded marks the box; one drawn on its own is drawn where it was.
    const box = o.group && drawn.has(o.group) ? o.group : null;
    if (box) touch(box, `${o.label} removed inside`, null);
    else removed.push(o);
  }
  const ka = new Set(a.edges.map(wireKey));
  const kb = new Set(b.edges.map(wireKey));
  const newWires = new Set(b.edges.map(wireKey).filter((k) => !ka.has(k)));
  const at = (id: string) => cur.nodes.find((n) => n.id === id) ?? removed.find((n) => n.id === id) ?? null;
  const goneWires: GoneWire[] = [];
  for (const e of a.edges) {
    if (kb.has(wireKey(e))) continue;
    const from = at(e.from);
    const to = at(e.to);
    if (from && to) goneWires.push({ from, to, mode: e.mode });
  }
  return { mode, vs, nodes, removed, newWires, goneWires };
}

/** The graph the open draft is compared with, or null when there is none to compare (main itself, or not loaded). */
export function changeBase(): { graph: LabGraph; vs: string } | null {
  if (lab.cur.id === "main") return null;
  if (lab.chgVs === "main") return { graph: MAIN.graph, vs: "main" };
  const r = lab.revBase;
  return r && r.rev === lab.chgVs ? { graph: r.graph, vs: `rev ${r.rev - 1}` } : null;
}

/** What the draft changed in one step against its base, whether or not the canvas draws marks (the step panel's Settings). */
export function stepChange(id: string): { x: NodeMark; vs: string } | null {
  const b = changeBase();
  const x = b ? computeMarks(G(), b.graph, "marks", b.vs).nodes[id] : undefined;
  return b && x ? { x, vs: b.vs } : null;
}

/** The marks the canvas draws now, or null when they are off. */
export function currentMarks(): Marks | null {
  if (lab.chg === "off") return null;
  const b = changeBase();
  return b ? computeMarks(G(), b.graph, lab.chg, b.vs) : null;
}

export function markCounts(m: Marks | null): { changed: number; added: number; removed: number } {
  if (!m) return { changed: 0, added: 0, removed: 0 };
  const v = Object.values(m.nodes);
  return { changed: v.filter((x) => x.kind === "changed").length, added: v.filter((x) => x.kind === "new").length, removed: m.removed.length };
}

/**
 * Put back `base`'s version of one step in `g` (both unfolded): its fields, place and wires; a new step goes, a
 * removed one comes back with the wires it had to steps still here. Pure on `g`, so the MCP's `tex_dev put_back` runs
 * the same code (`forMcp.ts`).
 */
export function putBackIn(g: LabGraph, base: LabGraph, id: string) {
  const o = base.nodes.find((n) => n.id === id);
  const n = g.nodes.find((x) => x.id === id);
  const here = (x: string) => g.nodes.some((y) => y.id === x);
  if (!o) {
    g.nodes = g.nodes.filter((x) => x.id !== id);
    g.edges = g.edges.filter((e) => e.from !== id && e.to !== id);
  } else {
    if (n) Object.assign(n, JSON.parse(JSON.stringify(o)));
    else g.nodes.push(JSON.parse(JSON.stringify(o)));
    g.edges = g.edges.filter((e) => e.from !== id && e.to !== id);
    for (const e of base.edges) if ((e.from === id || e.to === id) && here(e.from) && here(e.to)) g.edges.push({ ...e, when: [...e.when] });
  }
}

/**
 * Put back the base's version of one step: its fields, place and wires; a new step goes, a removed one comes back
 * with the wires it had to steps still here.
 */
export function putBack(id: string) {
  const b = changeBase();
  if (!b) return;
  if (groupsOf(G())[id] || G().folded?.[id]) return toast("Open the group (Focus) to put back a step inside it");
  const base = unfoldGroups(b.graph);
  edit(() => {
    const g = G();
    putBackIn(g, base, id);
    if (lab.sel?.t === "node" && lab.sel.id === id && !g.nodes.some((x) => x.id === id)) lab.sel = null;
  });
}

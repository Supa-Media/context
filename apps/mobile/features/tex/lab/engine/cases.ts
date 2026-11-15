/**
 * Every step's test cases (Dev2, 2026-11-15): "we should have a max of 20 test cases per unit" and "a lot of nodes
 * don't even have test cases listed here. And there's not a way to add them". A step's cases are its bench areas'
 * (`data/areas.ts`, e.g. the reviewer's `review`) and its own node cases (`apps/mcp/bench/nodes/<id>.json`, area
 * `node:<id>`), whose boxes come from the step's input and output shapes, so every step gets the same form.
 */
import { AREAS } from "../data/areas";
import { GROUPS } from "../data/graph";
import { CASES } from "../labData.generated";
import type { LabCase, LabGraph, LabNode } from "../types";
import { G, lab, MODELS } from "./state";

/** The most cases one step keeps (`UNIT_LIMIT` in apps/mcp/bench/gateSample.mjs; the fast guards fail past it). */
export const CASE_CAP = 20;

export const NODE_AREA = "node:";
export const isNodeArea = (area: string) => area.startsWith(NODE_AREA);
export const nodeArea = (id: string) => NODE_AREA + id;
export const nodeOfArea = (area: string) => (isNodeArea(area) ? area.slice(NODE_AREA.length) : null);

/** A step field as the config gives it: `inSchema` and `outSchema` rows. */
export type Field = { name: string; type: string; options?: string; optional?: boolean };
/** What a node case wants of one output field: an exact value, or a judge reading it against words. */
export type Want = { is?: string; judge?: string };

/** Every step of a graph, those inside a folded group too; a group's own box is not a step. */
export function allSteps(g: LabGraph = G()): LabNode[] {
  const inside = Object.values(g.folded ?? {}).flatMap((f) => f.nodes);
  return [...g.nodes.filter((n) => !GROUPS[n.id]), ...inside];
}

export const stepById = (id: string, g: LabGraph = G()) => allSteps(g).find((n) => n.id === id);

/** Every case as the Lab shows it: the bench's, each kept edit laid over it, new ones added, swapped-out ones gone. */
export function liveCases(): LabCase[] {
  const out = CASES.map((c) => Object.assign({}, c, lab.caseEdits[c.area + "/" + c.id] || {}));
  for (const e of Object.values(lab.caseEdits)) if (e.isNew) out.push(e);
  return out.filter((c) => !c.removed);
}

export const casesIn = (area: string, all: LabCase[] = liveCases()) => all.filter((c) => c.area === area);

/** The bench areas a step answers to, then its own node area. */
export function areasOf(n: LabNode): string[] {
  return [...(n.areas || []).filter((a) => AREAS[a]), nodeArea(n.id)];
}

/** How many cases test a step: its bench areas' and its own. */
export function stepCount(n: LabNode, all: LabCase[] = liveCases()): number {
  const areas = new Set(areasOf(n));
  return all.filter((c) => areas.has(c.area)).length;
}

/** Each step's case count, for the canvas's chips. */
export function stepCounts(g: LabGraph = G()): Record<string, number> {
  const all = liveCases();
  return Object.fromEntries(allSteps(g).map((n) => [n.id, stepCount(n, all)]));
}

const isModel = (n: LabNode) => (MODELS[n.model] || MODELS.code).runs !== "code";

/** Steps no case tests yet, model steps first ("model steps first" in the nav), then by name. */
export function emptySteps(g: LabGraph = G()): LabNode[] {
  const all = liveCases();
  return allSteps(g)
    .filter((n) => stepCount(n, all) === 0)
    .sort((a, b) => Number(isModel(b)) - Number(isModel(a)) || a.label.localeCompare(b.label));
}

/** Steps with node cases of their own, listed with the unit areas. */
export function nodeCaseSteps(g: LabGraph = G()): LabNode[] {
  const all = liveCases();
  return allSteps(g).filter((n) => casesIn(nodeArea(n.id), all).length > 0);
}

/** A step's model line: "Haiku · low", "Code", "Gemini". */
export function modelLine(n: LabNode): string {
  const m = MODELS[n.model] || MODELS.code;
  if (m.runs === "code") return "Code";
  return m.name + (n.effort && m.runs !== "api" ? " · " + n.effort : "");
}

/** The step's input and output fields, as its config shapes them; a step with none takes or gives free text. */
export function fieldsOf(n: LabNode): { ins: Field[]; outs: Field[] } {
  const raw = n as LabNode & { inSchema?: Field[] };
  const ins = raw.inSchema?.length ? raw.inSchema : [{ name: "text", type: "text" }];
  const outs = n.outSchema?.length ? (n.outSchema as Field[]) : [{ name: "text", type: "text" }];
  return { ins, outs };
}

/** The choices an exact want can take for a field, or null when it is free (text, numbers, lists). */
export function choicesOf(f: Field): string[] | null {
  if (f.type === "yesno") return ["Yes", "No"];
  if (f.type === "choice" && f.options) return f.options.split(",").map((s) => s.trim()).filter(Boolean);
  return null;
}

/** One line of what a node case gives and wants, for its card and the run's prompt. */
export function nodeCaseText(c: LabCase): { ask: string; expect: string } {
  const given = (c.given || {}) as Record<string, string>;
  const want = (c.want || {}) as Record<string, Want>;
  const ask = Object.entries(given)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
  const expect = Object.entries(want)
    .filter(([, w]) => w.is || w.judge)
    .map(([k, w]) => (w.is ? `${k} = ${w.is}` : `${k}: a judge reads it for "${w.judge}"`))
    .join("; ");
  return { ask, expect };
}

/** The next free id in an area: new-1, new-2, ... */
export function nextId(area: string): string {
  const taken = new Set(liveCases().filter((c) => c.area === area).map((c) => c.id));
  for (const k of Object.keys(lab.caseEdits)) if (k.startsWith(area + "/")) taken.add(k.slice(area.length + 1));
  let i = 1;
  while (taken.has("new-" + i)) i++;
  return "new-" + i;
}

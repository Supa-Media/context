/**
 * The Tests page's pure reads, kept apart from its React parts (`caseParts.tsx`) so the MCP's `tex_dev bench`
 * (`engine/forMcp.ts`) answers with the same functions the page draws with: why a case can't test a version
 * (`caseFit`), what an area's test panel shows (`ioInfo`, the artifact's `ioPanel`), who its cases run as (`whoInfo`,
 * `whoPanel`), and the counts on an area's button.
 */
import { AREA_INFO, AREA_IO, PEOPLE } from "../../data/areas";
import { allCases, isPicked } from "../../engine/diff";
import { unfoldGroups } from "../../engine/groups";
import { mods } from "../../engine/modules";
import { simulate, type Sim } from "../../engine/sim";
import { G, lab, MAIN, MODELS, node } from "../../engine/state";
import { SCENARIOS } from "../../engine/traces";
import type { LabCase, LabGraph, LabModel, LabNode } from "../../types";

/** A case tests a step, never a folded group box: read the graph with its groups open. */
const open = (g: LabGraph): LabGraph => (g.folded ? unfoldGroups(g) : g);

export function modName(k: string, g: LabGraph): string {
  return k.startsWith("out:") ? (node(k.slice(4), g)?.label || k) + "'s output" : mods(g)[k]?.name || k;
}

/** Why a case can't test this version the way it tests main: the step is gone or off, it no longer reads what the case gives, or the field the case checks is gone. */
export function caseFit(c: LabCase, shown: LabGraph = G()): string[] {
  const g = open(shown);
  const I = AREA_INFO[c.area], io = AREA_IO[c.area];
  if (!I || !io) return [];
  const n = node(I.step, g);
  if (!n) return [`This version has no ${node(I.step, MAIN.graph)?.label || I.step}`];
  const w: string[] = [];
  if (!n.on && node(I.step, MAIN.graph)?.on) w.push(`${n.label} is off`);
  if (io.check.code) return w;
  const miss = io.gives.filter((k) => !n.ctx.includes(k));
  if (miss.length) w.push(`${n.label} no longer reads ${miss.map((k) => modName(k, g)).join(", ")}`);
  const sc = n.outSchema || [];
  if (io.check.field) {
    const f = sc.find((x) => x.name === io.check.field);
    const want = io.check.map ? io.check.map(c) : "";
    if (!f) w.push(`checks ${io.check.field}, which ${n.label} no longer answers`);
    else if (f.type === "choice" && f.options && !f.options.split(/\s*,\s*/).includes(want)) w.push(`expects ${io.check.field} = ${want}, not one of its options`);
  } else if (sc.length && !sc.some((x) => x.type === "text")) w.push(`checks words, but ${n.label} answers only typed fields`);
  return w;
}

/** One chip of a unit area's "In" row: the case gives it (g), the step no longer reads it (x), from the person's workspace (f), or the bench fills it (d). */
export type IoChip = { key: string; name: string; cls: "g" | "x" | "f" | "d" };

export type IoInfo =
  | { int: true; step: LabNode; model: LabModel; test: string; sim: Sim; path: LabNode[]; check: string; how: string }
  | { int: false; step: LabNode; model: LabModel; chips: IoChip[]; fixture: boolean; check: string; how: string };

/**
 * An area's test panel. For an integration area: the traced test (`pick` when it is one of the area's, else its
 * first), its reply time and cost, and the path of steps it runs; for a unit area: what goes in, the step and the check.
 */
export function ioInfo(area: string, shown: LabGraph = G(), pick: string | null = null): IoInfo | null {
  const g = open(shown);
  const I = AREA_INFO[area], io = AREA_IO[area];
  if (!I || !io) return null;
  const n = node(I.step, g) || node(I.step, MAIN.graph);
  if (!n) return null;
  const m = MODELS[n.model] || MODELS.code;
  if (I.int) {
    const pk = pick && SCENARIOS[pick]?.group === area ? pick : Object.keys(SCENARIOS).find((k) => SCENARIOS[k].group === area) || "own";
    const sim = simulate(g, pk, lab.logRows);
    const path = Object.entries(sim.T)
      .sort((a, b) => a[1].start - b[1].start)
      .map(([id]) => node(id, g))
      .filter((x): x is LabNode => !!x);
    return { int: true, step: n, model: m, test: pk, sim, path, check: io.check.code ? "code" : io.check.field || "words", how: io.check.how };
  }
  const gives = new Set([...io.gives, ...(io.fixture || [])]);
  const chips: IoChip[] = [
    ...io.gives.map((k) => ({ key: k, name: modName(k, g), cls: (n.ctx.includes(k) ? "g" : "x") as IoChip["cls"] })),
    ...(io.fixture || []).map((k) => ({ key: k, name: modName(k, g), cls: "f" as const })),
    ...n.ctx.filter((k) => !gives.has(k)).map((k) => ({ key: k, name: modName(k, g), cls: "d" as const })),
  ];
  return { int: false, step: n, model: m, chips, fixture: !!io.fixture, check: io.check.code ? "code" : io.check.field || "words", how: io.check.how };
}

/** Who an area's cases run as, when no bench person does: how it is run, and for Should Tex answer its chats. Null for an area with a person. */
export function whoInfo(area: string, inArea: LabCase[]): { how: string; groups: number; ones: number; icon: string } | null {
  const I: { as?: string; how?: string } = AREA_INFO[area] || {};
  if (I.as && PEOPLE[I.as]) return null;
  const chat = (c: LabCase) => (c as LabCase & { chat?: string }).chat;
  return {
    how: I.how || "",
    groups: inArea.filter((c) => chat(c) === "group").length,
    ones: inArea.filter((c) => chat(c) === "one").length,
    icon: node(AREA_INFO[area]?.step ?? "", MAIN.graph)?.icon || "judge",
  };
}

/**
 * What a case expects (`caseWant`): a core case not edited shows its musts and nevers; any other its expected outcome,
 * its tone (ok for quiet or done, bad for a send-back or a decline), and the field it checks with the value wanted.
 */
export function caseWant(c: LabCase, edited: boolean): { want: string; musts?: string[]; nots?: string[]; expect?: string; tone?: "ok" | "bad" | "acc"; field?: string; value?: string } {
  const x = c as LabCase & { musts?: string[]; nots?: string[] };
  const I: { want?: string } = AREA_INFO[c.area] || {};
  if (c.area === "core" && !edited && x.musts) return { want: I.want || "", musts: x.musts, nots: x.nots || [] };
  const tone = /quiet|let it go|done$/i.test(c.expect) ? "ok" : /send it back|decline/i.test(c.expect) ? "bad" : "acc";
  const io = AREA_IO[c.area];
  return { want: I.want || "Should", expect: c.expect, tone, ...(io?.check.field ? { field: io.check.field, value: io.check.map ? io.check.map(c) : "" } : {}) };
}

/** An area button's numbers: cases in the run, cases in all, and cases that can't test this version as written. */
export function areaCounts(area: string): { picked: number; total: number; unfit: number } {
  const cs = allCases().filter((c) => c.area === area);
  return { picked: cs.filter(isPicked).length, total: cs.length, unfit: cs.filter((c) => caseFit(c).length).length };
}

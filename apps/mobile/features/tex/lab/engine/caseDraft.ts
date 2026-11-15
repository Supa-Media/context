/**
 * The case being written, before Keep: a step's own node case (its given and want boxes) or a case swapped into a
 * full step (Dev2, 2026-11-15: at most 20 a step, so a new one goes in by trading one out). Nothing here is saved
 * until Keep; Cancel drops it. Shared by the Tests page and the step panel, which show the same form.
 */
import { dropCase, saveCase } from "../store";
import type { LabCase } from "../types";
import { CASE_CAP, casesIn, fieldsOf, nextId, nodeCaseText, nodeOfArea, stepById, type Want } from "./cases";
import { emit, lab, toast } from "./state";

export type NodeDraft = { area: string; id: string; given: Record<string, string>; want: Record<string, Want>; isNew: boolean };
export type SwapDraft = { area: string; id: string; ask: string; expect: string; out: string | null };

export const drafts: { node: NodeDraft | null; swap: SwapDraft | null; showAllEmpty: boolean } = { node: null, swap: null, showAllEmpty: false };

/** Open the form for a new case on a step with its own cases, every box empty. */
export function startNodeCase(stepId: string) {
  const area = "node:" + stepId;
  const n = stepById(stepId);
  if (!n) return;
  const { ins, outs } = fieldsOf(n);
  drafts.node = {
    area,
    id: nextId(area),
    given: Object.fromEntries(ins.map((f) => [f.name, ""])),
    want: Object.fromEntries(outs.map((f) => [f.name, {}])),
    isNew: true,
  };
  emit();
}

/** Open the form on a kept node case, to change it. */
export function editNodeCase(c: LabCase) {
  drafts.node = { area: c.area, id: c.id, given: { ...(c.given || {}) }, want: JSON.parse(JSON.stringify(c.want || {})), isNew: !!c.isNew };
  emit();
}

export function cancelNodeCase() {
  drafts.node = null;
  emit();
}

/** Keep the node case for every staff member, at most 20 a step. */
export async function keepNodeCase() {
  const d = drafts.node;
  if (!d) return;
  const full = casesIn(d.area).filter((c) => c.id !== d.id).length >= CASE_CAP;
  if (full) return toast(`A step keeps at most ${CASE_CAP} cases: trade one out first`);
  const c: LabCase = { area: d.area, id: d.id, given: d.given, want: d.want, isNew: d.isNew, ask: "", expect: "", by: lab.myId, at: Date.now() };
  Object.assign(c, nodeCaseText(c));
  drafts.node = null;
  await saveCase(c);
}

/** Start a case going into a full step: written here, then a case picked to go, then Keep. */
export function startSwap(area: string) {
  drafts.swap = { area, id: nextId(area), ask: "", expect: "", out: null };
  emit();
}

export function pickSwapOut(id: string | null) {
  if (!drafts.swap) return;
  drafts.swap.out = id;
  emit();
}

export function cancelSwap() {
  drafts.swap = null;
  emit();
}

/** Keep the swap: the new case, and the one it replaces marked removed; the step stays at its 20. */
export async function keepSwap(base: LabCase | undefined) {
  const s = drafts.swap;
  if (!s || !s.out || !s.ask.trim()) return;
  drafts.swap = null;
  const outKey = s.area + "/" + s.out;
  // A case only this Lab added goes the way it came; a bench case is marked removed for the run to take out.
  if (lab.caseEdits[outKey]?.isNew) await dropCase(outKey);
  else await saveCase({ ...(base || { ask: "", expect: "" }), ...(lab.caseEdits[outKey] || {}), area: s.area, id: s.out, removed: true, by: lab.myId, at: Date.now() });
  await saveCase({ area: s.area, id: s.id, ask: s.ask, expect: s.expect || "What's right", isNew: true, replaces: s.out, by: lab.myId, at: Date.now() });
}

/** The step a node area belongs to, for headings. */
export const stepOfArea = (area: string) => {
  const id = nodeOfArea(area);
  return id ? stepById(id) : undefined;
};

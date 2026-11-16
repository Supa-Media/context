/**
 * The test chat's simulated phone line (gateway `labSandbox/steps.js` `TRANSPORT_STEPS`): a text is held on the line
 * on its way in (`lineIn`) and each of Tex's texts on its way out (`lineOut`), each a logged step of kind `line`. The
 * line is the sandbox's transport, not Tex, so it is never a node of the config, never in a draft and never saved;
 * the canvas draws it as two dashed pseudo-steps while a test chat is open (`views/canvas/lineDecor.ts`), as the
 * approved Lab live sandbox mockup does (https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5).
 */
import type { LabGraph, LabNode } from "../types";
import { sandbox } from "./sandbox";

export const LINE_STEPS = ["lineIn", "lineOut"] as const;
export type LineStep = (typeof LINE_STEPS)[number];
export const isLineStep = (id: string | null | undefined): id is LineStep => id === "lineIn" || id === "lineOut";

/** Where the line sits: left of the step a text arrives at, right of the one that texts them. */
const ANCHOR: Record<LineStep, { at: string; dx: number }> = { lineIn: { at: "text", dx: -240 }, lineOut: { at: "send", dx: 240 } };

/** "Photon line in": the line's name as the gateway gave it, else just "Line". */
export function lineLabel(id: LineStep): string {
  const name = sandbox.line?.name?.trim();
  const who = name ? name[0].toUpperCase() + name.slice(1) + " line" : "Line";
  return `${who} ${id === "lineIn" ? "in" : "out"}`;
}

/**
 * The line's two pseudo-steps for this graph, placed beside their anchors, while a test chat is open; none otherwise,
 * or where a draft has no step to hang one on. Built fresh on each call: nothing here is ever part of the graph.
 */
export function lineNodes(g: LabGraph): LabNode[] {
  if (!sandbox.id) return [];
  const out: LabNode[] = [];
  for (const id of LINE_STEPS) {
    const a = g.nodes.find((n) => n.id === ANCHOR[id].at);
    if (!a) continue;
    out.push({ id, label: lineLabel(id), goal: "", log: true, on: true, rounds: 1, out: 0, ctx: [], ms: 0, timeoutS: 0, areas: [], file: "", note: "", icon: "plug", model: "code", x: a.x + ANCHOR[id].dx, y: a.y });
  }
  return out;
}

/**
 * What the canvas traces: a real end-to-end test (core, jobs, pipeline
 * replays) or a message you type. Its path is read from its words. Ported from
 * the artifact's `readTrace` / `buildTraces`.
 */
import { TRACE_GROUPS } from "../data/areas";
import type { LabCase } from "../types";
import { lab } from "./state";

export type Trace = { name: string; group: string; id?: string; tags: string[]; rounds: Record<string, number> };

export function readTrace(text: string, area: string): { tags: string[]; rounds: Record<string, number> } {
  const t = String(text || "").toLowerCase();
  const one = /group/.test(t) ? "group" : "one";
  if (area === "jobs" || /\b(in the background|make (me )?a page|research|book|order)\b/.test(t)) return { tags: ["job", "action", "one"], rounds: { fd: 1 } };
  if (/\b(e-?mail|gmail|inbox)\b/.test(t)) return { tags: ["email", "action", one], rounds: { fd: 3 } };
  if (/\b(my week|this week|places|near me|options|schedule|calendar)\b/.test(t)) return { tags: ["card", "action", one], rounds: { fd: 3 } };
  if (/\b(should i|what do you think|help me decide)\b/.test(t)) return { tags: ["stuck", "action", one], rounds: { fd: 2 } };
  if (/\?|\b(when|what|where|who|find|look up|how many|remind)\b/.test(t)) return { tags: ["lookup", "action", one], rounds: { fd: 3 } };
  return { tags: ["plain", one], rounds: { fd: 2 } };
}

export const SCENARIOS: Record<string, Trace> = {};

export function buildTraces(list: LabCase[]) {
  for (const k in SCENARIOS) delete SCENARIOS[k];
  const order = Object.keys(TRACE_GROUPS);
  for (const c of [...list].sort((a, b) => order.indexOf(a.area) - order.indexOf(b.area)))
    if ((TRACE_GROUPS as Record<string, string>)[c.area]) {
      const path = String(c.path ?? "");
      const text = c.area === "pipeline" ? path + " " + (c.ask || "") : c.ask || "";
      SCENARIOS[c.area + "/" + c.id] = { name: c.area === "pipeline" ? path || c.id : c.ask || String(c.title ?? "") || c.id, group: c.area, id: c.id, ...readTrace(text, c.area) };
    }
  SCENARIOS.own = { name: lab.ownText || "Type a message…", group: "own", ...readTrace(lab.ownText, "own") };
  if (!SCENARIOS[lab.scn]) lab.scn = Object.keys(SCENARIOS)[0] || "own";
}

export const scnLabel = (k: string) => (SCENARIOS[k] || SCENARIOS.own)?.name ?? "";

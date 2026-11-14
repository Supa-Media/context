/**
 * What the canvas traces: a real end-to-end test (core, jobs, pipeline
 * replays) or a message you type. Its path is read from its words. Ported from
 * the artifact's `readTrace` / `buildTraces`.
 */
import { TRACE_GROUPS } from "../data/areas";
import type { LabCase } from "../types";
import { allCases } from "./diff";
import { lab } from "./state";

/** `from`: the step that starts it, a text arriving unless a check-in, a routine or another AI's ping (`texConfig.json` inputs). */
export type Trace = { name: string; group: string; id?: string; tags: string[]; rounds: Record<string, number>; from?: string };

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
  const own = readTrace(lab.ownText, "own");
  // A text from one of their group chats takes the group path, whatever its words say.
  if ((lab.tester === "me" || lab.mode === "replay") && lab.myChat !== "me") own.tags = own.tags.map((t) => (t === "one" ? "group" : t));
  SCENARIOS.own = { name: lab.ownText || "Type a message…", group: "own", ...own, from: lab.ownFrom };
  if (!SCENARIOS[lab.scn]) lab.scn = Object.keys(SCENARIOS)[0] || "own";
}

export const scnLabel = (k: string) => (SCENARIOS[k] || SCENARIOS.own)?.name ?? "";

/**
 * Trace one of the person's own texts (the test user is You): it becomes the typed message, so the canvas's picker
 * and its label show what they actually sent rather than a bench test (Dev2, 2026-11-14: "When I switched to my
 * personal account, I expected to see the messages I've sent here not test cases").
 */
export function traceMine(text: string, from = "text") {
  if (lab.real?.text !== text) lab.real = null;
  lab.ownText = text;
  lab.ownFrom = from;
  buildTraces(allCases());
  lab.scn = "own";
}

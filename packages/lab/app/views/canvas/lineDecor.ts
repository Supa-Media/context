/**
 * The test chat's line on the canvas (`engine/lineSteps.ts`): two dashed pseudo-steps, "<line> line in" left of "A
 * text arrives" and "<line> line out" right of "Text them", each with a dashed wire to its step, lit and timed from the
 * text's `lineIn` / `lineOut` steps, as the approved Lab live sandbox mockup draws them. They are decorations: drawn
 * beside the graph's own markup, never part of it, carrying `data-line` (not `data-id`), so they cannot be moved, wired,
 * focused or deleted; a click picks the step to show what the line did in Run details.
 */
import { isLineStep, lineAnchor, lineNodes, type LineStep } from "../../engine/lineSteps";
import { ICONS } from "../../data/graph";
import type { LabGraph, LabNode, Selection } from "../../types";
import { msWords } from "../grid/TextGrid.web";
import { esc, H, W, wirePath } from "./render";

type LineLit = string | ReadonlySet<string> | ReadonlyMap<string, number> | null;

/** How long each line step took in a text's steps, summed, where it ran. */
export function lineTimes(steps: ReadonlyArray<{ node: string; ms?: number | null }> | undefined): Partial<Record<LineStep, number>> {
  const out: Partial<Record<LineStep, number>> = {};
  for (const s of steps ?? []) if (isLineStep(s.node) && typeof s.ms === "number") out[s.node] = (out[s.node] ?? 0) + s.ms;
  return out;
}

/** The line's dashed wires (drawn under the graph) and its two pseudo-steps (drawn over it); empty with no test chat. */
export function lineDecorHtml(g: LabGraph, sel: Selection, lit: LineLit, times: Partial<Record<LineStep, number>> = {}): { under: string; over: string } {
  const ls = lineNodes(g);
  if (!ls.length) return { under: "", over: "" };
  const has = (id: string) => (typeof lit === "string" ? lit === id : !!lit?.has(id));
  const p = (id: string) => (lit instanceof Map ? (lit.get(id) ?? null) : null);
  let under = "";
  let over = "";
  for (const n of ls) {
    const anchor = lineAnchor(g, n.id as LineStep) as LabNode;
    const w = n.id === "lineIn" ? wirePath(n, anchor, "wait") : wirePath(anchor, n, "wait");
    under += `<path class="wire lnw${has(n.id) ? "" : " dim"}" d="${w.d}" stroke="var(--dim)" stroke-dasharray="4 3" fill="none"/>`;
    const s = sel?.t === "node" && sel.id === n.id;
    const state = has(n.id) ? (p(n.id) !== null && p(n.id)! < 1 ? " lit run" : p(n.id) === 1 ? " lit done" : " lit") : "";
    const ms = times[n.id as LineStep];
    over += `<g class="nd line${s ? " sel" : ""}${state}" data-line="${n.id}" role="button" aria-label="${esc(n.label)}" transform="translate(${n.x},${n.y})">
      <title>${esc(n.label)}: the test chat's simulated line, not a step of Tex</title><rect class="card" width="${W}" height="${H}" rx="12"/>
      <rect x="10" y="12" width="40" height="40" rx="10" fill="var(--s3)"/>
      <g transform="translate(18,20)" style="color:var(--dim)"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[n.icon] || ICONS.code}</svg></g>
      <text class="ttl" x="62" y="28">${esc(n.label.length > 15 ? n.label.slice(0, 14) + "…" : n.label)}</text>
      <circle cx="66" cy="43" r="3.5" fill="var(--dim)"/><text class="sub" x="74" y="47">sandbox line</text>
      ${ms !== undefined ? `<text class="tm" x="${W - 4}" y="-7" text-anchor="end">${esc(msWords(ms))}</text>` : ""}
    </g>`;
  }
  return { under, over };
}

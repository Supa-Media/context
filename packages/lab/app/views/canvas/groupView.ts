/**
 * A group open on its own (mockup 5y8sZpxqRYNZEdqqXTjq6J v3, Dev2 2026-11-16: "when I click focus on a group, I want
 * it to open just that group"): only its steps and the cards of the groups inside it, in a dashed violet frame titled
 * with the group's name and goal. A wire that leaves the group ends in a dashed pill at the frame's edge, "from" on the
 * left and "to" on the right, naming the thing outside as the canvas draws it (a step, or a group's card with ⤢);
 * clicking a pill goes there (`data-gport`, `useStageInput.web.ts`).
 *
 * A wire out to a component (`components.ts`; Dev2, 2026-11-26) is not a pill: it is a dashed teal reference card in a
 * row under the group's steps, below the step that calls it ("◇ Jobs · 2 uses ⤢"), with a short wire down from that
 * step. One card per step and component, whatever kinds of wire join them; clicking it opens the component.
 *
 * The steps and wires inside are drawn by the canvas's own `renderGraphHtml`, so picking, moving, wiring, running
 * rings, change marks and case chips work as on the whole graph. Pure strings and numbers.
 */
import { ICONS, WIRES } from "../../data/graph";
import { boxOf, groupParts, type GroupPort } from "../../engine/groupLayout";
import type { GroupDefs } from "../../engine/groups";
import type { Sim } from "../../engine/sim";
import type { LabGraph, Selection } from "../../types";
import type { Marks } from "../../engine/changeMarks";
import { componentUses, isComponent } from "../../engine/components";
import { esc, H, renderGraphHtml, W, type Bounds } from "./render";
import { CARD_DX, CARD_W } from "./groupCard";

const PAD = 48;
const TOP = 76;
const PW = 168;
const PH = 40;
const PGAP = 24;
const SIDE = 70;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

type Draw = {
  tags: string[];
  sel: Selection;
  lit: string | ReadonlySet<string> | ReadonlyMap<string, number> | null;
  counts: Record<string, number> | null;
  marks: Marks | null;
};

const RH = 40;
const RGAP = 30;

export function renderGroupFocusHtml(g: LabGraph, sim: Sim, id: string, groups: GroupDefs, d: Draw): { html: string; fBounds: Bounds } {
  const parts = groupParts(g, id, groups);
  const { items, ins } = parts;
  const outs = parts.outs.filter((p) => !isComponent(groups, p.other));
  const refs: GroupPort[] = [];
  for (const p of parts.outs) if (isComponent(groups, p.other) && !refs.some((r) => r.item === p.item && r.other === p.other)) refs.push(p);
  const info = groups[id] ?? { label: id };
  const boxes = items.map((n) => boxOf(g, n));
  const x0 = boxes.length ? Math.min(...boxes.map((b) => b.x)) : 0;
  const y0 = boxes.length ? Math.min(...boxes.map((b) => b.y)) : 0;
  const x1 = boxes.length ? Math.max(...boxes.map((b) => b.x + b.w)) : W;
  const yb = boxes.length ? Math.max(...boxes.map((b) => b.y + b.h)) : H;
  // The reference cards' row sits under the steps, inside the frame.
  const ry = yb + RGAP;
  const y1 = refs.length ? ry + RH : yb;
  const fx = x0 - PAD,
    fy = y0 - TOP,
    fw = Math.max(x1 - x0 + PAD * 2, 360),
    fh = y1 - y0 + TOP + PAD;
  const at = new Map(items.map((n) => [n.id, n] as const));
  const leftOf = (id: string) => {
    const n = at.get(id)!;
    return { x: g.folded?.[id] ? n.x + CARD_DX : n.x, y: n.y + H / 2 };
  };
  const rightOf = (id: string) => {
    const n = at.get(id)!;
    return { x: g.folded?.[id] ? n.x + CARD_DX + CARD_W : n.x + W, y: n.y + H / 2 };
  };
  const midY = (y0 + y1) / 2;

  let under = `<rect class="gframe" x="${fx}" y="${fy}" width="${fw}" height="${fh}" rx="16"/>
    <g transform="translate(${fx + 16},${fy + 17})" class="gico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[info.icon ?? "code"] || ICONS.code}</svg></g>
    <text class="gft" x="${fx + 44}" y="${fy + 30}">${esc(info.label)}</text>
    <text class="gfg" x="${fx + 44}" y="${fy + 50}">${esc(clip(info.goal ?? "", Math.max(40, Math.floor(fw / 6.6) - 10)))}<title>${esc(info.goal ?? "")}</title></text>`;
  let over = "";
  const ys: number[] = [fy, fy + fh];
  const wire = (a: { x: number; y: number }, b: { x: number; y: number }, mode: string) => {
    const w = WIRES[mode] || WIRES.wait;
    const mx = (a.x + b.x) / 2;
    return `<path class="wire" d="M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}" stroke="var(${w.c})" ${w.dash ? `stroke-dasharray="${w.dash}"` : ""} ${w.w ? `stroke-width="${w.w}"` : ""} fill="none" marker-end="url(#m-${mode})"/>`;
  };
  const pill = (p: GroupPort, x: number, y: number, dir: "in" | "out") => {
    const o = g.nodes.find((n) => n.id === p.other);
    const isBox = !!g.folded?.[p.other];
    const kind = p.when.length && !p.when.includes("*") ? p.when.join(", ") : (WIRES[p.mode]?.name ?? p.mode).toLowerCase();
    return `<g class="gport" data-gport="${esc(p.other)}" transform="translate(${x},${y})"><title>${dir === "in" ? "From" : "To"} ${esc(o?.label ?? p.other)}: go there</title><rect width="${PW}" height="${PH}" rx="20"/><text class="k" x="16" y="16">${dir === "in" ? "from" : "to"} · ${esc(clip(kind, 18))}</text><text x="16" y="31">${esc(clip(o?.label ?? p.other, 20))}${isBox ? "  ⤢" : ""}</text></g>`;
  };
  const column = (list: GroupPort[], x: number, dir: "in" | "out") =>
    list.forEach((p, i) => {
      const y = Math.round(midY + (i - (list.length - 1) / 2) * (PH + PGAP) - PH / 2);
      ys.push(y, y + PH);
      over += pill(p, x, y, dir);
      under += dir === "in" ? wire({ x: x + PW, y: y + PH / 2 }, { x: leftOf(p.item).x - 2, y: leftOf(p.item).y }, p.mode) : wire(rightOf(p.item), { x: x - 2, y: y + PH / 2 }, p.mode);
    });
  // Reference cards: under their step, moved right past the card before them when two would overlap.
  if (refs.length) {
    const uses = componentUses(g, groups);
    const placed: number[] = [];
    for (const p of [...refs].sort((a, b) => leftOf(a.item).x - leftOf(b.item).x)) {
      const n = at.get(p.item)!;
      const box = boxOf(g, n);
      let x = box.x;
      for (const px of placed) if (x < px + W + 12) x = px + W + 12;
      placed.push(x);
      const o = g.nodes.find((m) => m.id === p.other);
      const count = uses[p.other]?.length ?? 0;
      const from = { x: box.x + box.w / 2, y: box.y + box.h };
      under += `<path class="wire" d="M${from.x},${from.y} C${from.x},${ry - 8} ${x + W / 2},${from.y + 8} ${x + W / 2},${ry - 2}" stroke="var(--comp)" stroke-dasharray="4 4" fill="none"/>`;
      over += `<g class="gref" data-gport="${esc(p.other)}" transform="translate(${x},${ry})"><title>${esc(o?.label ?? p.other)}, a component used in ${count} place${count === 1 ? "" : "s"}: open it</title><rect width="${W}" height="${RH}" rx="10"/><text x="14" y="25">◇ ${esc(clip(o?.label ?? p.other, 14))} · ${count} use${count === 1 ? "" : "s"}  ⤢</text></g>`;
    }
  }
  const inX = fx - SIDE - PW,
    outX = fx + fw + SIDE;
  column(ins, inX, "in");
  column(outs, outX, "out");

  const inner = renderGraphHtml(g, sim, d.tags, d.sel, d.lit, "off", d.counts, d.marks, { only: new Set(items.map((n) => n.id)), groups, group: id });
  return {
    html: under + inner + over,
    fBounds: { x0: (ins.length ? inX : fx) - 20, x1: (outs.length ? outX + PW : fx + fw) + 20, y0: Math.min(...ys) - 20, y1: Math.max(...ys) + 20 },
  };
}

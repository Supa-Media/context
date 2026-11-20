/**
 * A folded group's card on the canvas (mockup 5y8sZpxqRYNZEdqqXTjq6J v3, Dev2 2026-11-16: "I feel like we need a
 * different UI for groups of things"; "stack not necessary, keep it flat"). One flat card, wider and taller than a
 * step, with a violet edge: the group's icon and name, the models inside, how many steps it holds (and groups, when it
 * holds some), the first two step names, and an open button (⤢, `data-gopen`) at its top-right. Double-clicking it
 * opens it too, as any focus does.
 *
 * The card is drawn around the box's place (the box keeps the step's place and size for wires and fitting): CARD_DX and
 * CARD_DY above and left of it. Pure strings; the canvas sets them as innerHTML.
 */
import { ICONS } from "../../data/graph";
import type { GroupDefs } from "../../engine/groups";
import type { LabModel, LabNode } from "../../types";

export const CARD_W = 204;
export const CARD_H = 92;
export const CARD_DX = -12;
export const CARD_DY = -14;

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export type CardState = {
  /** The classes the canvas gives any step: sel, dim, off, lit, run, done, change marks. */
  cls: string;
  /** The time over it, as the canvas writes a step's ("" for none). */
  time: string;
  /** A change mark's yellow outline. */
  changed: boolean;
};

/** The words of the card's third line: "7 steps · 1 group · Triage · Decide +3". */
export function cardCounts(members: LabNode[], kids: number): { count: string; names: string } {
  const names = members.filter((m) => m.kind !== "input").map((m) => m.label);
  const shown = names.slice(0, 2).map((s) => clip(s, 11)).join(" · ") + (names.length > 2 ? `  +${names.length - 2}` : "");
  const count = `${members.length} step${members.length === 1 ? "" : "s"}${kids ? ` · ${kids} group${kids === 1 ? "" : "s"}` : ""}`;
  // The line holds about 31 characters inside the card, the dot between included; the names give way to the count.
  return { count, names: clip(shown, Math.max(0, 26 - count.length)) };
}

/** The card for box `n`, which holds `members` (every step folded into it, nested groups' too). */
export function groupCardHtml(n: LabNode, members: LabNode[], groups: GroupDefs, models: Record<string, LabModel | undefined>, st: CardState): string {
  const kids = Object.values(groups).filter((d) => d?.parent === n.id).length;
  const { count, names } = cardCounts(members, kids);
  const keys = [...new Set(members.map((m) => m.model))];
  let mx = 48;
  const dots =
    keys
      .slice(0, 2)
      .map((k) => {
        const m = models[k] ?? models.code;
        const name = m?.runs === "code" ? "Code" : (m?.name ?? k);
        const s = `<circle cx="${mx + 4}" cy="33" r="3.5" fill="var(${m?.c ?? "--dim"})"/><text class="sub" x="${mx + 12}" y="37">${esc(name)}</text>`;
        mx += 20 + name.length * 6.4;
        return s;
      })
      .join("") + (keys.length > 2 ? `<text class="sub" x="${mx}" y="37">+${keys.length - 2}</text>` : "");
  const x0 = CARD_DX, y0 = CARD_DY;
  return `<g class="nd grp ${st.cls}" data-id="${esc(n.id)}" transform="translate(${n.x},${n.y})">
      ${st.changed ? `<rect class="chgo" x="${x0 - 4}" y="${y0 - 4}" width="${CARD_W + 8}" height="${CARD_H + 8}" rx="15"/>` : ""}<rect class="card gcard" x="${x0}" y="${y0}" width="${CARD_W}" height="${CARD_H}" rx="12"/>
      <rect class="gib" x="${x0 + 12}" y="${y0 + 14}" width="36" height="36" rx="8"/>
      <g transform="translate(${x0 + 19},${y0 + 21})" class="gico"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[n.icon] || ICONS.code}</svg></g>
      <text class="ttl" x="${x0 + 60}" y="${y0 + 31}">${esc(clip(n.label, 16))}</text>
      ${dots}
      <text class="gch" x="${x0 + 14}" y="${y0 + 78}"><tspan class="n">${esc(count)}</tspan>  ·  ${esc(names)}</text>
      <g class="gopen" data-gopen="${esc(n.id)}" transform="translate(${x0 + CARD_W - 32},${y0 + 10})"><title>Open this group</title><rect width="22" height="22" rx="6"/><path d="M12.4 5.7h4v4M9.6 16.3h-4v-4M16.4 5.7l-4.7 4.7M5.6 16.3l4.7-4.7" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></g>
      ${st.time ? `<text class="tm" x="${x0 + CARD_W - 4}" y="${y0 - 7}" text-anchor="end">${st.time}</text>` : ""}
      <circle class="port" data-port="${esc(n.id)}" cx="${x0 + CARD_W}" cy="32" r="6"/>
      <circle class="port" data-port="${esc(n.id)}" cx="${x0}" cy="32" r="6"/>
    </g>`;
}

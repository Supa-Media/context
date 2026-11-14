/**
 * The console's building blocks, the artifact's own functions ported one for one: each returns
 * the HTML the artifact drew, with the same classes, so `consoleCss.ts` styles it unchanged.
 * Pages build their HTML from these and say what a click does with `data-act` (see `types.ts`).
 *
 * Everything a person or the database wrote goes through `esc`. A page never puts a value into
 * HTML any other way.
 */
import { IC } from "./icons";
import { S, days, store } from "./state";

export { days };

export const ic = (k: string, cls = "i") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${IC[k] || ""}</svg>`;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
export const money = (n: number, d = 2) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const plural = (n: number, a: string, b: string) => n + " " + (n === 1 ? a : b);
export const delta = (v: number, good = true, unit = "") => `<span class="${v >= 0 === good ? "up" : "dn"}">${v >= 0 ? "+" : ""}${v}${unit}</span>`;
export const REPLAY = '<a class="link" href="https://context.lc/lab" target="_blank" rel="noopener">Open in Replay ↗</a>';

/** Panels people folded stay folded, in this browser. */
export const shut = new Set<string>(store.get("shut", ["usage-pages", "usage-buttons", "costs-model", "turns-models"]));
export function panel(key: string, title: string, meta: string, body: string, acts = "") {
  const s = shut.has(key);
  return `<section class="pn${s ? " shut" : ""}"><div class="pnh"><button class="tg" data-act="pn" data-k="${key}" aria-expanded="${!s}">${ic("car", "i car")}<span>${title}</span></button>${meta ? `<span class="meta">${meta}</span>` : ""}${acts ? `<span class="acts">${acts}</span>` : ""}</div><div class="pnb">${body}</div></section>`;
}

/** A number tile. With `attrs` it is a button (a `data-act` that goes somewhere, or `aria-pressed` for a filter). */
export const kpi = (l: string, v: string | number, d = "", attrs = "", sp = "") =>
  `<${attrs ? "button" : "div"} class="kpi" ${attrs}><div class="l">${l}${attrs && !/aria-pressed/.test(attrs) ? ic("next") : attrs ? ic("filter") : ""}</div><div class="v">${v}</div>${d ? `<div class="d">${d}</div>` : ""}${sp ? `<div class="sp">${sp}</div>` : ""}</${attrs ? "button" : "div"}>`;

/** Tones: '' (plain), ok, warn, bad, acc, team. */
export const pill = (t: string, tone = "") => `<span class="pill ${tone}">${esc(t)}</span>`;
export const sw = (on: boolean, act: string, id: string, label = "") => `<button class="sw" role="switch" aria-checked="${!!on}" aria-label="${esc(label)}" data-act="${act}" data-id="${esc(id)}"></button>`;
/** Options are [value, label, count?]; a click calls `act` with `data-v`. */
export const seg = (name: string, opts: Array<[string, string, (number | string | null)?]>, cur: string, act: string) =>
  `<div class="seg" role="group" aria-label="${name}">${opts.map(([v, l, n]) => `<button aria-pressed="${v === cur}" data-act="${act}" data-v="${v}">${l}${n != null ? ` <span class="n">${n}</span>` : ""}</button>`).join("")}</div>`;
/** One confirm pattern everywhere: a sentence, the action, Cancel (`data-act="cancel"` is the shell's). */
export const confirmBox = (q: string, label: string, act: string, id?: string, danger = false) =>
  `<span class="confirm">${q} <button class="primary${danger ? " danger" : ""}" data-act="${act}" data-id="${esc(id || "")}">${label}</button><button class="ghost" data-act="cancel">Cancel</button></span>`;

export const lgOpen: Record<string, boolean> = store.get("lg", {});
export function legend(key: string, items: Array<[string, string]>) {
  const o = lgOpen[key] !== false;
  return `<div><button class="lgt" data-act="lg" data-k="${key}" aria-expanded="${o}">${ic("car", "i car")}Key</button>${o ? `<div class="legend">${items.map(([c, l]) => `<span><i style="background:var(--${c})"></i>${esc(l)}</span>`).join("")}</div>` : ""}</div>`;
}

/** A hover-or-tap popover: `label` shows in the cell, `body` opens over it (`.pop`/`.pb`). */
export const pop = (label: string, body: string, aria: string) => `<span class="pop"><button class="link" aria-label="${esc(aria)}">${label}</button><span class="pb" role="tooltip">${body}</span></span>`;

export function nice(mx: number) {
  if (mx <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(mx)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= mx) return m * p;
  return 10 * p;
}
export const xLab = (n: number) => (S.d === "1" ? ["24h ago", "12h", "now"] : [`${n}d ago`, `${Math.round(n / 2)}d`, "today"]);

type Fmt = (v: number) => string | number;
export function bars(vals: number[], { h = 120, color = "c1", stack = null, fmt = (v) => v }: { h?: number; color?: string; stack?: Array<{ v: number[]; c: string }> | null; fmt?: Fmt } = {}) {
  const W = 640,
    P = 34,
    n = (stack ? stack[0].v : vals).length,
    bw = (W - P) / n;
  const tot = stack ? stack[0].v.map((_, i) => stack.reduce((a, s) => a + s.v[i], 0)) : vals;
  const mx = nice(Math.max(...tot));
  let g = `<line class="grid" x1="${P}" x2="${W}" y1="${h}" y2="${h}"/><line class="grid" x1="${P}" x2="${W}" y1="${h / 2}" y2="${h / 2}"/><line class="grid" x1="${P}" x2="${W}" y1="0" y2="0"/><text x="${P - 6}" y="4" text-anchor="end">${fmt(mx)}</text><text x="${P - 6}" y="${h / 2 + 4}" text-anchor="end">${fmt(mx / 2)}</text><text x="${P - 6}" y="${h + 4}" text-anchor="end">0</text>`;
  for (let i = 0; i < n; i++) {
    let y = h;
    (stack || [{ v: vals, c: color }]).forEach((s) => {
      const bh = (s.v[i] / mx) * h;
      y -= bh;
      g += `<rect x="${P + i * bw + bw * 0.15}" y="${y}" width="${Math.max(1, bw * 0.7)}" height="${bh}" rx="1.5" fill="var(--${s.c})"><title>${fmt(s.v[i])}</title></rect>`;
    });
  }
  const L = xLab(n);
  g += `<text x="${P}" y="${h + 18}">${L[0]}</text><text x="${P + (W - P) / 2}" y="${h + 18}" text-anchor="middle">${L[1]}</text><text x="${W}" y="${h + 18}" text-anchor="end">${L[2]}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${h + 24}" role="img">${g}</svg>`;
}

export function lines(ls: Array<{ v: number[]; c: string; area?: boolean }>, { h = 120, fmt = (v) => v, lo = 0, xl = null }: { h?: number; fmt?: Fmt; lo?: number; xl?: string[] | null } = {}) {
  const W = 640,
    P = 40,
    n = ls[0].v.length;
  const hi = nice(Math.max(...ls.flatMap((l) => l.v)));
  const x = (i: number) => P + (i * (W - P)) / Math.max(1, n - 1),
    y = (v: number) => h - ((v - lo) / (hi - lo || 1)) * h;
  let g = `<line class="grid" x1="${P}" x2="${W}" y1="${h}" y2="${h}"/><line class="grid" x1="${P}" x2="${W}" y1="${h / 2}" y2="${h / 2}"/><line class="grid" x1="${P}" x2="${W}" y1="0" y2="0"/><text x="${P - 6}" y="4" text-anchor="end">${fmt(hi)}</text><text x="${P - 6}" y="${h / 2 + 4}" text-anchor="end">${fmt(Math.round(((lo + hi) / 2) * 10) / 10)}</text><text x="${P - 6}" y="${h + 4}" text-anchor="end">${fmt(lo)}</text>`;
  ls.forEach((l) => {
    const d = l.v.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join(" ");
    if (l.area) g += `<path d="${d} L${x(n - 1)} ${h} L${P} ${h}Z" fill="var(--${l.c})" opacity=".12"/>`;
    g += `<path d="${d}" fill="none" stroke="var(--${l.c})" stroke-width="2" stroke-linejoin="round"/><circle cx="${x(n - 1)}" cy="${y(l.v[n - 1])}" r="3.5" fill="var(--${l.c})"/>`;
  });
  const L = xl || xLab(n);
  g += `<text x="${P}" y="${h + 18}">${L[0]}</text><text x="${W}" y="${h + 18}" text-anchor="end">${L[L.length - 1]}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${h + 24}" role="img">${g}</svg>`;
}

export function spark(v: number[], c = "c1", W = 90, H = 22) {
  const mx = Math.max(...v, 1),
    mn = Math.min(...v);
  const d = v.map((x, i) => (i ? "L" : "M") + ((i * W) / Math.max(1, v.length - 1)).toFixed(1) + " " + (H - 2 - ((x - mn) / (mx - mn || 1)) * (H - 4)).toFixed(1)).join(" ");
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="overflow:visible;display:block" aria-hidden="true"><path d="${d}" fill="none" stroke="var(--${c})" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}

/** Chart text is drawn in viewBox units; this keeps it at 11px whatever width the chart ends up. */
export function fitCharts(root: ParentNode) {
  root.querySelectorAll("svg.chart").forEach((s) => {
    const k = 640 / ((s as SVGElement).clientWidth || 640);
    s.querySelectorAll("text").forEach((t) => t.setAttribute("font-size", (11 * k).toFixed(1)));
  });
}

/** A person: their initial, name, and the line under it (the artifact shows @handle, else email, else phone). */
export const who = (name: string, line: string) =>
  `<span class="who"><span class="av">${esc((name || "?")[0])}</span><span style="min-width:0"><span class="nm">${esc(name)}</span><div class="sub">${esc(line)}</div></span></span>`;
/** @handle, else email, else phone (Dev2, 2026-11-14). */
export const handleLine = (p: { handle?: string | null; email?: string | null; phone?: string | null }) => (p.handle ? "@" + p.handle : p.email || p.phone || "");

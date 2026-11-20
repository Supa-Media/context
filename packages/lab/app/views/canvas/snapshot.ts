/**
 * The Lab's canvas as one still page, for `tex_dev snapshot` (`apps/mcp/src/texDev/snapshot.js`): a graph in, the
 * HTML of a page that looks like the Lab's own canvas out, drawn by the same functions the Lab draws with
 * (`render.ts`) and styled by the Lab's own stylesheet (`labCss.ts`). The gateway cannot import TypeScript, so
 * `scripts/tex-dev-canvas.mjs` bundles this file into `apps/mcp/src/texDev/canvas.generated.js`; CI rebuilds it and
 * fails when the committed copy differs, so the gateway's drawing can never drift from the Lab's.
 *
 * Pure strings and numbers, no DOM. The Lab's step lookups read its one state (`engine/state.ts`), so each drawing
 * puts the graph there for the length of the call and puts the old one back.
 */
import { groupsOf } from "../../data/graph";
import { foldAround, groupChain, isGroupFocus, unfoldGroups, type GroupDefs } from "../../engine/groups";
import { laidOut } from "../../engine/groupLayout";
import type { Sim } from "../../engine/sim";
import { lab, node } from "../../engine/state";
import { LAB_CSS } from "../../labCss";
import type { LabEdge, LabGraph, LabNode } from "../../types";
import { renderGroupFocusHtml } from "./groupView";
import { esc, H, renderFocusCanvasHtml, renderGraphHtml, statsHtml, W, type Bounds } from "./render";

export type SnapshotOptions = {
  /** A step id or a group id to draw focused, as the Lab's Focus does; the whole graph, groups folded, when null. */
  focus?: string | null;
  /** Another graph (main): steps that differ from it, and steps it lacks, are marked. */
  base?: LabGraph | null;
  theme?: "dark" | "light";
  /** The page's width in pixels; its height follows from the drawing. */
  width?: number;
  /**
   * A test traced on the canvas, as the Lab's picker traces one: given the graph as drawn (groups folded, the focus
   * open), its simulation and its name. Each step then carries its time and its split bar, and the stats chip shows
   * the reply time, the calls and the cost, exactly as the Lab's canvas does; without it nothing is timed.
   */
  sim?: ((shown: LabGraph) => { sim: Sim; name: string }) | null;
};

export type Snapshot = { html: string; width: number; height: number };

/** The size the picture renderer accepts (`infra/site-shots/src/render.ts`). */
export const MIN_SIDE = 200;
export const MAX_WIDTH = 2000;
export const MAX_HEIGHT = 2400;
const CAPTION = 44;

const NO_SIM: Sim = { T: {}, reply: 0, usd: 0, replyCalls: 0, jobEnd: 0, reach: new Map(), inside: new Set() };
const FONTS = "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@500&display=block";

/** A value as text with its keys in order, so two nodes that hold the same fields compare equal however they were written. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object")
    return "{" + Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canon((v as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(v) ?? "null";
}
/** Where a step sits is not what it does, so moving it is not a change. */
const sameStep = (a: LabNode, b: LabNode) => canon({ ...a, x: 0, y: 0 }) === canon({ ...b, x: 0, y: 0 });
const wireKey = (e: LabEdge) => [e.from, e.to, e.mode, [...(e.when ?? [])].sort().join(",")].join("|");

export type Marks = { changed: Set<string>; added: Set<string>; removed: LabNode[]; wiresAdded: number; wiresRemoved: number };

/** What `graph` changes against `base`, step by step, on the config's own steps (groups opened). */
export function marksAgainst(graph: LabGraph, base: LabGraph): Marks {
  const mine = unfoldGroups(graph);
  const theirs = unfoldGroups(base);
  const was = new Map(theirs.nodes.map((n) => [n.id, n]));
  const now = new Set(mine.nodes.map((n) => n.id));
  const changed = new Set<string>();
  const added = new Set<string>();
  for (const n of mine.nodes) {
    const old = was.get(n.id);
    if (!old) added.add(n.id);
    else if (!sameStep(n, old)) changed.add(n.id);
  }
  const wasWires = new Set(theirs.edges.map(wireKey));
  const nowWires = new Set(mine.edges.map(wireKey));
  return {
    changed,
    added,
    removed: theirs.nodes.filter((n) => !now.has(n.id)),
    wiresAdded: [...nowWires].filter((k) => !wasWires.has(k)).length,
    wiresRemoved: [...wasWires].filter((k) => !nowWires.has(k)).length,
  };
}

const count = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** Each marked step's ring and tag, drawn over the canvas where `html` placed that step. */
function markOverlay(html: string, kindOf: (id: string) => "new" | "changed" | null): string {
  let out = "";
  for (const m of html.matchAll(/<g class="nd [^"]*" data-id="([^"]*)" transform="translate\((-?[\d.]+),(-?[\d.]+)\)"/g)) {
    const id = m[1].replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
    const kind = kindOf(id);
    if (!kind) continue;
    const c = kind === "new" ? "--ok" : "--warn";
    const w = kind === "new" ? 34 : 60;
    out += `<g class="mark ${kind}" transform="translate(${m[2]},${m[3]})" pointer-events="none"><rect x="-4" y="-4" width="${W + 8}" height="${H + 8}" rx="15" fill="none" stroke="var(${c})" stroke-width="3"/><rect x="10" y="${H - 8}" width="${w}" height="17" rx="8.5" fill="var(${c})"/><text x="${10 + w / 2}" y="${H + 4.5}" text-anchor="middle" font-size="11" font-weight="600" fill="var(--page)">${kind}</text></g>`;
  }
  return out;
}

function checked(graph: unknown): LabGraph {
  const g = graph as LabGraph | null;
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error("That graph has no steps or wires to draw.");
  for (const n of g.nodes) if (!n || typeof n.id !== "string" || typeof n.x !== "number" || typeof n.y !== "number") throw new Error("A step in that graph has no id or place.");
  return g;
}

/** Runs `fn` with `graph` as the Lab's working graph, the way the artifact's globals read it, and puts the old one back. */
function withGraph<T>(graph: LabGraph, fn: () => T): T {
  const before = lab.cur;
  lab.cur = { ...before, graph };
  try {
    return fn();
  } finally {
    lab.cur = before;
  }
}

/** The focus bar's path for a caption: each group around, then the focus ("Tools & subagents / Checks"). */
function path(groups: GroupDefs, id: string, inside?: string): string {
  const chain = groupChain(groups, inside ?? id);
  const names = [...chain].reverse().map((g) => groups[g]?.label ?? g);
  return (inside ? [...names, id] : names).join(" / ");
}

/** The page for one drawing. Throws a plain sentence when the graph or the focus cannot be drawn. */
export function snapshotPage(graph: LabGraph, opts: SnapshotOptions = {}): Snapshot {
  const asked = opts.focus ? String(opts.focus) : null;
  const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_SIDE, opts.width ?? 1600)));
  const open = unfoldGroups(checked(graph));
  const marks = opts.base ? marksAgainst(open, checked(opts.base)) : null;
  // As the Lab's Focus: a group opens on its own (its steps and the cards of the groups inside it), a step shows its own view.
  const focus = asked;
  const groups = groupsOf(graph);
  let shown = foldAround(open, focus, groups);
  const opened = isGroupFocus(shown, focus, groups);
  if (opened && focus) shown = laidOut(shown, focus, groups);

  return withGraph(shown, () => {
    let html: string;
    let bounds: Bounds;
    let label: string | null = null;
    const traced = opts.sim ? opts.sim(shown) : null;
    const sim = traced?.sim ?? NO_SIM;
    if (focus && !opened) {
      const n = node(focus, shown);
      if (!n) throw new Error(`There is no step or group called "${asked}" in that graph.`);
      const f = renderFocusCanvasHtml(shown, sim, focus, null);
      html = f.html;
      bounds = { ...f.fBounds, y1: f.fBounds.y1 + 24 };
      label = n.group ? path(groups, n.label, n.group) : n.label;
    } else if (opened && focus) {
      const f = renderGroupFocusHtml(shown, sim, focus, groups, { tags: [], sel: null, lit: null, counts: null, marks: null });
      html = f.html;
      bounds = f.fBounds;
      label = path(groups, focus);
    } else {
      // The canvas fades only the steps switched off, whatever is traced (`Canvas.web.tsx`), so the tags change nothing here.
      html = renderGraphHtml(shown, sim, [], null, null, "off", null, null, { groups });
      const xs = shown.nodes.map((n) => n.x);
      const ys = shown.nodes.map((n) => n.y);
      const loops = shown.edges.some((e) => e.mode === "loop");
      bounds = { x0: Math.min(...xs) - 30, x1: Math.max(...xs) + W + 30, y0: Math.min(...ys) - 30, y1: Math.max(...ys) + H + (loops ? 100 : 40) };
    }

    if (marks) {
      const members = (id: string) => (shown.folded?.[id]?.nodes ?? []).map((n) => n.id);
      const kindOf = (id: string): "new" | "changed" | null =>
        marks.added.has(id) ? "new" : marks.changed.has(id) || members(id).some((m) => marks.changed.has(m) || marks.added.has(m)) ? "changed" : null;
      html += markOverlay(html, kindOf);
    }

    const note: string[] = [];
    if (traced) note.push(`<span style="color:var(--text2)">${esc(traced.name.length > 70 ? traced.name.slice(0, 69) + "…" : traced.name)}</span>`);
    if (label) note.push(`<b>${esc(label)}</b>`);
    if (marks) {
      const bits = [
        marks.changed.size ? `<span style="color:var(--warn)">${count(marks.changed.size, "step")} changed</span>` : "",
        marks.added.size ? `<span style="color:var(--ok)">${count(marks.added.size, "new step")}</span>` : "",
        marks.removed.length ? `<span style="color:var(--bad)">removed: ${esc(marks.removed.map((n) => n.label).join(", "))}</span>` : "",
        marks.wiresAdded || marks.wiresRemoved ? `<span style="color:var(--text2)">wires +${marks.wiresAdded} &minus;${marks.wiresRemoved}</span>` : "",
      ].filter(Boolean);
      note.push(bits.length ? bits.join(" &middot; ") : `<span style="color:var(--text2)">no difference from main</span>`);
    }
    const top = note.length ? CAPTION : 0;

    const bw = bounds.x1 - bounds.x0;
    const bh = bounds.y1 - bounds.y0;
    const k = Math.min(1.1, width / bw, (MAX_HEIGHT - top) / bh);
    const height = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_SIDE, bh * k + top)));
    const x = (width - bw * k) / 2 - bounds.x0 * k;
    const y = top + Math.max(0, (height - top - bh * k) / 2) - bounds.y0 * k;
    const cam = `translate(${x.toFixed(2)},${y.toFixed(2)}) scale(${k.toFixed(4)})`;
    const caption =
      (note.length
        ? `<div style="position:absolute;left:16px;top:10px;z-index:2;display:flex;gap:14px;align-items:center;font-size:14px;color:var(--text)">${note.join("")}</div>`
        : "") + (traced ? `<div class="float stats" id="stats" style="z-index:3">${statsHtml(sim)}</div>` : "");

    const page =
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=${width}">` +
      `<link rel="stylesheet" href="${FONTS}"><style>${LAB_CSS}html,body{margin:0;height:100%;overflow:hidden}</style></head>` +
      `<body><div class="tl" data-theme="${opts.theme === "light" ? "light" : "dark"}"><div id="stage">${caption}` +
      `<svg id="svg" aria-label="Tex architecture"><g id="world" transform="${cam}">${html}</g></svg></div></div></body></html>`;
    return { html: page, width, height };
  });
}

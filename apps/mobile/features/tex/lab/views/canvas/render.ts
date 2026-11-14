/**
 * The Lab's canvas as strings and numbers, no DOM: a literal port of the artifact's `wirePath`,
 * `wireIcon`, `renderCanvas` (the non-focus branch), `ndSvg`, `renderFocusCanvas`, `fit`,
 * `zoomBy`, the stage's wheel handler and `addStep` (template.html ~lines 600-1027). The view
 * sets innerHTML from these; the tests compare them with the artifact's own output.
 */
import { ICONS, NODE_INFO, WIRES } from "../../data/graph";
import { FTYPES } from "../../data/models";
import { mods } from "../../engine/modules";
import { fires, fmtS, fmtUsd, outTok, type Sim } from "../../engine/sim";
import { MODELS, node } from "../../engine/state";
import type { LabEdge, LabGraph, LabNode, Selection } from "../../types";

export const W = 180;
export const H = 64;

export type Cam = { x: number; y: number; k: number };
export type Rect = { width: number; height: number };
export type Bounds = { x0: number; x1: number; y0: number; y1: number };
export type Pt = { x: number; y: number };

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};
export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);

export function wirePath(
  a: Pt & { x: number; y: number },
  b: Pt,
  mode: string,
): { d: string; lx?: number; ly?: number } {
  if (mode === "loop") {
    const bot = Math.max(a.y, b.y) + H + 70;
    return {
      d: `M${a.x + W / 2},${a.y + H} C${a.x + W / 2},${bot} ${b.x + W / 2},${bot} ${b.x + W / 2},${b.y + H}`,
      lx: (a.x + b.x + W) / 2,
      ly: bot - 12,
    };
  }
  let x1 = a.x + W,
    y1 = a.y + H / 2,
    x2 = b.x,
    y2 = b.y + H / 2;
  if (Math.abs(a.x - b.x) < W) {
    x1 = a.x + W / 2;
    x2 = b.x + W / 2;
    y1 = b.y > a.y ? a.y + H : a.y;
    y2 = b.y > a.y ? b.y : b.y + H;
    const my = (y1 + y2) / 2;
    return { d: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}` };
  }
  if (b.x + W <= a.x) {
    x1 = a.x;
    x2 = b.x + W;
  }
  const mx = (x1 + x2) / 2;
  return { d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` };
}

export function wireIconHtml(mode: string): string {
  const w = WIRES[mode];
  return `<svg class="w" viewBox="0 0 30 10" style="width:30px;height:10px;flex:none"><path d="M1,5 H26" stroke="var(${w.c})" stroke-width="${w.w || 1.6}" ${w.dash ? `stroke-dasharray="${w.dash}"` : ""} fill="none"/><path d="M24,2 L29,5 L24,8z" fill="var(${w.c})"/></svg>`;
}

/** A step's time over it: measured as is, an estimate beside measured ones marked "≈", or "inside" a step. */
function timeLabel(sim: Sim, id: string): string {
  const t = sim.T[id];
  if (!t) return sim.inside.has(id) ? "inside" : "";
  return sim.real && !sim.real.has(id) ? "≈ " + fmtS(t.ms) : fmtS(t.ms);
}

export function statsHtml(sim: Sim): string {
  return `<span>Reply <b>${fmtS(sim.reply)}</b>${sim.real ? ` <span class="real">real</span>` : ""}</span><span>Model calls <b>${sim.replyCalls.toFixed(1)}</b></span><span>Cost <b>${fmtUsd(sim.usd)}</b></span>`;
}

export function keywHtml(): string {
  return Object.entries(WIRES)
    .filter(([, w]) => !w.folded)
    .map(
      ([k, w]) =>
        `<span class="flex" style="gap:6px;flex-wrap:nowrap" title="${esc(w.tip)}">${wireIconHtml(k)}${w.name}</span>`,
    )
    .join("");
}

export function fbarHtml(label: string): string {
  return `<span class="hint">Focus</span><b>${esc(label)}</b><button class="ghost" id="fbOut">Whole graph</button>`;
}

export function renderGraphHtml(
  g: LabGraph,
  sim: Sim,
  tags: string[],
  sel: Selection,
  litId: string | ReadonlySet<string> | null,
  /** The artifact fades every step this text does not reach; the live Lab fades only steps switched off (Dev2, 2026-11-14). */
  fade: "unreached" | "off" = "unreached",
): string {
  const reached = (id: string) => sim.reach.has(id) || sim.inside.has(id);
  const lit = (id: string) => (fade === "off" ? !!node(id, g)?.on : reached(id));
  let h = `<defs>${Object.entries(WIRES)
    .map(
      ([k, w]) =>
        `<marker id="m-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1L9,5L0,9z" fill="var(${w.c})"/></marker>`,
    )
    .join(
      "",
    )}<marker id="m-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,1L9,5L0,9z" fill="var(--accent)"/></marker></defs>`;
  g.edges.forEach((e: LabEdge, i: number) => {
    const a = node(e.from, g);
    const b = node(e.to, g);
    if (!a || !b) return;
    const w = WIRES[e.mode] || WIRES.wait;
    const on = fade === "off" ? lit(e.from) && lit(e.to) : fires(e, tags, g) && lit(e.from);
    const s = sel?.t === "edge" && sel.i === i;
    const p = wirePath(a, b, e.mode);
    h += `<path class="wire ${on || s ? "" : "dim"} ${s ? "sel" : ""}" d="${p.d}" stroke="var(${s ? "--accent" : w.c})" ${w.dash ? `stroke-dasharray="${w.dash}"` : ""} ${w.w && !s ? `stroke-width="${w.w}"` : ""} marker-end="url(#m-${s ? "sel" : e.mode})"/>`;
    h += `<path class="hit" d="${p.d}" data-edge="${i}"><title>${esc(w.name + ": " + a.label + " → " + b.label)}</title></path>`;
    if (e.mode === "loop" && (on || s))
      h += `<text class="wlabel" x="${p.lx}" y="${p.ly}" text-anchor="middle">send back</text>`;
  });
  for (const n of g.nodes) {
    const m = MODELS[n.model] || MODELS.code;
    const s = sel?.t === "node" && sel.id === n.id;
    const sub = !n.on
      ? "Off"
      : m.runs === "code"
        ? "Code"
        : m.name + (n.effort && m.runs !== "api" ? " · " + n.effort : "");
    const time = timeLabel(sim, n.id);
    h += `<g class="nd ${s ? "sel" : ""} ${lit(n.id) || s ? "" : "dim"} ${n.on ? "" : "off"} ${(typeof litId === "string" ? litId === n.id : !!litId?.has(n.id)) ? "lit" : ""}" data-id="${n.id}" transform="translate(${n.x},${n.y})">
      <rect class="card" width="${W}" height="${H}" rx="12"/>
      <rect x="10" y="12" width="40" height="40" rx="10" fill="var(--s3)"/>
      <g transform="translate(18,20)" style="color:var(${n.on ? m.c : "--dim"})"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[n.icon] || ICONS.code}</svg></g>
      <text class="ttl" x="62" y="28">${esc(n.label.length > 15 ? n.label.slice(0, 14) + "…" : n.label)}</text>
      <circle cx="66" cy="43" r="3.5" fill="var(${n.on ? m.c : "--dim"})"/><text class="sub" x="74" y="47">${esc(sub)}</text>
      ${time ? `<text class="tm" x="${W - 4}" y="-7" text-anchor="end">${time}</text>` : ""}
      <circle class="port" data-port="${n.id}" cx="${W}" cy="${H / 2}" r="6"/>
      <circle class="port" data-port="${n.id}" cx="0" cy="${H / 2}" r="6"/>
    </g>`;
  }
  h += `<path id="ghost" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="5 4" d=""/>`;
  return h;
}

export function ndSvg(
  n: LabNode,
  x: number,
  y: number,
  sim: Sim,
  lit: boolean,
  sel: Selection,
): string {
  const m = MODELS[n.model] || MODELS.code;
  const s = sel?.t === "node" && sel.id === n.id;
  const sub = !n.on
    ? "Off"
    : m.runs === "code"
      ? "Code"
      : m.name + (n.effort && m.runs !== "api" ? " · " + n.effort : "");
  const time = timeLabel(sim, n.id);
  return `<g class="nd ${s ? "sel" : ""} ${lit || s ? "" : "dim"} ${n.on ? "" : "off"}" data-id="${n.id}" transform="translate(${x},${y})">
      <rect class="card" width="${W}" height="${H}" rx="12"/><rect x="10" y="12" width="40" height="40" rx="10" fill="var(--s3)"/>
      <g transform="translate(18,20)" style="color:var(${n.on ? m.c : "--dim"})"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[n.icon] || ICONS.code}</svg></g>
      <text class="ttl" x="62" y="28">${esc(n.label.length > 15 ? n.label.slice(0, 14) + "…" : n.label)}</text>
      <circle cx="66" cy="43" r="3.5" fill="var(${n.on ? m.c : "--dim"})"/><text class="sub" x="74" y="47">${esc(sub)}</text>
      ${time ? `<text class="tm" x="${W - 4}" y="-7" text-anchor="end">${time}</text>` : ""}</g>`;
}

export function renderFocusCanvasHtml(
  g: LabGraph,
  sim: Sim,
  cfocus: string,
  sel: Selection,
): { html: string; fBounds: Bounds } {
  const n = node(cfocus, g)!;
  const M = mods(g);
  let h = "";
  const BW = 190,
    BH = 26,
    GAP = 5;
  const col = <T>(items: T[], ih: number) => {
    const tot = items.length * ih + (items.length - 1) * GAP;
    return items.map((x, i) => ({ x, y: H / 2 - tot / 2 + i * (ih + GAP) }));
  };
  const inE = g.edges.filter((e) => e.to === n.id && node(e.from, g));
  const outE = g.edges.filter((e) => e.from === n.id && node(e.to, g));
  const readers = g.nodes.filter(
    (x) => x.ctx.includes("out:" + n.id) && !outE.some((e) => e.to === x.id),
  );
  const ins: LabEdge[] = [
    ...new Map(inE.map((e) => [e.from + e.mode, e] as const)).values(),
  ];
  const outs: Array<{ to: string; mode: string }> = (
    [
      ...new Map(outE.map((e) => [e.to + e.mode, e] as const)).values(),
    ] as Array<{ to: string; mode: string }>
  ).concat(readers.map((r) => ({ to: r.id, mode: "reads" })));
  const ctx = n.ctx.filter((c) =>
    c.startsWith("out:") ? node(c.slice(4), g) : M[c],
  );
  const fields = n.outSchema?.length
    ? n.outSchema
    : [{ name: "text", type: "text", options: "free text" }];
  const XI = -450,
    XM = -250,
    XO = W + 70,
    XN = W + 320;
  const ys: number[] = [0, H];
  const wire = (a: Pt, b: Pt, mode: string) => {
    const w: { c: string; dash: string; w?: number } = WIRES[mode] || {
      c: "--dim",
      dash: "2 3",
    };
    const mx = (a.x + b.x) / 2;
    return `<path class="wire" d="M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}" stroke="var(${w.c})" ${w.dash ? `stroke-dasharray="${w.dash}"` : ""} ${w.w ? `stroke-width="${w.w}"` : ""} fill="none"/>`;
  };
  const blk = (
    x: number,
    y: number,
    w: number,
    label: string,
    tk: string | number,
    cls: string,
    attr: string,
  ) =>
    `<g class="fblk ${cls}" ${attr} transform="translate(${x},${y})"><rect width="${w}" height="${BH}" rx="7"/><text x="10" y="18">${esc(label.length > 24 ? label.slice(0, 23) + "…" : label)}</text>${tk ? `<text class="tk" x="${w - 8}" y="18" text-anchor="end">${tk}</text>` : ""}</g>`;
  const cI = col(ins, H),
    cM = col(ctx, BH),
    cF = col(fields, BH),
    cO = col(outs, H);
  cI.forEach(({ x: e, y }) => {
    h +=
      wire({ x: XI + W, y: y + H / 2 }, { x: 0, y: H / 2 }, e.mode) +
      ndSvg(node(e.from, g)!, XI, y, sim, true, sel);
    ys.push(y, y + H);
  });
  cM.forEach(({ x: c, y }) => {
    h += wire({ x: XM + BW, y: y + BH / 2 }, { x: 0, y: H / 2 }, "reads");
    if (c.startsWith("out:")) {
      const o = node(c.slice(4), g);
      h += blk(
        XM,
        y,
        BW,
        (o?.label || c) + "'s output",
        o ? outTok(o) : "",
        "out",
        `data-fgo="${esc(c.slice(4))}"`,
      );
    } else {
      const v = M[c];
      h += blk(
        XM,
        y,
        BW,
        v.name,
        (v.tok / 1000).toFixed(1) + "k",
        v.stable ? "st" : "",
        `data-fmod="${esc(c)}"`,
      );
    }
    ys.push(y, y + BH);
  });
  cF.forEach(({ x: f, y }) => {
    h +=
      wire({ x: W, y: H / 2 }, { x: XO, y: y + BH / 2 }, "reads") +
      blk(
        XO,
        y,
        BW,
        f.name + " · " + (FTYPES[f.type]?.name || f.type),
        "",
        "fld",
        "",
      );
    ys.push(y, y + BH);
  });
  cO.forEach(({ x: e, y }) => {
    const t = node(e.to, g)!;
    h +=
      wire({ x: XO + BW, y: H / 2 }, { x: XN, y: y + H / 2 }, e.mode) +
      ndSvg(t, XN, y, sim, true, sel);
    ys.push(y, y + H);
  });
  const y0 = Math.min(...ys) - 40,
    y1 = Math.max(...ys, H + 170);
  const cap = (x: number, t: string) =>
    `<text class="fcap" x="${x}" y="${y0 + 14}">${t}</text>`;
  h +=
    (ins.length ? cap(XI, "Comes in") : "") +
    (ctx.length ? cap(XM, "Reads") : "") +
    cap(XO, "Gives out") +
    (outs.length ? cap(XN, "Goes to") : "");
  const lg = NODE_INFO[n.id]?.logs;
  h += `<foreignObject x="-30" y="${H + 16}" width="${W + 60}" height="150"><div xmlns="http://www.w3.org/1999/xhtml" class="fgoal">${esc(n.goal || "No goal written yet. Say why this step exists on the right.")}<span class="lg ${n.log ? "lgok" : "lgno"}">${n.log ? "Writes " + esc((lg || ["its entries"]).join(", ")) + " to the chat's record" : "Writes nothing to the chat's record"}</span></div></foreignObject>`;
  h += ndSvg(n, 0, 0, sim, true, sel);
  return { html: h, fBounds: { x0: XI - 20, x1: XN + W + 20, y0, y1 } };
}

/** The artifact's `fit()`: focus bounds when given, else the whole graph. Null where the artifact returns early. */
export function fitCam(
  nodes: Pt[],
  rect: Rect,
  fBounds: Bounds | null,
): Cam | null {
  if (!nodes.length || !rect.width) return null;
  const r = rect;
  const top = 60,
    bot = 70;
  if (fBounds) {
    const b = fBounds;
    const k = Math.max(
      0.3,
      Math.min(
        1.1,
        Math.min(
          r.width / (b.x1 - b.x0),
          (r.height - top - bot) / (b.y1 - b.y0),
        ),
      ),
    );
    return {
      k,
      x: (r.width - (b.x1 - b.x0) * k) / 2 - b.x0 * k,
      y:
        top +
        Math.max(0, (r.height - top - bot - (b.y1 - b.y0) * k) / 2) -
        b.y0 * k,
    };
  }
  const xs = nodes.map((n) => n.x),
    ys = nodes.map((n) => n.y);
  const x0 = Math.min(...xs) - 30,
    x1 = Math.max(...xs) + W + 30,
    y0 = Math.min(...ys) - 30,
    y1 = Math.max(...ys) + H + 110;
  const kf = Math.min(r.width / (x1 - x0), (r.height - top - bot) / (y1 - y0));
  const k = Math.max(r.width < 600 ? 0.55 : 0.68, Math.min(1.1, kf));
  return {
    k,
    x: kf < k ? 16 - x0 * k : (r.width - (x1 - x0) * k) / 2 - x0 * k,
    y: top + (r.height - top - bot - (y1 - y0) * k) / 2 - y0 * k,
  };
}

/** The artifact's `zoomBy`: the zoom buttons keep the stage's centre still. */
export function zoomCam(cam: Cam, f: number, rect: Rect): Cam {
  const k = Math.max(0.2, Math.min(2, cam.k * f));
  return {
    x: rect.width / 2 - ((rect.width / 2 - cam.x) * k) / cam.k,
    y: rect.height / 2 - ((rect.height / 2 - cam.y) * k) / cam.k,
    k,
  };
}

/** The stage's wheel handler: ctrl/cmd zooms under the pointer, otherwise pans. */
export function wheelCam(
  cam: Cam,
  e: {
    deltaX: number;
    deltaY: number;
    ctrlKey: boolean;
    metaKey: boolean;
    clientX: number;
    clientY: number;
  },
  rect: { left: number; top: number },
): Cam {
  if (e.ctrlKey || e.metaKey) {
    const k = Math.max(0.2, Math.min(2, cam.k * Math.exp(-e.deltaY * 0.01)));
    const mx = e.clientX - rect.left,
      my = e.clientY - rect.top;
    return {
      x: mx - ((mx - cam.x) * k) / cam.k,
      y: my - ((my - cam.y) * k) / cam.k,
      k,
    };
  }
  return { x: cam.x - e.deltaX, y: cam.y - e.deltaY, k: cam.k };
}

/**
 * The artifact's `addStep`: the first free `step<n>`, placed where the stage's centre is, snapped to 10.
 * `opts` is what the artifact passes to `N(id, label, opts)`, already carrying x and y.
 */
export function addStepNode(
  kind: string,
  cam: Cam,
  rect: Rect,
  has: (id: string) => boolean,
): {
  id: string;
  label: string;
  opts: Partial<LabNode> & Pick<LabNode, "x" | "y">;
} {
  let i = 1;
  while (has("step" + i)) i++;
  const x = Math.round(((rect.width / 2 - cam.x) / cam.k - W / 2) / 10) * 10;
  const y = Math.round(((rect.height / 2 - cam.y) / cam.k - H / 2) / 10) * 10;
  const o: Partial<LabNode> =
    kind === "tool"
      ? { model: "code", kind: "tool", ms: 900, icon: "tools" }
      : kind === "code"
        ? { model: "code", ms: 200, icon: "code" }
        : kind === "clef"
          ? { model: "clef", out: 40, icon: "judge", ctx: ["own", "recent"] }
          : {
              model: "haiku-5-5",
              effort: "medium",
              out: 250,
              icon: "door",
              ctx: ["own"],
            };
  return {
    id: "step" + i,
    label: "New step " + i,
    opts: Object.assign({ x, y }, o),
  };
}

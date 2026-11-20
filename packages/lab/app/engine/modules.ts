/**
 * A version's context modules: main's, with the version's edits and its own
 * new ones over them, sized from their real text where the repo has it. Plus
 * the wording fingerprint and word diff the artifact used. Ported verbatim.
 */
import { CV_MAIN } from "../data/convo";
import { changeOf, runMoves, runOrder } from "@context/tex/src/texModuleChange.cjs";
import { BASE_MODULES, MOD_ABOUT, MOD_SRC, SRC_KINDS, spanModule, wholeTrainModule } from "../data/modules";
import { MODTEXT } from "../labData.generated";
import type { ConvoSettings, LabGraph, LabModule, LabNode } from "../types";
import { edit, G, MAIN } from "./state";

export const cvOf = (g?: LabGraph): ConvoSettings => ({ ...CV_MAIN, ...(g?.convo || {}), tools: { ...CV_MAIN.tools, ...(g?.convo?.tools || {}) } });

export function modsRaw(g: LabGraph = G()): Record<string, LabModule> {
  const o: Record<string, LabModule> = {};
  const x = g.modules || {};
  const base = BASE_MODULES as Record<string, LabModule>;
  const src = MOD_SRC as Record<string, [string, string]>;
  const about = MOD_ABOUT as Record<string, string>;
  for (const k in base)
    o[k] = { ...base[k], ...(MODTEXT[k] ? { tok: Math.ceil(MODTEXT[k].length / 4) } : {}), about: about[k] || "", text: MODTEXT[k] || "", kind: src[k]?.[0] || "code", path: src[k]?.[1] || "", ...(x[k] || {}) } as LabModule;
  // A history span the version's steps read that main's don't (`chat:<days|all>:<chars>`, `summaries:...`): named from its key.
  for (const n of g.nodes || []) for (const k of n.ctx || []) {
    // So is a step's Training as whole conversations at a cap main's steps don't read (`train:<nodeId>:all:<chars>`).
    const span = o[k] ? null : spanModule(k) ?? wholeTrainModule(k);
    if (span) o[k] = { ...span.mod, about: span.about, text: "", kind: span.src[0], path: span.src[1], ...(x[k] || {}) } as LabModule;
  }
  for (const k in x) if (!o[k]) o[k] = { tok: 500, about: "", text: "", kind: "store", path: "", name: "", ...x[k], custom: true } as LabModule;
  for (const k in o) {
    const changes = tierOf(k, x[k]);
    o[k] = { ...o[k], changes, stable: changes !== "text" };
  }
  return o;
}

/**
 * A module's change tier: the version's own setting, else a draft's older "same every turn" switch (`stable`), else the
 * default for its key (`texModuleChange.cjs`).
 */
function tierOf(k: string, x: Partial<LabModule> | undefined): NonNullable<LabModule["changes"]> {
  if (x?.changes) return changeOf(k, { [k]: { changes: x.changes } });
  if (typeof x?.stable === "boolean") return x.stable ? (changeOf(k) === "text" ? "summary" : changeOf(k)) : "text";
  return changeOf(k);
}

/** A step's reads in the order they run: by change tier, the listed order kept within a tier (`texModuleChange.cjs`). */
export const readsOrder = (n: Pick<LabNode, "ctx">, g: LabGraph = G()): string[] => runOrder(n.ctx, mods(g));

/** Each of a step's reads that runs somewhere other than where it is listed, positions from 1. */
export const readsMoves = (n: Pick<LabNode, "ctx">, g: LabGraph = G()) => runMoves(n.ctx, mods(g));

/** The modules a turn sees: the chat views scale with the version's conversation settings. */
export function mods(g: LabGraph = G()): Record<string, LabModule> {
  const o = modsRaw(g);
  const c = cvOf(g);
  if (o.hist) o.hist = { ...o.hist, tok: Math.round(o.hist.tok * (c.word / 24) * (0.6 + 0.4 * Math.min(1, c.older / 80000))) };
  if (o.threads) o.threads = { ...o.threads, tok: Math.round(12 * c.threads) };
  return o;
}

export type ModuleCard = { key: string; mod: LabModule; edited: boolean; usedBy: LabNode[] };

/**
 * The Modules page's sections: one per kind of source (`SRC_KINDS`) that has modules, each card new (`mod.custom`),
 * edited (differs from main's) or neither, with the steps that read it; new ones first.
 */
export function moduleList(g: LabGraph = G()): Array<{ kind: string; name: string; tip: string; cards: ModuleCard[] }> {
  const M = mods(g);
  const main = mods(MAIN.graph);
  return Object.entries(SRC_KINDS)
    .map(([kk, K]) => ({
      kind: kk,
      name: K.name,
      tip: K.tip,
      cards: Object.entries(M)
        .filter(([, v]) => v.kind === kk)
        .sort((x, y) => (y[1].custom ? 1 : 0) - (x[1].custom ? 1 : 0))
        .map(([k, v]) => ({ key: k, mod: v, edited: !v.custom && JSON.stringify(v) !== JSON.stringify(main[k]), usedBy: g.nodes.filter((n) => n.ctx.includes(k)) })),
    }))
    .filter((s) => s.cards.length);
}

/** Whether a read stays the same between texts, so the cache reads it: any tier but "text" (`texModuleChange.cjs`). */
export const isStable = (c: string, g: LabGraph = G()) => !c.startsWith("out:") && (mods(g)[c]?.changes ?? changeOf(c)) !== "text";

/** FNV-1a over the exact text: one letter different is a different fingerprint. */
export const fp = (t: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};

export type Diff = Array<["=" | "-" | "+", string]>;
/** Word diff: trim the common start and end, then LCS on what's left (edits are usually small). */
export function wdiff(a: string, b: string): Diff {
  const A = a.split(/(\s+)/);
  const B = b.split(/(\s+)/);
  let i = 0;
  while (i < A.length && i < B.length && A[i] === B[i]) i++;
  let j = 0;
  while (j < A.length - i && j < B.length - i && A[A.length - 1 - j] === B[B.length - 1 - j]) j++;
  const a2 = A.slice(i, A.length - j);
  const b2 = B.slice(i, B.length - j);
  const out: Diff = [];
  if (i) out.push(["=", A.slice(0, i).join("")]);
  if (a2.length * b2.length > 4e6) {
    if (a2.length) out.push(["-", a2.join("")]);
    if (b2.length) out.push(["+", b2.join("")]);
  } else {
    const m = a2.length;
    const n = b2.length;
    const L = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let x = m - 1; x >= 0; x--) for (let y = n - 1; y >= 0; y--) L[x][y] = a2[x] === b2[y] ? L[x + 1][y + 1] + 1 : Math.max(L[x + 1][y], L[x][y + 1]);
    let x = 0;
    let y = 0;
    const push = (k: "=" | "-" | "+", t: string) => {
      const l = out[out.length - 1];
      if (l && l[0] === k) l[1] += t;
      else out.push([k, t]);
    };
    while (x < m && y < n) {
      if (a2[x] === b2[y]) {
        push("=", a2[x]);
        x++;
        y++;
      } else if (L[x + 1][y] >= L[x][y + 1]) {
        push("-", a2[x]);
        x++;
      } else {
        push("+", b2[y]);
        y++;
      }
    }
    while (x < m) push("-", a2[x++]);
    while (y < n) push("+", b2[y++]);
  }
  if (j) out.push(["=", A.slice(A.length - j).join("")]);
  return out;
}
export const wcount = (d: Diff) => {
  let p = 0;
  let m = 0;
  for (const [k, t] of d) {
    const w = t.split(/\s+/).filter(Boolean).length;
    if (k === "+") p += w;
    else if (k === "-") m += w;
  }
  return { p, m };
};

export function newModule() {
  const g = G();
  g.modules = g.modules || {};
  let i = 1;
  let k: string;
  do k = "m" + i++;
  while (mods(g)[k]);
  g.modules[k] = { name: "New module", tok: 500, stable: false, about: "", text: "", kind: "store", path: "", custom: true };
  return k;
}

export function setCv<K extends keyof ConvoSettings>(f: K, v: ConvoSettings[K]) {
  edit(() => {
    const g = G();
    g.convo = { ...(g.convo || {}), [f]: v };
  });
}
export function setCvTool(t: string, v: boolean) {
  edit(() => {
    const g = G();
    g.convo = { ...(g.convo || {}) };
    g.convo.tools = { ...(g.convo.tools || {}), [t]: v };
  });
}

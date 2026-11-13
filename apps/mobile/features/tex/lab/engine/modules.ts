/**
 * A version's context modules: main's, with the version's edits and its own
 * new ones over them, sized from their real text where the repo has it. Plus
 * the wording fingerprint and word diff the artifact used. Ported verbatim.
 */
import { CV_MAIN } from "../data/convo";
import { BASE_MODULES, MOD_ABOUT, MOD_SRC, STABLE } from "../data/modules";
import { MODTEXT } from "../labData.generated";
import type { ConvoSettings, LabGraph, LabModule } from "../types";
import { edit, G } from "./state";

export const cvOf = (g?: LabGraph): ConvoSettings => ({ ...CV_MAIN, ...(g?.convo || {}), tools: { ...CV_MAIN.tools, ...(g?.convo?.tools || {}) } });

export function modsRaw(g: LabGraph = G()): Record<string, LabModule> {
  const o: Record<string, LabModule> = {};
  const x = g.modules || {};
  const base = BASE_MODULES as Record<string, LabModule>;
  const src = MOD_SRC as Record<string, [string, string]>;
  const about = MOD_ABOUT as Record<string, string>;
  for (const k in base)
    o[k] = { ...base[k], ...(MODTEXT[k] ? { tok: Math.ceil(MODTEXT[k].length / 4) } : {}), stable: STABLE.has(k), about: about[k] || "", text: MODTEXT[k] || "", kind: src[k]?.[0] || "code", path: src[k]?.[1] || "", ...(x[k] || {}) } as LabModule;
  for (const k in x) if (!o[k]) o[k] = { tok: 500, stable: false, about: "", text: "", kind: "store", path: "", name: "", ...x[k], custom: true } as LabModule;
  return o;
}

/** The modules a turn sees: the chat views scale with the version's conversation settings. */
export function mods(g: LabGraph = G()): Record<string, LabModule> {
  const o = modsRaw(g);
  const c = cvOf(g);
  if (o.hist) o.hist = { ...o.hist, tok: Math.round(o.hist.tok * (c.word / 24) * (0.6 + 0.4 * Math.min(1, c.older / 80000))) };
  if (o.threads) o.threads = { ...o.threads, tok: Math.round(12 * c.threads) };
  return o;
}

export const isStable = (c: string, g: LabGraph = G()) => !c.startsWith("out:") && !!mods(g)[c]?.stable;

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

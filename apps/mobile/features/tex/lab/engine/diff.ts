/**
 * What a version changes against main, step by step, and the run config a
 * session takes: ported verbatim from the artifact's `diff`, `cvDiff`,
 * `runAreas` and `config`. Each change says how it lands: a setup-note edit,
 * a bench fixture, code, words only, or a guess that runs nothing.
 */
import { CV_TOOLS } from "../data/convo";
import { BASE_SHA, WIRES } from "../data/graph";
import { SETUP_FIELDS } from "../data/areas";
import { FTYPES } from "../data/models";
import { CASES } from "../labData.generated";
import type { LabCase, LabGraph, LabNode } from "../types";
import { cvOf, fp, mods, modsRaw, wcount, wdiff } from "./modules";
import { replayConfig, type MyText } from "./mine";
import { G, lab, MAIN, MODELS, node } from "./state";

export type Change = {
  node: string;
  label: string;
  what: string;
  from?: unknown;
  to?: unknown;
  how: "code" | "setup" | "fixture" | "guess" | "doc";
  setup?: string;
  model?: string;
  mod?: string;
  areas: string[];
};

const runs = (x: Change) => !["guess", "doc"].includes(x.how);

export function cvDiff(): Change[] {
  const a = cvOf(MAIN.graph);
  const b = cvOf(G());
  const out: Change[] = [];
  const L: Record<string, string> = { word: "word for word, hours", older: "older history, characters", threads: "threads listed", days: "day summaries", dayChars: "summary characters", slim: "tool calls shown as names only", classify: "classifier runs" };
  for (const f in L) if ((a as Record<string, unknown>)[f] !== (b as Record<string, unknown>)[f]) out.push({ node: "convo", label: "Conversation view", what: L[f], from: (a as Record<string, unknown>)[f], to: (b as Record<string, unknown>)[f], how: "code", areas: ["core"] });
  const tools = CV_TOOLS as Record<string, [string, string, boolean]>;
  for (const t in tools) if (a.tools[t] !== b.tools[t]) out.push({ node: "convo", label: "Chat tools", what: (b.tools[t] ? "adds " : "drops ") + t, to: tools[t][0] + (tools[t][2] ? "" : " (new tool: code to write)"), how: "code", areas: ["core"] });
  return out;
}

export function diff(): Change[] {
  const a: LabGraph = MAIN.graph;
  const b: LabGraph = G();
  const out: Change[] = [];
  const setupFields = SETUP_FIELDS as Record<string, string>;
  const ftypes = FTYPES as Record<string, { name: string }>;
  for (const n of b.nodes) {
    const o = node(n.id, a);
    if (!o) {
      out.push({ node: n.id, label: n.label, what: "new step", to: `on ${MODELS[n.model]?.full}`, how: "code", areas: n.areas });
      continue;
    }
    for (const f of ["model", "effort", "rounds", "out", "on", "timeoutS", "ms", "sendBack", "label"] as const)
      if (JSON.stringify(o[f]) !== JSON.stringify(n[f])) {
        const key = n.id + "." + f;
        const how = setupFields[key] ? "setup" : ["rounds", "out", "ms", "label"].includes(f) ? "guess" : "code";
        out.push({ node: n.id, label: n.label, what: f, from: f === "model" ? MODELS[o[f]]?.full : o[f], to: f === "model" ? MODELS[n[f]]?.full : n[f], model: f === "model" ? n[f] : undefined, how, setup: setupFields[key], areas: n.areas });
      }
    const add = n.ctx.filter((c) => !o.ctx.includes(c));
    const rm = o.ctx.filter((c) => !n.ctx.includes(c));
    const nm = (c: string) => (c.startsWith("out:") ? (node(c.slice(4), b)?.label || c.slice(4)) + "'s output" : mods(b)[c]?.name || c);
    if (JSON.stringify(o.outSchema || null) !== JSON.stringify(n.outSchema || null))
      out.push({ node: n.id, label: n.label, what: "output", to: n.outSchema?.length ? n.outSchema.map((f) => f.name + ": " + (ftypes[f.type]?.name || f.type) + (f.options ? " (" + f.options + ")" : "")).join("; ") : "free text", how: "code", areas: n.areas });
    if (add.length) out.push({ node: n.id, label: n.label, what: "reads more", to: add.map(nm).join(", "), how: "code", areas: n.areas });
    if (rm.length) out.push({ node: n.id, label: n.label, what: "reads less", to: rm.map(nm).join(", "), how: "code", areas: n.areas });
    const keep = n.ctx.filter((c) => o.ctx.includes(c));
    const oKeep = o.ctx.filter((c) => n.ctx.includes(c));
    if (keep.join() !== oKeep.join()) {
      const moved = keep.filter((c, i) => c !== oKeep[i]);
      const pOnly = moved.every((c) => c.startsWith("p-"));
      out.push({ node: n.id, label: n.label, what: "reads in a new order", from: oKeep.map(nm).join(" → "), to: n.ctx.map(nm).join(" → "), how: pOnly ? "setup" : "code", setup: pOnly ? "ai/production/texting-assistant.md modules:" : undefined, areas: n.areas });
    }
    if ((o.goal || "") !== (n.goal || "")) out.push({ node: n.id, label: n.label, what: "goal", from: o.goal || "none", to: n.goal || "none", how: "doc", areas: n.areas });
    if (!!o.log !== !!n.log) out.push({ node: n.id, label: n.label, what: "writes to the chat's record", from: o.log ? "yes" : "no", to: n.log ? "yes: each run appends an entry with its input, output, ms and ok" : "no", how: "code", areas: n.areas });
    if (n.note) out.push({ node: n.id, label: n.label, what: "note", to: n.note, how: "code", areas: n.areas });
  }
  for (const o of a.nodes) if (!node(o.id, b)) out.push({ node: o.id, label: o.label, what: "removed", how: "code", areas: o.areas });
  const ma = modsRaw(a);
  const mb = modsRaw(b);
  const users = (k: string) => b.nodes.filter((n) => n.ctx.includes(k));
  const howOf = (kind: unknown): Change["how"] => (kind === "ailc" ? "setup" : kind === "store" ? "fixture" : "code");
  for (const k in mb) {
    const x = mb[k];
    const y = ma[k];
    const ar = [...new Set(users(k).flatMap((n) => n.areas))];
    if (!y) {
      out.push({ node: "module:" + k, label: x.name, what: "new context module", setup: x.kind === "ailc" ? x.path : undefined, to: `${x.name}, ${x.tok} tokens, ${x.stable ? "same every turn" : "changes every turn"}${x.text ? ": " + (x.text.length > 120 ? x.text.slice(0, 120) + "…" : x.text) : ""}`, how: howOf(x.kind), areas: ar });
      continue;
    }
    if (x.text !== y.text) {
      const d = wdiff(y.text || "", x.text || "");
      const c = wcount(d);
      out.push({ node: "module:" + k, mod: k, label: x.name, what: "wording", from: y.text ? fp(y.text) : "not in the Lab", to: `${fp(x.text || "")} · +${c.p} −${c.m} words${y.text ? "" : " (main's text isn't copied here: the run compares against the live note)"}`, how: howOf(x.kind), setup: x.kind === "ailc" ? x.path : undefined, areas: ar });
    }
    const ch = (["name", "tok", "stable", "about", "kind", "path"] as const).filter((f) => JSON.stringify(x[f]) !== JSON.stringify(y[f]));
    if (ch.length)
      out.push({ node: "module:" + k, label: x.name, what: "context module changed", from: y.name, to: ch.map((f) => (f === "stable" ? (x.stable ? "same every turn" : "changes every turn") : f === "tok" ? x.tok + " tokens" : f + ": " + String(x[f]).slice(0, 120))).join("; "), how: ch.every((f) => f === "tok") ? "guess" : howOf(x.kind), setup: x.kind === "ailc" ? x.path : undefined, areas: ar });
  }
  const key = (e: LabGraph["edges"][number]) => e.from + ">" + e.to + ":" + e.mode + ":" + e.when.join("/");
  const ka = new Set(a.edges.map(key));
  const kb = new Set(b.edges.map(key));
  const labOf = (id: string, g: LabGraph) => node(id, g)?.label || id;
  const areasOf = (id: string, g: LabGraph) => (node(id, g) as LabNode | undefined)?.areas || [];
  for (const e of b.edges) if (!ka.has(key(e))) out.push({ node: e.from, label: labOf(e.from, b), what: "new wire", to: `${labOf(e.from, b)} → ${labOf(e.to, b)} (${(WIRES as Record<string, { name: string }>)[e.mode].name})`, how: "code", areas: [...areasOf(e.from, b), ...areasOf(e.to, b)] });
  for (const e of a.edges) if (!kb.has(key(e))) out.push({ node: e.from, label: labOf(e.from, a), what: "wire removed", to: `${labOf(e.from, a)} → ${labOf(e.to, a)}`, how: "code", areas: [...areasOf(e.from, a), ...areasOf(e.to, a)] });
  return out.concat(cvDiff());
}

export const picks = () => lab.cur.picks || (lab.cur.picks = {});
export const isPicked = (c: LabCase) => {
  const p = picks()[c.area];
  return p ? p.includes(c.id) : true;
};
export const allCases = (): LabCase[] => CASES.map((c) => Object.assign({}, c, lab.caseEdits[c.area + "/" + c.id] || {})).concat(Object.values(lab.caseEdits).filter((e) => e.isNew));

export function runAreas(): string[] {
  if (lab.cur.areas) return lab.cur.areas;
  const s = new Set(diff().filter(runs).flatMap((x) => x.areas || []));
  for (const c of Object.values(lab.caseEdits)) s.add(c.area);
  return [...s];
}

export function config() {
  const d = diff();
  const areas = runAreas();
  const cases: Record<string, string[]> = {};
  for (const a of areas) {
    const p = picks()[a];
    if (p) cases[a] = p;
  }
  const setup: Record<string, unknown> = {};
  for (const x of d) if (x.how === "setup" && x.setup) setup[x.setup] = x.what === "model" ? MODELS[x.model ?? ""]?.id : x.what === "on" ? (x.to ? "on" : "off") : x.to;
  const G0 = G();
  const main = mods(MAIN.graph);
  return {
    texLab: 1,
    version: { name: lab.cur.name, id: lab.cur.id, base: "main@" + BASE_SHA },
    setup,
    changes: d.filter(runs).map(({ node, what, from, to, how }) => ({ step: node, what, from, to, how })),
    steps: G0.nodes.map((n) => ({ id: n.id, label: n.label, model: MODELS[n.model]?.id || "code", runs: MODELS[n.model]?.runs || "code", effort: n.effort, on: n.on, reads: n.ctx, output: n.outSchema?.length ? n.outSchema : "text", file: n.file })),
    models: Object.fromEntries(Object.entries(G0.models || {}).map(([k, v]) => [k, { name: v.name, id: v.id, runs: v.runs, typed: v.typed || "text" }])),
    modules: Object.fromEntries(
      Object.entries(mods())
        .filter(([k, v]) => v.custom || JSON.stringify(v) !== JSON.stringify(main[k]))
        .map(([k, v]) => {
          const m0 = main[k];
          return [k, { name: v.name, from: v.kind, path: v.path, tokens: v.tok, changesEveryTurn: !v.stable, about: v.about, text: v.text, fingerprint: fp(v.text || ""), mainFingerprint: m0?.text ? fp(m0.text) : null }];
        }),
    ),
    wires: G0.edges,
    areas,
    cases,
    caseEdits: Object.values(lab.caseEdits).map(({ area, id, ask, expect, isNew }) => ({ area, id, ask, expect, isNew: !!isNew })),
    log: "one JSON line per model call: {node, model, ms, in, out, thinking, steps, output}",
    // The person's own texts picked to replay read only, when the test user is "You" (`mine.ts`, `bench/labReplay.mjs`).
    ...(lab.tester === "me" ? replayConfig(pickedTexts(), lab.myReads, lab.me ? { handle: lab.me.handle, name: lab.me.name } : null) : {}),
  };
}

/** The person's texts picked to replay, oldest first. */
export function pickedTexts(): MyText[] {
  const list = Array.isArray(lab.myTexts) ? lab.myTexts : [];
  return list.filter((t) => lab.myPicks.includes(t.id)).sort((a, b) => a.at - b.at);
}

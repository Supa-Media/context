/**
 * What the Lab computes and shows from its own data, for the MCP's `tex_dev` (`apps/mcp/src/texDev/lab.js`; Dev2,
 * 2026-11-15: "anything that can be done inside of the lab should be able to be done inside of the MCP"). The gateway
 * cannot import TypeScript, so `scripts/tex-dev-lab.mjs` bundles this file into `apps/mcp/src/texDev/lab.generated.js`
 * and CI fails when the committed copy differs: every answer here is the Lab's own function on the same input, never
 * a second copy of it.
 *
 * Pure strings and numbers, no DOM and no React. The Lab's functions read its one state (`state.ts`) as the artifact
 * read its globals, so each call puts the draft, the case edits and the other versions there for its length
 * (`withLab`) and puts the old state back.
 */
import { AREA_INFO, AREA_IO, AREAS, EXAMINABLE, GROUP_CHATS, PEOPLE, SETUP_FIELDS, TRACE_GROUPS } from "../data/areas";
import { CV_KINDS, CV_TOOLS } from "../data/convo";
import { NODE_INFO, WIRES } from "../data/graph";
import { BASE_MODELS, EFFORT, FTYPES } from "../data/models";
import { SRC_KINDS } from "../data/modules";
import { TOOL_INV } from "../data/tools";
import { WS } from "../labData.generated";
import type { LabCase, LabGraph, LabVersion, RunResult } from "../types";
import { inPrompt } from "../views/convoRows";
import { latest, promptText, shipsAs, type ParsedResult } from "../views/run/runText";
import { runWarnings } from "../views/run/runWarns";
import { readLog } from "../views/simLog";
import { areaCounts, caseFit, caseWant, ioInfo, whoInfo } from "../views/tests/caseInfo";
import { med, readToolLog, toolUsers } from "../views/toolStats";
import { wsTree } from "../views/wsTree";
import { allCases, config, cvDiff, diff, isPicked, runAreas, type Change } from "./diff";
import { withCurrentModes } from "./groups";
import { groupsReference } from "./forMcpGroups";
import { cvOf, fp, moduleList, mods, wcount, wdiff } from "./modules";
import { cacheShare, ctxTokens, deltaText, fmtS, fmtUsd, LANE_NAME, outTok, simulate, whereTimeGoes, type Sim } from "./sim";
import { STEP_LOGS } from "./stepLogs";
import { clone, G, lab, MAIN, MODELS, node, shownGraph } from "./state";
import { buildTraces, scnLabel, SCENARIOS } from "./traces";

/** The Lab's own functions, for the gateway's tests to hold each answer against (`apps/mcp/test/texDevLab.test.mjs`). */
export { allCases, caseFit, config, cvDiff, diff, fmtS, fmtUsd, fp, isPicked, latest, mods, promptText, readLog, runAreas, runWarnings, simulate, wdiff, whereTimeGoes, SCENARIOS, lab };

/** A version as the gateway hands it: the control plane's draft (its graph unfolded, as saved), or main. */
export type DraftIn = { id: string; name: string; graph?: LabGraph; picks?: Record<string, string[]> | null; areas?: string[] | null; results?: RunResult[]; by?: string };
/** One call's Lab: the version open, the shared case edits (`texLab.saveCase`), and the other versions it may compare with. */
export type LabIn = { draft: DraftIn; caseEdits?: Record<string, LabCase>; others?: DraftIn[] };
/** The traced test: a bench test's key, or a text typed as the canvas's own message (`text`, started by `from`). */
export type TestIn = { test?: string | null; text?: string | null; from?: string | null };

/** A version as the Lab holds one once loaded (`store.ts`): its graph with the current wire names and every group folded. */
export function asVersion(d: DraftIn): LabVersion {
  if (d.id === "main") return clone(MAIN);
  const g = d.graph;
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error("That version has no steps and wires.");
  return { id: d.id, name: d.name, graph: shownGraph(withCurrentModes(clone(g)), null), picks: d.picks ?? {}, areas: d.areas ?? null, results: d.results ?? [], authorId: null };
}

const KEPT = ["cur", "versions", "caseEdits", "logRows", "scn", "ownText", "ownFrom", "tester", "mode", "real", "myChat", "cfocus"] as const;

/** Runs `fn` with `input` as the Lab's state, the way a page that opened this version would hold it, and puts the old state back. */
export function withLab<T>(input: LabIn, fn: () => T, t: TestIn = {}): T {
  const before = Object.fromEntries(KEPT.map((k) => [k, lab[k]]));
  const mainResults = MAIN.results;
  try {
    // Main's kept runs live on its own row (`store.ts`), so they come in as a version named "main".
    MAIN.results = [input.draft, ...(input.others ?? [])].find((d) => d.id === "main")?.results ?? [];
    const cur = asVersion(input.draft);
    lab.cur = cur;
    lab.versions = [MAIN, ...(cur.id === "main" ? [] : [cur]), ...(input.others ?? []).filter((o) => o.id !== cur.id && o.id !== "main").map(asVersion)];
    lab.caseEdits = { ...(input.caseEdits ?? {}) };
    Object.assign(lab, { logRows: null, tester: "bench", mode: "lab", real: null, myChat: "me", cfocus: null, ownText: t.text ? String(t.text) : "", ownFrom: t.from ? String(t.from) : "text", scn: "" });
    buildTraces(allCases());
    if (t.text) lab.scn = "own";
    else if (t.test) {
      if (!SCENARIOS[t.test]) throw new Error(`There is no test "${t.test}"; sim without one lists them.`);
      lab.scn = t.test;
    }
    return fn();
  } finally {
    Object.assign(lab, before);
    MAIN.results = mainResults;
  }
}

/** The tests the canvas's picker offers, in its order: core, jobs, pipeline, then the typed message. */
export function testList(): Array<{ key: string; name: string; group: string }> {
  return ["core", "jobs", "pipeline", "own"].flatMap((gr) =>
    Object.entries(SCENARIOS)
      .filter(([, v]) => v.group === gr)
      .map(([key, v]) => ({ key, name: v.name, group: TRACE_GROUPS[gr] ?? gr })),
  );
}

/** The test list for this Lab: the bench's tests with any new cases, then the typed message. */
export const labTests = (input: LabIn) => withLab(input, testList);

const testOf = (k: string) => ({ key: k, name: scnLabel(k), group: TRACE_GROUPS[SCENARIOS[k]?.group ?? "own"] ?? "", tags: SCENARIOS[k]?.tags ?? [] });

/** The Speed and cost view, with the Node panel's reads, cache share and output for each step, for the test picked. */
export function labSim(input: LabIn, t: TestIn & { base?: DraftIn | null; log?: string | null } = {}) {
  return withLab(
    input,
    () => {
      if (t.base && t.base.id !== "main" && !lab.versions.some((v) => v.id === t.base!.id)) lab.versions.push(asVersion(t.base));
      const base = t.base ? (lab.versions.find((v) => v.id === t.base!.id) ?? MAIN) : MAIN;
      const g = G();
      const read = t.log ? readLog(t.log, g, MODELS) : null;
      if (read) lab.logRows = read.rows;
      const a = simulate(g, lab.scn, lab.logRows);
      const b = simulate(base.graph, lab.scn, null);
      const kpi = (x: number, y: number, f: (n: number) => string) => ({ value: f(x), vsBase: deltaText(x, y, f, base.name) });
      const calls = (n: number) => n.toFixed(1);
      return {
        version: lab.cur.name,
        test: testOf(lab.scn),
        base: base.name,
        untilReply: kpi(a.reply, b.reply, fmtS),
        modelCallsBefore: kpi(a.replyCalls, b.replyCalls, calls),
        cost: kpi(a.usd, b.usd, fmtUsd),
        ...(a.jobEnd ? { jobDoneAfter: kpi(a.jobEnd, b.jobEnd, fmtS) } : {}),
        whereTheTimeGoes: whereTimeGoes(a).map(([id, s]) => {
          const n = node(id, g)!;
          const m = MODELS[n.model] || MODELS.code;
          return {
            step: id,
            label: n.label,
            lane: LANE_NAME[s.lane],
            model: m.runs === "code" ? "code" : m.name,
            starts: fmtS(s.start),
            takes: fmtS(s.ms),
            cost: fmtUsd(s.usd),
            calls: +s.calls.toFixed(2),
            parts: s.parts.map((p) => ({ part: p.own ? "Its own work" : p.id === "sendback" ? "Send-backs" : node(p.id, g)?.label || p.id, takes: fmtS(p.ms), ...(p.note ? { note: p.note } : {}) })),
            reads: `${(ctxTokens(n, g) / 1000).toFixed(1)}k tokens, ${Math.round(cacheShare(n, g) * 100)}% cached`,
            outputTokens: outTok(n),
          };
        }),
        replySent: fmtS(a.reply),
        helpersInside: [...a.inside],
        ...(read
          ? {
              measured: read.rows
                ? { steps: Object.keys(read.rows).length, skippedLines: read.bad, rows: Object.entries(read.rows).map(([id, r]) => ({ step: node(id, g)?.label || id, calls: r.calls, logged: fmtS(r.wall), inProduction: fmtS(r.prodMs), how: r.api ? "real" : "from " + r.out + " tokens" })) }
                : { steps: 0, skippedLines: read.bad, note: "No lines matched this version's steps" },
            }
          : {}),
      };
    },
    t,
  );
}

/** A simulation of the graph as drawn, for `tex_dev snapshot` with a test: the canvas's own `labSim` with nothing measured. */
export function labSimFor(input: LabIn, t: TestIn): (shown: LabGraph) => { sim: Sim; name: string } {
  return (shown) => withLab(input, () => ({ sim: simulate(shown, lab.scn, null), name: scnLabel(lab.scn) }), t);
}

/** The Compare view: each version's reply time and cost for the test, and each area's latest practice and held-out score. */
export function labCompare(input: LabIn, t: TestIn = {}) {
  return withLab(
    input,
    () => ({
      test: testOf(lab.scn),
      versions: lab.versions.map((v) => {
        const s = simulate(v.graph, lab.scn, null);
        const L = latest(v);
        const by = v.id === "main" ? "live" : ([input.draft, ...(input.others ?? [])].find((d) => d.id === v.id)?.by ?? "Someone");
        return { id: v.id, name: v.name, by, reply: fmtS(s.reply), cost: fmtUsd(s.usd), areas: Object.fromEntries(Object.keys(AREAS).filter((a) => L[a]).map((a) => [a, `${L[a].practice[0]}/${L[a].practice[1]}, held ${L[a].held[0]}/${L[a].held[1]}`])) };
      }),
    }),
    t,
  );
}

const changeRow = (x: Change) => ({ step: x.label, node: x.node, what: x.what, ...(x.from !== undefined ? { from: x.from } : {}), to: x.to, shipsAs: shipsAs(x), ...(x.mod ? { module: x.mod } : {}) });

/** The Run view: the changes from main and how each ships, the areas, its warnings, the prompt and the config JSON it copies. */
export function labConfig(input: LabIn) {
  return withLab(input, () => {
    const d = diff();
    const chosen = runAreas();
    const saved = lab.cur.areas;
    lab.cur.areas = null;
    const byDefault = runAreas();
    lab.cur.areas = saved;
    const c = config();
    const results = ((lab.cur.results || []) as ParsedResult[])
      .slice()
      .reverse()
      .map((r) => ({
        at: new Date(r.at).toISOString(),
        verdict: r.pass == null ? "unread" : r.pass ? "nothing regressed" : `${r.regressed ?? "some"} regressed`,
        areas: Object.entries(r.areas).map(([a, v]) => `${AREAS[a] || a} ${v.practice[0]}/${v.practice[1]} · held-out ${v.held[0]}/${v.held[1]}`),
        ...(/^https:\/\//.test(r.link || "") ? { link: r.link } : {}),
      }));
    return {
      version: lab.cur.name,
      changes: d.map(changeRow),
      ...(d.length ? {} : { note: "Same as main. A run now is a baseline." }),
      areas: Object.entries(AREAS).map(([k, v]) => ({ area: k, name: v + (EXAMINABLE.has(k) ? "" : " · credits"), run: chosen.includes(k), byDefault: byDefault.includes(k) })),
      warnings: runWarnings(d, chosen),
      results,
      prompt: promptText(c),
      configJson: JSON.stringify(c, null, 2),
    };
  });
}

/** What a version changes against main, the way the Lab's nav tags and Run view list it: steps, wires, modules' words and the conversation view. */
export function labChanges(input: LabIn) {
  return withLab(input, () => {
    const d = diff();
    return { modules: d.filter((x) => x.node.startsWith("module:")).map(changeRow), convo: cvDiff().map(changeRow), all: d.length };
  });
}

type CaseMeta = LabCase & { chat?: string; must?: boolean; group?: string; path?: string; as?: string; title?: string };

/** The Test cases view: the areas with their counts, or one area's panel, who runs it and its cases. */
export function labBench(input: LabIn, q: { area?: string | null; query?: string | null; limit?: number; offset?: number; full?: boolean } = {}) {
  return withLab(input, () => {
    if (!q.area)
      return {
        areas: Object.entries(AREAS).map(([k, v]) => {
          const n = areaCounts(k);
          return { area: k, name: v, kind: AREA_INFO[k]?.int ? "integration: the whole turn" : "unit: one step alone", step: node(AREA_INFO[k]?.step ?? "", MAIN.graph)?.label ?? "", inRun: `${n.picked}/${n.total}`, ...(n.unfit ? { cantTestAsWritten: n.unfit } : {}), ...(EXAMINABLE.has(k) ? {} : { needs: "API credits" }) };
        }),
        people: Object.entries(PEOPLE).map(([name, p]) => ({ name, workspaces: p.ws })),
        groupChats: GROUP_CHATS,
        workspaces: Object.keys(WS).map((w) => ({ ws: w, notes: Object.keys(WS[w]).length })),
      };
    const area = q.area;
    if (!AREAS[area]) throw new Error(`There is no area "${area}"; bench without one lists them.`);
    const inArea = allCases().filter((c) => c.area === area);
    const needle = (q.query ?? "").toLowerCase();
    const list = inArea.filter((c) => !needle || (c.id + " " + c.ask + " " + c.expect).toLowerCase().includes(needle));
    const io = ioInfo(area, G());
    const I = AREA_INFO[area];
    const who = whoInfo(area, inArea);
    const from = Math.max(0, q.offset ?? 0);
    const limit = Math.max(1, Math.min(200, q.limit ?? 20));
    return {
      area,
      name: AREAS[area],
      inRun: `${inArea.filter(isPicked).length} of ${inArea.length}`,
      runsAs: who ? { how: who.how, workspace: "none", ...(area === "respond" ? { groupChats: who.groups, oneToOne: who.ones } : {}) } : { person: I.as, how: I.how, workspaces: PEOPLE[I.as!]?.ws },
      panel: !io
        ? null
        : io.int
          ? { test: testOf(io.test), toTheReply: fmtS(io.sim.reply), cost: fmtUsd(io.sim.usd), path: io.path.map((x) => `${x.label} (${(MODELS[x.model] || MODELS.code).runs === "code" ? "code" : (MODELS[x.model] || MODELS.code).name})`), checks: io.check, how: io.how }
          : { in: io.chips.map((c) => ({ module: c.name, is: c.cls === "g" ? "the case gives it" : c.cls === "x" ? "the step no longer reads it" : c.cls === "f" ? "from Maya's workspace" : "the bench fills it" })), step: `${io.step.label} · ${io.model.name}`, checks: io.check, how: io.how },
      total: list.length,
      cases: list.slice(from, from + limit).map((c) => {
        const x = c as CaseMeta;
        const ed = lab.caseEdits[c.area + "/" + c.id];
        const fit = caseFit(c);
        const want = caseWant(c, !!ed);
        return {
          id: c.id,
          inRun: isPicked(c),
          ...(x.chat ? { chat: x.chat === "group" ? "group" : "1:1" } : {}),
          ...(x.must ? { tagged: true } : {}),
          ...(x.group ? { group: x.group } : {}),
          ...(ed ? { edit: ed.isNew ? "new" : "edited" } : {}),
          ask: c.ask,
          ...(want.musts ? { must: want.musts, never: want.nots } : { expect: want.expect, ...(want.field ? { checks: `${want.field} = ${want.value}` } : {}) }),
          ...(fit.length ? { cantTest: fit } : {}),
          ...(q.full ? { case: c } : {}),
        };
      }),
      ...(from + limit < list.length ? { more: `offset ${from + limit} for the next ${Math.min(limit, list.length - from - limit)}` } : {}),
    };
  });
}

/** The workspace browser: a bench workspace's notes by folder, and one note's text. */
export function labWorkspace(ws: string, at?: string | null) {
  if (!WS[ws]) throw new Error(`There is no bench workspace "${ws}" (${Object.keys(WS).join(", ")}).`);
  const t = wsTree(ws, at ?? undefined);
  if (at && t.files[at] === undefined) throw new Error(`There is no note "${at}" in ${ws}.`);
  return { ws, path: `apps/mcp/bench/ai/workspaces/${ws}`, notes: t.paths.length, folders: Object.fromEntries(Object.keys(t.groups).sort().map((d) => [d ? d + "/" : "(top)", t.groups[d]])), note: t.cur, text: t.files[t.cur] || "" };
}

/** Elide the unchanged runs of a word diff to `ctx` characters each side, so a small edit to a long module stays small. */
function trimDiff(d: Array<["=" | "-" | "+", string]>, ctx: number) {
  return d.map(([k, s]) => (k === "=" && s.length > ctx * 2 + 20 ? [k, s.slice(0, ctx) + ` …(${s.length - ctx * 2} unchanged characters)… ` + s.slice(-ctx)] : [k, s]));
}

/** The Modules view (and its viewer): the modules by where they come from, or one module's words and its word diff against main. */
export function labModules(input: LabIn, q: { key?: string | null; full?: boolean } = {}) {
  return withLab(input, () => {
    const g = G();
    if (!q.key)
      return moduleList(g).map((s) => ({
        from: s.name,
        tip: s.tip,
        modules: s.cards.map((c) => ({ key: c.key, name: c.mod.name, tokens: c.mod.tok, ...(c.mod.custom ? { pill: "new" } : c.edited ? { pill: "edited" } : {}), everyTurn: c.mod.stable ? "same" : "changes", usedBy: c.usedBy.map((n) => n.id), ...(c.mod.path ? { path: c.mod.path } : {}) })),
      }));
    const v = mods(g)[q.key];
    if (!v) throw new Error(`There is no module "${q.key}"; modules without a key lists them.`);
    const m0 = mods(MAIN.graph)[q.key];
    const d = wdiff(m0?.text || "", v.text || "");
    const c = wcount(d);
    const edited = !v.custom && JSON.stringify(v) !== JSON.stringify(m0);
    return {
      key: q.key,
      name: v.name,
      from: SRC_KINDS[v.kind ?? ""]?.name ?? v.kind,
      path: v.path,
      about: v.about,
      tokens: v.tok,
      everyTurn: v.stable ? "same" : "changes",
      ...(v.custom ? { pill: "new" } : edited ? { pill: "edited" } : {}),
      usedBy: g.nodes.filter((n) => n.ctx.includes(q.key!)).map((n) => n.id),
      fingerprint: fp(v.text || ""),
      main: m0?.text ? fp(m0.text) : "(not in the Lab)",
      words: `+${c.p} −${c.m}`,
      ...(m0 && (m0.text || "") !== (v.text || "") ? { diff: q.full ? d : trimDiff(d, 80) } : {}),
      text: v.text || "",
    };
  });
}

const TOPICS = ["tools", "steps", "groups", "ledger", "areas", "models", "wires", "sources", "convo"] as const;

/** The Lab's catalogues: tools, what each step logs and writes, the step groups, the ledger's kinds, the areas, models, wires, module sources, conversation settings. */
export function labReference(input: LabIn, topic?: string | null, toolLog?: string | null, group?: string | null) {
  return withLab(input, () => {
    const g = G();
    switch (topic) {
      case "tools": {
        const stats = toolLog ? readToolLog(toolLog) : null;
        const S = stats?.n ? stats.stats : null;
        const cell = (k: string) => {
          const s = S?.[k];
          if (!s) return undefined;
          const m = med(s.ms);
          return { calls: s.calls, median: m != null ? fmtS(m) : "–", errors: s.err, ...(s.err ? { why: s.why } : {}) };
        };
        return {
          calledBy: toolUsers(g).map((n) => n.id),
          ...(stats ? { read: stats.n ? `${stats.n} tool calls` : "No tool entries in that paste" } : {}),
          tools: TOOL_INV.map(([t, kind, what, acts]) => ({ tool: t, kind, does: what, actions: acts, ...(S ? { stats: cell(t) ?? { calls: 0 }, byAction: Object.fromEntries(acts.filter((a) => S[t + "." + a]).map((a) => [a, cell(t + "." + a)])) } : {}) })),
        };
      }
      case "steps":
        return g.nodes.map((n) => ({ step: n.id, label: n.label, writes: NODE_INFO[n.id]?.logs ?? "nothing", thisVersion: n.log ? "writes" : "writes nothing", ...(n.log !== !!node(n.id, MAIN.graph)?.log ? { changed: true } : {}), ...(STEP_LOGS[n.id] ? { logs: STEP_LOGS[n.id] } : {}), ...(n.group ? { group: n.group } : {}) }));
      case "groups":
        return groupsReference(g, group);
      case "ledger": {
        const c = cvOf(g);
        return CV_KINDS.map(([k, w, hh, sh]) => ({ entry: k, writtenBy: w, holds: hh, inThePrompt: inPrompt(k, sh, c.slim) }));
      }
      case "areas":
        return Object.entries(AREAS).map(([k, v]) => ({ area: k, name: v, examinable: EXAMINABLE.has(k), ...AREA_INFO[k], gives: AREA_IO[k]?.gives, fixture: AREA_IO[k]?.fixture, checks: AREA_IO[k] ? { field: AREA_IO[k].check.field, how: AREA_IO[k].check.how, words: AREA_IO[k].check.words, code: AREA_IO[k].check.code } : undefined }));
      case "models":
        return { models: { ...BASE_MODELS, ...(g.models || {}) }, effort: EFFORT, outputFieldTypes: FTYPES, setupFields: SETUP_FIELDS };
      case "wires":
        return WIRES;
      case "sources":
        return SRC_KINDS;
      case "convo":
        return { settings: cvOf(g), main: cvOf(MAIN.graph), tools: CV_TOOLS, changes: cvDiff().map(changeRow) };
      default:
        return { topics: [...TOPICS], note: "reference { topic } answers one; tools takes log: a pasted chat record, counted as the Tools tab's Measure does; groups takes group: one group's id." };
    }
  });
}
export { labCaseRoom, labMarks, labPutBack, labSteps } from "./forMcpCases";

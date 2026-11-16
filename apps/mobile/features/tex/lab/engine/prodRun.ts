/**
 * A real text played as it ran in production (Lab live sandbox, Dev2 2026-11-16: the Lab and Replay are one view, and a
 * real row above "Sandbox from here" has a ▶ that "replays what ran in prod"). Everything Replay read of a moment is
 * read here and handed back as the one run shape the Lab plays (`playRun.ts`): the moment's texts and judgings
 * (`replay.ts`), each turn's measured times (`measured.ts`), what each step got, thought and gave (`stepIO.ts`), the
 * model rounds' tokens and the tool calls the log kept.
 *
 * Only what the log shows ran is drawn (Dev2, 2026-11-14: "If the step never ran, then why is it logged as running?
 * ... Are you telling me that the replay is false?"): a step with no record in its turn's entries has no step here,
 * and nothing is estimated (`onlyWhatRan`). Its tool calls are `kind: "prod"`: they ran in production, not here.
 * Pure: it reads the ledger entries it is handed and the graph it is given, so the gateway's `tex_dev` can bundle it.
 */
import type { LedgerEntry } from "../../page/texPageTypes";
import type { LabGraph } from "../types";
import type { TexVersion, ChatLine } from "./mine";
import { graphAt, graphNoteFor } from "./graphAt";
import { causeRun, type PlayCall, type PlayRun, type PlayStep } from "./playRun";
import type { TurnPrompt } from "./promptAt";
import { onlyWhatRan, withReal } from "./realTimes";
import { loggedMoments, momentsOf, type Moment } from "./replay";
import { simulate } from "./sim";
import { node } from "./state";
import { nodeOfStep } from "./stepLogs";
import { show, type IoLine } from "./stepIO";
import { turnShown } from "./turnShown";

/** The production row a ▶ is on: the copied row of the test chat (`prod: true`), its id the ledger's event id. */
export type ProdRow = { id: string; at?: number; turn?: string };

/** One turn of the moment as the run drew it: which Tex ran it and the prompt it logged, for the panel's walk back. */
export type ProdTurn = { turn: string; version: TexVersion | null; prompt: TurnPrompt | null; steps: string[] };

export type ProdPlay = {
  /** The moment from the row's text: everything that ran, from the first text to the last send. */
  run: PlayRun;
  /** Each of Tex's texts in the moment, played with only the steps of the turn that sent it; absent where the log can't say. */
  replies: Record<string, PlayRun>;
  /** The step ids behind each of Tex's texts (the Lab's `cause`), keyed by that text's row id. */
  cause: Record<string, string[]>;
  turns: ProdTurn[];
  /** Background jobs the moment's turns ran or reported (`jobRuns.ts` reads their work). */
  jobs: string[];
  moment: Moment;
};

const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const cut = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const IN_KEYS = /^(Got|Judged|Asked with|On|Turn|Started)\b|· got$/;
const THINK_KEYS = /^Thought\b/;

/** What a step got, thought and gave, from the lines the panel reads (`stepIO.ts`), as the run's `in`, `think` and `out`. */
export function splitIO(lines: IoLine[]): { in?: unknown; think?: string; out?: unknown } {
  const ins: IoLine[] = [];
  const outs: IoLine[] = [];
  const think: string[] = [];
  for (const l of lines) {
    if (l.k === "Model") continue;
    if (THINK_KEYS.test(l.k)) think.push(l.v);
    else if (IN_KEYS.test(l.k)) ins.push(l);
    else outs.push(l);
  }
  // One line is its words; several are an object by what each line was.
  const bag = (ls: IoLine[]): unknown => (ls.length === 0 ? undefined : ls.length === 1 ? ls[0].v : Object.fromEntries(ls.map((l, i) => [ls.findIndex((x) => x.k === l.k) === i ? l.k : `${l.k} (${i + 1})`, l.v])));
  const i = bag(ins);
  const o = bag(outs);
  return { ...(i !== undefined ? { in: i } : {}), ...(think.length ? { think: think.join("\n\n") } : {}), ...(o !== undefined ? { out: o } : {}) };
}

/** The moment a row belongs to: the one it starts, or for one of Tex's texts the latest moment that holds it. */
function momentOf(moments: Moment[], line: ChatLine): Moment | null {
  const own = moments.find((m) => m.id === line.id);
  if (own) return own;
  return [...moments].filter((m) => m.lines.some((l) => l.id === line.id)).sort((a, b) => b.at - a.at)[0] ?? null;
}

/** The turn a text of Tex's was sent from, when its own ledger entry says (no inference from times). */
const turnOfText = (entries: LedgerEntry[], line: ChatLine) => str(entries.find((e) => e.kind === "text" && (e.id === line.id || (!!line.eid && e.eid === line.eid)))?.turn) || null;

/** The ids (lines' ids) of the texts a turn covers, from the Door step's own log of them. */
function coveredTexts(entries: LedgerEntry[], turn: string, lines: ChatLine[]): string[] {
  const door = entries.find((e) => e.turn === turn && e.kind === "step" && e.step === "door");
  const covers = Array.isArray(rec(door?.input)?.covers) ? (rec(door!.input)!.covers as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return lines.filter((l) => covers.includes(l.id) || (!!l.eid && covers.includes(l.eid))).map((l) => l.id);
}

type Built = { steps: PlayStep[]; turns: ProdTurn[]; texts: PlayRun["texts"]; textStep: Map<string, string> };

/** One moment's steps: what came in, the judgings, and each turn's steps at their measured times, against graph `g`. */
function momentSteps(m: Moment, lines: ChatLine[], entries: LedgerEntry[], g: LabGraph): Built {
  const steps: PlayStep[] = [];
  const turns: ProdTurn[] = [];
  const textStep = new Map<string, string>();

  // What came in: each text lights its start step (a text, or a check-in, a routine or a ping), on the moment's clock.
  const startNode = m.from === "text" ? "text" : m.from;
  const persons = m.lines.filter((l) => l.from === "person");
  if (node(startNode, g))
    m.lanes.Texts.forEach((b, i) => {
      const id = `${m.id}:in:${i}`;
      steps.push({ id, node: startNode, at: b.start, ms: b.end - b.start, ok: true, out: b.label });
      const line = m.from === "text" ? persons[i] : m.lines[0];
      if (line) textStep.set(line.id, id);
    });

  // The texting Worker's judgings are Decide, each at its own time.
  if (node("decide", g)) m.lanes.Judge.forEach((b, i) => steps.push({ id: `${m.id}:decide:${i}`, node: "decide", at: b.start, ms: b.end - b.start, ok: true, out: b.label, ...(b.detail ? { in: b.detail } : {}) }));

  const seen = new Set<string>();
  for (const bar of m.lanes.Turn) {
    if (bar.kind !== "turn" || !bar.turn || bar.zero === undefined || seen.has(bar.turn)) continue;
    seen.add(bar.turn);
    const tid = bar.turn;
    const zero = bar.zero;
    const shown = turnShown(m, lines, entries, tid);
    if (!shown?.times) continue;
    const real = shown.times;
    const mine = shown.entries.filter((e) => e.turn === tid);
    // Only the steps the log shows ran (`onlyWhatRan`): never an estimate standing in for one that didn't.
    const sim = onlyWhatRan(withReal(simulate(g, "own", null, real, m.from), real, g), g);
    const timing = rec(mine.find((e) => e.kind === "reply")?.timing);
    const rounds = (Array.isArray(timing?.rounds) ? (timing!.rounds as unknown[]) : []).map(rec).filter((r): r is Record<string, unknown> => r !== null);
    const calls: PlayCall[] = mine
      .filter((e) => e.kind === "tool" && e.name !== "ask_advisor" && e.name !== "plan_big_ask")
      .map((e) => ({ tool: str(e.name) || "tool", kind: "prod" as const, ms: num(e.ms) ?? 0, d: cut(show(e.args)) }));
    const callsOn = sim.T.tools ? "tools" : sim.T.fd ? "fd" : null;
    const idOf = (n: string) => `${tid}:${n}`;
    const ids: string[] = [];

    // Inputs are the Texts row's, Decide the judgings', the queue the wait bar's: all drawn from the moment, not the turn.
    const placed = new Map<string, { start: number; end: number }>();
    for (const [n, t] of Object.entries(sim.T)) {
      const nd = node(n, g);
      if (!nd || nd.kind === "input" || n === "decide" || n === "lanes" || t.end < t.start) continue;
      placed.set(n, { start: Math.max(0, zero + t.start), end: Math.max(0, zero + t.end) });
    }
    const wait = m.lanes.Turn.find((b) => b.kind === "wait" && b.turn === tid);
    if (wait && node("lanes", g)) {
      steps.push({ id: idOf("lanes"), node: "lanes", at: wait.start, ms: wait.end - wait.start, ok: true, out: "waited for the turn ahead of it in this chat" });
      ids.push(idOf("lanes"));
    }
    // The step that started it: the caller of a helper, else the latest step before it.
    const parentOf = (n: string) => {
      const into = g.edges.filter((e) => e.to === n && placed.has(e.from));
      const caller = into.find((e) => e.mode === "uses");
      const before = into.filter((e) => e.mode !== "uses" && e.mode !== "loop").sort((a, b) => placed.get(b.from)!.end - placed.get(a.from)!.end)[0];
      return (caller ?? before)?.from ?? null;
    };
    for (const [n, p] of [...placed].sort((a, b) => a[1].start - b[1].start)) {
      const own = mine.filter((e) => nodeOfStep(e.step) === n || (e.step === "node" && e.name === n));
      const model = n === "fd" ? str(rounds.find((r) => str(r.model))?.model) : str(own.find((e) => str(e.model))?.model);
      const parent = parentOf(n);
      const lane = sim.T[n].lane;
      steps.push({
        id: idOf(n),
        node: n,
        at: p.start,
        ms: p.end - p.start,
        ok: !own.some((e) => e.ok === false),
        ...splitIO(shown.io[n] ?? []),
        ...(n === callsOn && calls.length ? { calls } : {}),
        ...(model ? { model } : {}),
        ...(n === "fd" && rounds.length
          ? {
              tokIn: rounds.reduce((a, r) => a + (num(r.input) ?? 0) + (num(r.cacheRead) ?? 0) + (num(r.cacheWrite) ?? 0), 0),
              tokOut: rounds.reduce((a, r) => a + (num(r.output) ?? 0), 0),
              ...(real.usd !== undefined ? { cost: real.usd } : {}),
            }
          : {}),
        ...(lane === "behind" || lane === "job" ? { bg: true } : {}),
        ...(parent ? { parent: idOf(parent) } : {}),
      });
      ids.push(idOf(n));
    }
    turns.push({ turn: tid, version: (bar.version as TexVersion | null | undefined) ?? null, prompt: shown.prompt, steps: ids });
  }
  steps.sort((a, b) => a.at - b.at);
  const texts = m.lines.filter((l) => l.from === "tex" && !l.quiet).map((l) => ({ at: Math.max(0, l.at - m.at), rowId: l.eid ?? l.id }));
  return { steps, turns, texts, textStep };
}

/**
 * What ran for the text a ▶ is on: the whole moment from that text, and for each Tex text in it the steps of the turn
 * that sent it. `g` is the graph the steps are read against; `drawn` the graph the run asks the canvas to draw (the
 * one of the time), or none to draw the version open, with `graphNote` saying why. Null when the text is from before
 * full logging (`LOGGED_FROM`) or nothing of it ran that the log shows.
 */
export function prodPlay(entries: LedgerEntry[], lines: ChatLine[], row: ProdRow, opts: { g: LabGraph; drawn?: LabGraph; graphNote?: string }): ProdPlay | null {
  const line = lines.find((l) => l.id === row.id || l.eid === row.id || (!!row.turn && !!l.start && l.turn === row.turn));
  if (!line) return null;
  const moment = momentOf(loggedMoments(momentsOf(lines, entries)), line);
  if (!moment) return null;
  const built = momentSteps(moment, lines, entries, opts.g);
  if (!built.steps.some((s) => s.node !== "text" && s.node !== "decide" && s.node !== moment.from)) return null;
  const total = Math.max(0, ...built.steps.map((s) => s.at + (s.ms ?? 0)), ...built.texts.map((t) => t.at));
  const code = built.turns.find((t) => t.version?.code)?.version?.code;
  const run: PlayRun = {
    id: moment.id,
    steps: built.steps,
    texts: built.texts,
    total,
    running: false,
    ...(opts.drawn ? { graph: opts.drawn } : {}),
    ...(opts.graphNote ? { graphNote: opts.graphNote } : {}),
    prod: { at: moment.at, ...(code ? { code } : {}) },
  };
  // Each of Tex's texts: only when its own ledger entry names the turn, and that turn is one the run drew.
  const cause: Record<string, string[]> = {};
  const replies: Record<string, PlayRun> = {};
  for (const l of moment.lines) {
    if (l.from !== "tex" || l.quiet) continue;
    const turn = l.turn ?? turnOfText(entries, l);
    const t = built.turns.find((x) => x.turn === turn);
    if (!t || !turn) continue;
    const covered = coveredTexts(entries, turn, lines).map((id) => built.textStep.get(id)).filter((x): x is string => !!x);
    const keep = new Set([...covered, ...t.steps]);
    const ordered = built.steps.filter((s) => keep.has(s.id)).map((s) => s.id);
    const rowId = l.eid ?? l.id;
    const r = causeRun(run, rowId, ordered);
    if (!r) continue;
    cause[rowId] = ordered;
    replies[rowId] = r;
  }
  const jobOf = (e: LedgerEntry) => (e.kind === "job" ? str(e.job) : str(e.jobId));
  const jobs = [...new Set(entries.filter((e) => moment.turns.includes(str(e.turn)) && jobOf(e)).map(jobOf))];
  return { run, replies, cause, turns: built.turns, jobs, moment };
}

/**
 * `prodPlay` on the graph of the time (Dev2, 2026-11-16: "▶ replays what ran in prod, on the graph Tex had then"): the
 * commit that ran the moment's first turn (`version.code`, `agent/texVersion.js`) names `texConfig.json` as it was
 * (`graphAt.ts`, cached per commit). When that can't be loaded the run is read against `current` and says so
 * (`graphNote`), and the canvas draws the version open.
 */
export async function prodPlayAtVersion(entries: LedgerEntry[], lines: ChatLine[], row: ProdRow, current: LabGraph, get?: typeof fetch): Promise<ProdPlay | null> {
  const line = lines.find((l) => l.id === row.id || l.eid === row.id || (!!row.turn && !!l.start && l.turn === row.turn));
  const moment = line ? momentOf(loggedMoments(momentsOf(lines, entries)), line) : null;
  if (!moment) return null;
  const code = moment.lanes.Turn.find((b) => b.version?.code)?.version?.code;
  const then = await graphAt(code, get);
  return prodPlay(entries, lines, row, then ? { g: then, drawn: then } : { g: current, graphNote: graphNoteFor(moment.at, code) });
}

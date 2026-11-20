/**
 * Runs from the Lab (Dev2, 2026-11-15/16; mockup https://claude.ai/artifact/P2vQtigdvALrSWyb5CqQ3E): the Dev set, one
 * Dev chat or one node, run on GitHub on a version's config with the models picked (the AI gateway, as live Tex, or
 * Claude Code on the subscription token, which never leaves GitHub), scored and saved back (`functions/texLabRuns.ts`).
 * A gate run is Promote's: the pull request's sealed Test set check, counts only. What the Lab shows of a run, and
 * the tab's own choices: which version runs, which models, and whether the Runs panel is open.
 */
import { useSyncExternalStore } from "react";
import { CC_FIDELITY, DEFAULT_REPEATS } from "@context/lab/src/texRunBand.cjs";
import type { RunScore } from "@context/lab/src/texRunBand.d.cts";

export { bandVerdict, CC_FIDELITY, CC_FIDELITY_WHY, DEFAULT_REPEATS, MAX_REPEATS } from "@context/lab/src/texRunBand.cjs";
export type { BandVerdict, RunScore } from "@context/lab/src/texRunBand.d.cts";
export { compareRuns, pairedCompare, pairedWords, runStats, statsWords, t975, wilson } from "@context/lab/src/texRunStats.cjs";
export type { ComparedRuns, Paired, PairedResult, PairedRow, PairedVerdict, RunStatsResult } from "@context/lab/src/texRunStats.d.cts";

export type RunKind = "dev" | "chat" | "node" | "gate";
export type RunStage = "queued" | "running" | "done" | "failed";
/** `runs` and `passes` are set when the Front door test ran more than once: how many repeats, and how many passed. */
export type RunRow = { convId: string; msgIndex: number; node: string; ok: boolean; got: string; want: string; ran?: boolean; ambiguous?: boolean; usd?: number; route?: { pick?: string; sure?: number; door?: string; fellBack?: string }; runs?: number; passes?: number };
/** A row out of a run's score: one that could not run, or an ambiguous one (its label's own gold reply fails). */
export type RunNote = { convId: string; msgIndex: number; node: string; why: string };
/** A run's world (`scripts/tex-lab-run.mjs` worldOf): the simulated calls no fixture answered, by kind, and which. */
export type World = { misses: number; byKind: Record<string, number>; calls: Array<{ chat: string; kind: string; call: string }> };
export type LabRun = {
  id: string;
  versionId: string;
  kind: RunKind;
  convId?: string;
  nodeId?: string;
  models: "gw" | "cc";
  /** How many times each Front door test ran; 1 for runs from before repeats. */
  repeats?: number;
  /** "model family only" for a run on Claude Code, else null. */
  fidelity?: string | null;
  stage: RunStage;
  ghRunUrl?: string;
  pr?: string;
  /** The code asked for: `#<pull request>` or a branch; null is main. */
  code?: string | null;
  /** The commit the workflow checked out and ran, once it did. */
  commit?: string | null;
  by?: string;
  startedAt: number;
  finishedAt?: number;
  results: {
    /** The mean over repeats when the run repeated (a fraction), also `score.mean`. */
    pass: number;
    total: number;
    costUsd: number;
    handoff?: Handoff;
    world?: World;
    ms: number;
    perConv?: Array<{ id: string; pass: number; total: number; min?: number; max?: number }>;
    perNode?: Array<{ node: string; pass: number; total: number; min?: number; max?: number }>;
    rows?: RunRow[];
    couldNotRun?: RunNote[];
    ambiguous?: RunNote[];
    goldFails?: number | null;
    /** The repeats' band: mean, min, max and the interval. Absent on runs from before repeats. */
    score?: RunScore;
    repeats?: number;
    fidelity?: string | null;
    fidelityWhy?: string | null;
  } | null;
  error?: string;
  /** GitHub refused this run, and a later run has started since: the cause is fixed (`functions/texLabRuns.ts` `fixedSince`). */
  fixedSince?: boolean;
};

/** `repeats`: how many times each Front door test runs in a run the Lab starts (Dev2, 2026-11-19; the default is 3). */
export type RunsUi = { open: boolean; run: string | null; models: "gw" | "cc"; ver: string; repeats: number };
export const runsUi: RunsUi = { open: false, run: null, models: "gw", ver: "main", repeats: DEFAULT_REPEATS };
const subs = new Set<() => void>();
let n = 0;
export function setRunsUi(p: Partial<RunsUi>) {
  Object.assign(runsUi, p);
  n++;
  subs.forEach((f) => f());
}
export function useRunsUi(): RunsUi {
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => n,
    () => n,
  );
  return runsUi;
}

export const runLabel = (r: LabRun, title?: (id: string) => string, node?: (id: string) => string) =>
  r.kind === "dev" ? "Dev set" : r.kind === "chat" ? `Chat: ${title ? title(r.convId || "") : r.convId}` : r.kind === "node" ? `Node: ${node ? node(r.nodeId || "") : r.nodeId}` : "Test set gate";
export const stageWords: Record<RunStage, [string, string]> = { queued: ["q", "Queued on GitHub"], running: ["r", "Running"], done: ["d", "Done"], failed: ["f", "Failed"] };
export const modelsWords = (r: Pick<LabRun, "kind" | "models">) => (r.kind === "gate" ? "eval service" : r.models === "cc" ? "Claude Code" : "AI gateway");
/** A count to one decimal place, trimming a trailing .0: 13.33 reads 13.3, 12 reads 12. */
export const oneDp = (x: number) => String(Math.round(x * 10) / 10);
/**
 * The score, with the rows left out of it beside it: "40/62 right · 1 couldn't run · 2 ambiguous" (each part only when > 0).
 * A run that repeated reads its mean with the band of its repeats: "13.3/30 right (11–15 over 3 repeats)" (Dev2, 2026-11-19).
 */
export const scoreWords = (r: LabRun) => {
  if (!r.results) return "";
  const cannot = r.results.couldNotRun?.length ?? 0;
  const amb = r.results.ambiguous?.length ?? 0;
  const s = r.results.score;
  const right = s && s.repeats > 1 ? `${oneDp(s.mean)}/${s.total} right (${s.min}–${s.max} over ${s.repeats} repeats)` : `${r.results.pass}/${r.results.total} right`;
  return [right, ...(cannot > 0 ? [`${cannot} couldn't run`] : []), ...(amb > 0 ? [`${amb} ambiguous`] : [])].join(" · ");
};
/** "model family only" for a run on Claude Code, whose models can't match production's; "" for the AI gateway. */
export const fidelityWords = (r: Pick<LabRun, "models">) => (r.models === "cc" ? CC_FIDELITY : "");
/** A row's passes over its repeats: "2/3 passed"; "" when the row ran once. */
export const rowRate = (row: Pick<RunRow, "runs" | "passes">) => ((row.runs ?? 1) > 1 ? `${oneDp(row.passes ?? 0)}/${row.runs} passed` : "");
/** A version's dev score in a list: "13.3/30 (11–15 ×3)", or "40/62" when the run had one repeat. */
export const devScoreWords = (r: LabRun) => {
  if (!r.results) return "";
  const s = r.results.score;
  return s && s.repeats > 1 ? `${oneDp(s.mean)}/${s.total} (${s.min}–${s.max} ×${s.repeats})` : `${r.results.pass}/${r.results.total}`;
};
/** A gw run's cost covers every repeat, so a repeated one says so: "$0.012 (AI gateway) for 3 repeats". */
export const costWords = (r: LabRun) =>
  r.kind === "gate"
    ? "eval service's own"
    : r.models === "cc"
      ? "$0.00 (subscription)"
      : r.results
        ? `$${r.results.costUsd.toFixed(3)} (AI gateway)${(r.repeats ?? 1) > 1 ? ` for ${r.repeats} repeats` : ""}${handoffWords(r.results.handoff)}`
        : "";

/** What handed-off background jobs added to a run, already inside its cost (Dev2, 2026-11-18: for Finance). */
export type Handoff = { jobs: number; parts: number; advisorCalls: number; usd: number; perJobUsd: number; advisorCallsPerJob: number };

export const handoffWords = (h: Handoff | undefined) =>
  h && h.jobs > 0 ? `, of which ${h.jobs} handed-off job${h.jobs === 1 ? "" : "s"}: ${h.advisorCalls} advisor call${h.advisorCalls === 1 ? "" : "s"}, $${h.usd.toFixed(3)} ($${h.perJobUsd.toFixed(3)} a job)` : "";
/** The world a run had, in words: replayed from fixtures, or how many simulated calls had none ("" when the run has none). */
export const worldWords = (w?: World) => {
  if (!w) return "";
  if (w.misses === 0) return "world replayed from fixtures";
  // The kinds the misses were, most first (`web search 2, browser page 1`), when the run says which.
  const kinds = Object.entries(w.byKind ?? {})
    .filter(([, n]) => n > 0)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  return `world: ${w.misses} simulated call${w.misses === 1 ? "" : "s"} not in fixtures${kinds ? ` (${kinds})` : ""}`;
};
export const ago = (at: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
export const live = (r: LabRun) => r.stage === "queued" || r.stage === "running";
/** A failure GitHub's refusal caused, fixed since: shown as fixed, never as a red current failure. */
export const fixedWords = "Fixed since: later runs start";
/** Which code a run asks for, in words. */
export const codeWords = (code: string | null | undefined) => (!code ? "Runs on main's code" : code.startsWith("#") ? `Runs on pull request ${code}'s code` : `Runs on branch ${code}`);
const REPO = "https://github.com/Supa-Media/context";
/** Where the code a run asked for lives, and the commit that ran (only once the workflow reported it). */
export const codeLink = (code: string | null | undefined) => (!code ? `${REPO}/tree/main` : code.startsWith("#") ? `${REPO}/pull/${code.slice(1)}` : `${REPO}/tree/${code.split("/").map(encodeURIComponent).join("/")}`);
export const commitLink = (sha: string) => `${REPO}/commit/${sha}`;
/** The same run from any MCP session (Lab = MCP parity). */
export function mcpLines(r: LabRun) {
  const remove = live(r) ? "" : `\ntex_dev { action: "run_remove", id: "${r.id}" }`;
  if (r.kind === "gate") return `tex_dev { action: "test_set" }\ntex_dev { action: "runs", id: "${r.id}" }${remove}`;
  const extra = r.kind === "chat" ? `, conv: "${r.convId}"` : r.kind === "node" ? `, node: "${r.nodeId}"` : "";
  const repeats = typeof r.repeats === "number" ? `, repeats: ${r.repeats}` : "";
  const code = r.code ? `, code: "${r.code}"` : "";
  return `tex_dev { action: "run", draft: "${r.versionId}", kind: "${r.kind}"${extra}, models: "${r.models}"${repeats}${code} }\ntex_dev { action: "runs", id: "${r.id}" }${remove}`;
}

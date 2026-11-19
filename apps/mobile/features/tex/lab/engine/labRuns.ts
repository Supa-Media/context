/**
 * Runs from the Lab (Dev2, 2026-11-15/16; mockup https://claude.ai/artifact/P2vQtigdvALrSWyb5CqQ3E): the Dev set, one
 * Dev chat or one node, run on GitHub on a version's config with the models picked (the AI gateway, as live Tex, or
 * Claude Code on the subscription token, which never leaves GitHub), scored and saved back (`functions/texLabRuns.ts`).
 * A gate run is Promote's: the pull request's sealed Test set check, counts only. What the Lab shows of a run, and
 * the tab's own choices: which version runs, which models, and whether the Runs panel is open.
 */
import { useSyncExternalStore } from "react";

export type RunKind = "dev" | "chat" | "node" | "gate";
export type RunStage = "queued" | "running" | "done" | "failed";
export type RunRow = { convId: string; msgIndex: number; node: string; ok: boolean; got: string; want: string; ran?: boolean; ambiguous?: boolean; usd?: number; route?: { pick?: string; sure?: number; door?: string; fellBack?: string } };
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
  results: { pass: number; total: number; costUsd: number; handoff?: Handoff; world?: World; ms: number; perConv?: Array<{ id: string; pass: number; total: number }>; perNode?: Array<{ node: string; pass: number; total: number }>; rows?: RunRow[]; couldNotRun?: RunNote[]; ambiguous?: RunNote[]; goldFails?: number | null } | null;
  error?: string;
  /** GitHub refused this run, and a later run has started since: the cause is fixed (`functions/texLabRuns.ts` `fixedSince`). */
  fixedSince?: boolean;
};

export type RunsUi = { open: boolean; run: string | null; models: "gw" | "cc"; ver: string };
export const runsUi: RunsUi = { open: false, run: null, models: "gw", ver: "main" };
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
/** The score, with the rows left out of it beside it: "40/62 right · 1 couldn't run · 2 ambiguous" (each part only when > 0). */
export const scoreWords = (r: LabRun) => {
  if (!r.results) return "";
  const cannot = r.results.couldNotRun?.length ?? 0;
  const amb = r.results.ambiguous?.length ?? 0;
  return [`${r.results.pass}/${r.results.total} right`, ...(cannot > 0 ? [`${cannot} couldn't run`] : []), ...(amb > 0 ? [`${amb} ambiguous`] : [])].join(" · ");
};
export const costWords = (r: LabRun) => (r.kind === "gate" ? "eval service's own" : r.models === "cc" ? "$0.00 (subscription)" : r.results ? `$${r.results.costUsd.toFixed(3)} (AI gateway)${handoffWords(r.results.handoff)}` : "");

/** What handed-off background jobs added to a run, already inside its cost (Dev2, 2026-11-18: for Finance). */
export type Handoff = { jobs: number; parts: number; advisorCalls: number; usd: number; perJobUsd: number; advisorCallsPerJob: number };

export const handoffWords = (h: Handoff | undefined) =>
  h && h.jobs > 0 ? `, of which ${h.jobs} handed-off job${h.jobs === 1 ? "" : "s"}: ${h.advisorCalls} advisor call${h.advisorCalls === 1 ? "" : "s"}, $${h.usd.toFixed(3)} ($${h.perJobUsd.toFixed(3)} a job)` : "";
/** The world a run had, in words: replayed from fixtures, or how many simulated calls had none ("" when the run has none). */
export const worldWords = (w?: World) => (!w ? "" : w.misses === 0 ? "world replayed from fixtures" : `world: ${w.misses} simulated call${w.misses === 1 ? "" : "s"} not in fixtures`);
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
  const code = r.code ? `, code: "${r.code}"` : "";
  return `tex_dev { action: "run", draft: "${r.versionId}", kind: "${r.kind}"${extra}, models: "${r.models}"${code} }\ntex_dev { action: "runs", id: "${r.id}" }${remove}`;
}

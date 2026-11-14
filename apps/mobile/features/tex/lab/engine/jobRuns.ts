/**
 * What a background job did, from the chat's own record (Dev2, 2026-11-14: "click any text sent ... and see what led up
 * to that ... this text, I'm assuming it's from a background job ... I'm not able to see any insight into what the
 * background job did, any tool calls that he did"). A job's runs are kept in its chat's ledger, each a turn of its own
 * whose entries carry `jobId`: what it thought, every tool call with what it was given and what came back, what it said,
 * and the job check's verdict on it (`job` entries: keep going, done or stuck, and the advice). A text Tex sends from a
 * job is its report turn, whose `job` entry names the job.
 */
import type { LedgerEntry } from "../../page/texPageTypes";

export type JobTool = { at: number; name: string; ok: boolean; ms: number | null; args: unknown; result: unknown };
export type JobRun = {
  turn: string;
  start: number;
  end: number;
  /** The job check's verdict on this run: keep_going, done, stuck. */
  state: string | null;
  advice: string | null;
  report: string | null;
  said: string | null;
  model: string | null;
  thinking: Array<{ at: number; ms: number | null; text: string }>;
  tools: JobTool[];
  /** Its other steps (the hand-back check, a card, the advisor), as kept. */
  steps: LedgerEntry[];
};
export type JobWork = { id: string; title: string; runs: JobRun[] };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The jobs a moment's turns reported or ran: each id once, with its title. */
export function jobsOf(entries: LedgerEntry[], turns: string[]): Array<{ id: string; title: string }> {
  const mine = new Set(turns);
  const out = new Map<string, string>();
  for (const e of entries) {
    if (!mine.has(str(e.turn))) continue;
    const id = e.kind === "job" ? str(e.job) : str(e.jobId);
    if (ID.test(id) && !out.has(id)) out.set(id, str(e.jobTitle) || str(e.title));
  }
  return [...out].map(([id, title]) => ({ id, title }));
}

/** One job's runs, oldest first, from every entry read of its chat. */
export function jobWork(entries: LedgerEntry[], id: string): JobWork {
  const of = entries.filter((e) => str(e.jobId) === id || (e.kind === "job" && str(e.job) === id));
  const byTurn = new Map<string, LedgerEntry[]>();
  for (const e of of) if (str(e.turn)) byTurn.set(str(e.turn), [...(byTurn.get(str(e.turn)) ?? []), e]);
  // A run's entries are the job's and its turn's: the report turn's thinking and review carry no `jobId`.
  const held = new Set(of);
  for (const e of entries) if (byTurn.has(str(e.turn)) && !held.has(e)) byTurn.get(str(e.turn))!.push(e);
  const runs = [...byTurn].map(([turn, list]): JobRun => {
    const sorted = [...list].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.at - b.at);
    const verdict = sorted.findLast((e) => e.kind === "job");
    const reply = sorted.findLast((e) => e.kind === "reply");
    const first = Math.min(...sorted.map((e) => e.at - (e.kind === "reply" ? 0 : (num(e.ms) ?? 0))));
    return {
      turn,
      start: Math.min(first, reply && num(reply.ms) !== null ? reply.at - num(reply.ms)! : first),
      end: Math.max(...sorted.map((e) => e.at)),
      state: verdict ? str(verdict.state) || null : null,
      advice: verdict ? str(verdict.advice) || null : null,
      report: verdict ? str(verdict.report) || null : null,
      said: reply ? str(reply.text) || null : null,
      model: reply ? str(reply.model) || null : null,
      thinking: sorted.filter((e) => e.kind === "thinking").map((e) => ({ at: e.at, ms: num(e.ms), text: str(e.text) })),
      tools: sorted.filter((e) => e.kind === "tool").map((e) => ({ at: e.at, name: str(e.name), ok: e.ok !== false, ms: num(e.ms), args: e.args, result: e.result ?? e.error ?? null })),
      steps: sorted.filter((e) => (e.kind === "step" && e.step !== "timing") || e.kind === "advisor" || e.kind === "judge"),
    };
  });
  runs.sort((a, b) => a.start - b.start);
  const title = str(of.find((e) => str(e.jobTitle) || str(e.title))?.jobTitle) || str(of.find((e) => e.kind === "job")?.title) || "Background job";
  return { id, title, runs };
}

/** A job check's verdict in words. */
export const stateWords = (s: string | null) => (s === "keep_going" ? "kept going" : s === "done" ? "done" : s === "stuck" ? "stuck" : s ?? "no check");

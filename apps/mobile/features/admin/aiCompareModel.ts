/**
 * What Compare reads beyond the scores (board 20 of the AI tools plan): the
 * replies the bench kept where the setups differed, what a candidate still
 * needs before it can go live, and how live has done on a case before, so a
 * case that flips on live reads as one.
 *
 * The replies note (`ai/results/<round> replies.md`, `apps/mcp/bench/replies.mjs`)
 * is written beside the scores note: one run per setup on each case where one
 * setup passed every run and another did not.
 */

import { splitFront } from "./aiNotes";
import type { Candidate, CaseCell, JobPage, RunRead } from "./aiModel";

export interface Reply {
  setup: string;
  run: number;
  of: number;
  passed: boolean;
  /** `must: say Tuesday`, one per rule the run missed. */
  missed: string[];
  turns: { from: "person" | "reply"; text: string }[];
}

export interface RepliesCase {
  question: number;
  title: string;
  replies: Reply[];
}

/** The replies note beside a scores note. */
export const repliesPathOf = (scoresPath: string): string => scoresPath.replace(/ scores\.md$/, " replies.md");

/** A replies note read into cases, by question; anything it cannot read is left out. */
export function parseReplies(text: string): Map<number, RepliesCase> {
  const { body } = splitFront(text);
  const cases = new Map<number, RepliesCase>();
  let current: RepliesCase | null = null;
  let reply: Reply | null = null;
  for (const line of body.split("\n")) {
    let match: RegExpMatchArray | null;
    if ((match = line.match(/^## (\d+)\. (.*)$/))) {
      current = { question: Number(match[1]), title: match[2].trim(), replies: [] };
      cases.set(current.question, current);
      reply = null;
    } else if (current !== null && (match = line.match(/^### (.+?) · run (\d+) of (\d+) · (passed|failed)$/))) {
      reply = { setup: match[1], run: Number(match[2]), of: Number(match[3]), passed: match[4] === "passed", missed: [], turns: [] };
      current.replies.push(reply);
    } else if (reply !== null && (match = line.match(/^- missed (.+)$/))) {
      reply.missed.push(match[1]);
    } else if (reply !== null && (match = line.match(/^> (Person|Reply): (.*)$/))) {
      reply.turns.push({ from: match[1] === "Person" ? "person" : "reply", text: match[2] });
    }
  }
  return cases;
}

/** A setup's reply on a case; live's is under its name, or `production` when the round named it so. */
export function replyOf(item: RepliesCase, setup: string, live = false): Reply | null {
  return item.replies.find((reply) => reply.setup === setup) ?? (live ? (item.replies.find((reply) => reply.setup === "production") ?? null) : null);
}

export interface GateLine {
  ok: boolean;
  label: string;
  /** When, or what is missing, small. */
  note: string | null;
}

/**
 * What a candidate needs before Make it live: better than live with its whole
 * range above zero, not merely too close; and every case group run with it,
 * none of them with a failed gate. The ML review of 2026-10-16: one group
 * passing says nothing about the others, and a single flipped run is noise.
 */
export function goLiveGates(page: JobPage, candidate: Candidate): GateLine[] {
  const lines: GateLine[] = [];
  const word = candidate.status === "beat live" ? "Better than live" : candidate.status === "too close" ? "Too close to call" : candidate.status === "lost" ? "Worse than live" : "Not compared yet";
  lines.push({ ok: candidate.status === "beat live", label: candidate.status === "beat live" ? "Better than live, beyond the noise" : `Better than live: ${word.toLowerCase()}`, note: candidate.run?.day ?? null });
  for (const group of page.row.tests) {
    const runs = page.runs.filter((run) => run.row.test === group.name && run.read !== null);
    const last = [...runs].reverse().find((run) => run.read?.setups.some((setup) => setup.setup === candidate.name));
    const title = group.title || group.name;
    if (last === undefined) {
      lines.push({ ok: false, label: `${title}: not run with this setup`, note: null });
      continue;
    }
    const mine = last.read?.setups.find((setup) => setup.setup === candidate.name);
    const failed = mine?.gatesFailed ?? [];
    lines.push({
      ok: failed.length === 0,
      label: failed.length === 0 ? `${title}: no gate failed` : `${title}: gate failed on ${failed.map((n) => `case ${n}`).join(", ")}`,
      note: last.row.day,
    });
  }
  return lines;
}

/**
 * Live's results on one case in the rounds before `until` (all of them
 * without one), newest last, at most
 * `count`: `3/3 · 2/3 · 3/3`. A case live fails now and then is noise, not a
 * finding, and Compare says so beside it.
 */
export function liveHistory(page: JobPage, test: string, question: number, liveName: string, until: string | null = null, count = 4): CaseCell[] {
  const cells: CaseCell[] = [];
  for (const { row, read } of page.runs) {
    if (row.path === until) break;
    if (row.test !== test || read === null || read.cases === null) continue;
    const found = read.cases.find((item) => item.question === question);
    const cell = found ? (found.cells[liveName] ?? found.cells.production) : undefined;
    if (cell !== undefined) cells.push(cell);
  }
  return cells.slice(-count);
}

/** `3/3 · 2/3 · 3/3, flips`, `3/3 every time`, or `1/3 · 2/3, fails every time`. */
export function historyLabel(cells: readonly CaseCell[]): string {
  if (cells.length === 0) return "no earlier rounds";
  const shown = cells.map((cell) => `${cell.passed}/${cell.runs}`);
  if (cells.every((cell) => cell.passed === cell.runs)) return `${shown[0]} every time`;
  const misses = cells.filter((cell) => cell.passed < cell.runs).length;
  return `${shown.join(" · ")}${misses === cells.length ? ", fails every time" : ", flips"}`;
}

/** The round a candidate's score is from, read; null before it has one. */
export const roundOf = (page: JobPage, candidate: Candidate): RunRead | null =>
  candidate.run === null ? null : (page.runs.find((run) => run.row.path === candidate.run?.path)?.read ?? null);

/**
 * Replay, the Lab's read-only mode (Dev2, 2026-11-14: "there should be some type of toggle for replays versus the lab
 * ... the replay is just showing inputs and outputs and maybe showing some settings ... I want to sort of like click
 * through different chats and click through different conversations and see how that went through ... replay
 * sequences of text, like see how queuing works when like multiple texts are sent").
 *
 * A chat's conversation is cut into moments: the person's texts in a row and what Tex said back. Each moment gets a
 * timeline read from the chat's ledger, in milliseconds from its first text:
 * - Texts: each text that came in;
 * - Judge: each judging by the texting Worker's decide (`step` entries named "decide": while nothing ran, which texts
 *   one turn answers; while a turn ran, fold it in, queue it or restart);
 * - Turn: each turn, from its reply's timing: the wait in the queue, then the turn itself;
 * - Sent: each text Tex sent.
 */
import type { LedgerEntry } from "../../page/texPageTypes";
import type { ChatLine } from "./mine";

export type BarKind = "text" | "judge" | "wait" | "turn" | "sent";
/** `zero` is where a turn's own timeline starts (its wait in the queue included), for the canvas. */
export type Bar = { kind: BarKind; start: number; end: number; label: string; turn?: string; zero?: number; detail?: string };
export type Lane = "Texts" | "Judge" | "Turn" | "Sent";
export type Moment = {
  id: string;
  /** When its first text came in (epoch ms): the timeline's zero. */
  at: number;
  lines: ChatLine[];
  lanes: Record<Lane, Bar[]>;
  /** How long the whole moment ran, from its first text to its last send. */
  of: number;
  /** The turns that answered it, in the order they started. */
  turns: string[];
};

const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const cut = (t: string, n = 28) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

/** What one decide judging said, in a few words. */
export function judgeWords(output: unknown, running: boolean): string {
  const o = rec(output);
  if (!o) return "no answer";
  const mid = str(o.midTurn);
  if (running && mid) return mid === "fold" ? "fold it in" : mid === "restart" ? "restart" : "queue it";
  const act = str(o.act);
  if (act === "answer") return running ? "queue it" : "answer";
  if (act === "react") return "tapback";
  if (act === "silent" || act === "quiet") return "stay quiet";
  if (act === "wait") return "wait for more";
  return act || "judged";
}

/** The chat's lines cut into moments: a moment starts at a person's text that follows something Tex said. */
export function momentsOf(lines: ChatLine[], entries: LedgerEntry[]): Moment[] {
  const groups: ChatLine[][] = [];
  for (const l of lines) {
    const last = groups[groups.length - 1];
    if (!last || (l.from === "person" && last[last.length - 1].from === "tex")) groups.push([l]);
    else last.push(l);
  }
  const starts = groups.map((g) => g[0].at);
  return groups.map((g, i) => {
    const t0 = g[0].at;
    // A moment's work runs until the next one starts (or a minute past its last line, for the newest).
    const until = starts[i + 1] ?? g[g.length - 1].at + 60_000;
    const inside = (at: number) => at >= t0 - 1_000 && at < until;
    const rel = (at: number) => Math.max(0, at - t0);
    const lanes: Record<Lane, Bar[]> = { Texts: [], Judge: [], Turn: [], Sent: [] };
    for (const l of g) {
      if (l.from === "person") lanes.Texts.push({ kind: "text", start: rel(l.at), end: rel(l.at) + 250, label: cut(l.text) });
      else lanes.Sent.push({ kind: "sent", start: rel(l.at), end: rel(l.at) + 400, label: cut(l.text) });
    }
    const turns: Array<[number, string]> = [];
    for (const e of entries) {
      if (!inside(e.at)) continue;
      const step = rec(e.step);
      if (e.kind === "step" && step && step.name === "decide") {
        const ms = num(step.ms) ?? 300;
        const running = step.of === "running";
        const words = step.ok === false ? "couldn't judge" : judgeWords(step.output, running);
        lanes.Judge.push({ kind: "judge", start: rel(e.at - ms), end: rel(e.at), label: words, detail: running ? "while a turn ran" : "waiting texts" });
      }
      if (e.kind === "reply" && typeof e.turn === "string") {
        const timing = rec(e.timing);
        const replyMs = num(timing?.replyMs) ?? num(e.ms);
        if (replyMs === null) continue;
        const wait = num(timing?.waitMs) ?? 0;
        const end = rel(e.at);
        const start = Math.max(0, end - replyMs - wait);
        if (wait > 0) lanes.Turn.push({ kind: "wait", start, end: start + wait, label: "waiting", turn: e.turn, zero: start });
        lanes.Turn.push({ kind: "turn", start: start + wait, end, label: cut(str(e.text) || "answer", 22), turn: e.turn, zero: start });
        turns.push([start, e.turn]);
      }
    }
    for (const k of Object.keys(lanes) as Lane[]) lanes[k].sort((a, b) => a.start - b.start);
    const of = Math.max(1_000, ...Object.values(lanes).flat().map((b) => b.end));
    return { id: g[0].id, at: t0, lines: g, lanes, of, turns: turns.sort((a, b) => a[0] - b[0]).map(([, t]) => t) };
  });
}

/** The turn under the timeline's head: the one that started last at or before `at` (its wait included). */
export function turnAt(m: Moment, at: number): { turn: string; start: number } | null {
  let best: { turn: string; start: number } | null = null;
  for (const b of m.lanes.Turn) if (b.turn && b.zero !== undefined && b.zero <= at && (!best || b.zero >= best.start)) best = { turn: b.turn, start: b.zero };
  return best;
}

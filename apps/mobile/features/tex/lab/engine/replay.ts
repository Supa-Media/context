/**
 * Replay, the Lab's read-only mode (Dev2, 2026-11-14: "there should be some type of toggle for replays versus the lab
 * ... the replay is just showing inputs and outputs and maybe showing some settings ... I want to sort of like click
 * through different chats and click through different conversations and see how that went through ... replay
 * sequences of text, like see how queuing works when like multiple texts are sent").
 *
 * A chat's conversation is cut into moments, one from each text someone sent. Each moment gets a
 * timeline read from the chat's ledger, in milliseconds from its first text:
 * - Texts: each text that came in;
 * - Judge: each judging by the texting Worker's decide (`step` entries named "decide": while nothing ran, which texts
 *   one turn answers; while a turn ran, fold it in, queue it or restart);
 * - Turn: each turn, from its reply's timing: the wait in the queue, then the turn itself;
 * - Sent: each text Tex sent.
 */
import type { LedgerEntry } from "../../page/texPageTypes";
import { routineName, type ChatLine, type Start } from "./mine";

export type BarKind = "text" | "judge" | "wait" | "turn" | "sent";
/** `zero` is where a turn's own timeline starts (its wait in the queue included), for the canvas. */
export type Bar = {
  kind: BarKind;
  start: number;
  end: number;
  label: string;
  turn?: string;
  zero?: number;
  detail?: string;
  /** On a turn: the Tex version that ran it, from its reply. */
  version?: { code?: string; deploy?: string; setup?: string } | null;
};
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
  /** What started it: a text someone sent, or a check-in, a routine or another AI's ping. */
  from: "text" | Start;
};

/** How a start step reads on the timeline and in the chat. */
export const START_WORDS: Record<Start, string> = { checkin: "Check-in", routine: "Routine", notify: "Send through Tex" };
export const startLabel = (l: ChatLine) => (l.start === "routine" && l.routine ? `Routine · ${routineName(l.routine)}` : l.start ? START_WORDS[l.start] : "");
/** What a quiet check-in's line reads, where a text would be. */
export const QUIET_WORDS = "Looked, and nothing was worth a text";

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

/**
 * One moment per text someone sent, so any text can be replayed from (Dev2, 2026-11-14: "why not just have the ability
 * to replay from any text"). A moment runs from its text until the next text that follows something Tex said, so the
 * texts that came in behind it, the judge's calls on them and the turns that answered them all show on its clock. A
 * turn already running when the text came in starts before zero; its bar is drawn from zero and it plays from where it
 * was.
 */
export function momentsOf(lines: ChatLine[], entries: LedgerEntry[]): Moment[] {
  // Where each run of texts begins: a person's text that follows something Tex said.
  const breaks: number[] = [];
  lines.forEach((l, i) => {
    if (i === 0 || l.start || (l.from === "person" && lines[i - 1].from === "tex")) breaks.push(l.at);
  });
  const out: Moment[] = [];
  lines.forEach((first, i) => {
    if (first.from !== "person" && !first.start) return;
    // Tex texting on its own: its turn ran before the text went, so the moment starts where that turn's first entry did.
    const own = first.start && first.turn ? entries.filter((e) => e.turn === first.turn) : [];
    const t0 = own.length ? Math.min(first.at, ...own.map((e) => e.at - (num(e.ms) ?? 0))) : first.at;
    const next = breaks.find((b) => b > first.at);
    const last = lines[lines.length - 1].at;
    const until = next ?? Math.max(first.at, last) + 60_000;
    const g = lines.slice(i).filter((l) => l.at < until);
    const inside = (at: number) => at >= t0 - 1_000 && at < until;
    const rel = (at: number) => Math.max(0, at - t0);
    const lanes: Record<Lane, Bar[]> = { Texts: [], Judge: [], Turn: [], Sent: [] };
    if (first.start) lanes.Texts.push({ kind: "text", start: 0, end: 250, label: startLabel(first) });
    for (const l of g) {
      if (l.from === "person") lanes.Texts.push({ kind: "text", start: rel(l.at), end: rel(l.at) + 250, label: cut(l.text) });
      else if (!l.quiet) lanes.Sent.push({ kind: "sent", start: rel(l.at), end: rel(l.at) + 400, label: cut(l.text) });
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
        const end = e.at - t0;
        const zero = end - replyMs - wait;
        const version = rec(e.version) ? (e.version as Bar["version"]) : undefined;
        if (wait > 0 && zero + wait > 0) lanes.Turn.push({ kind: "wait", start: Math.max(0, zero), end: zero + wait, label: "waiting", turn: e.turn, zero, version });
        lanes.Turn.push({ kind: "turn", start: Math.max(0, zero + wait), end: Math.max(0, end), label: cut(str(e.text) || "answer", 22), turn: e.turn, zero, version, detail: str(e.text) });
        turns.push([zero, e.turn]);
      }
    }
    // Its own turn kept no reply timing (a routine's or a check-in's): drawn from its first entry to the text it sent.
    if (first.start && first.turn && !turns.some(([, t]) => t === first.turn)) {
      lanes.Turn.push({ kind: "turn", start: 0, end: rel(first.at), label: cut(first.text || QUIET_WORDS, 22), turn: first.turn, zero: 0, detail: first.text || QUIET_WORDS });
      turns.push([0, first.turn]);
    }
    for (const k of Object.keys(lanes) as Lane[]) lanes[k].sort((a, b) => a.start - b.start);
    const of = Math.max(1_000, ...Object.values(lanes).flat().map((b) => b.end));
    out.push({ id: first.id, at: t0, lines: g, lanes, of, turns: turns.sort((a, b) => a[0] - b[0]).map(([, t]) => t), from: first.start ?? "text" });
  });
  return out;
}

/**
 * Replay reads only what was logged once every part of a turn was written down (Dev2, 2026-11-14: "the logging from
 * before our changes are a little broken, can you make sure that replay only works after the proper logging is in
 * place"). Every step's input, output and time (#3265), the Tex version on each reply (#3267) and the texting
 * Worker's judging and tapbacks (#3269) were all live in production by this moment; a moment that began earlier
 * would replay with holes, so it is left out.
 */
export const LOGGED_FROM = Date.UTC(2026, 10, 13, 23, 52);

/**
 * The moments Replay can show: cut from the whole chat first, so a moment's edges stay where they were. A text Tex sent
 * on its own with no turn logged (a check-in before #3280 kept its steps only in tex/heartbeat/) has nothing to walk
 * through from what started it to what it sent, so it is left out like any moment from before full logging.
 */
export const loggedMoments = (ms: Moment[]) => ms.filter((m) => m.at >= LOGGED_FROM && (m.from === "text" || !!m.lines[0]?.turn));

/** The turn under the timeline's head: the one that started last at or before `at` (its wait included). */
export function turnAt(m: Moment, at: number): { turn: string; start: number } | null {
  let best: { turn: string; start: number } | null = null;
  for (const b of m.lanes.Turn) if (b.turn && b.zero !== undefined && b.zero <= at && (!best || b.zero >= best.start)) best = { turn: b.turn, start: b.zero };
  return best;
}

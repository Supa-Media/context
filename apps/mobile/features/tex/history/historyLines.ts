/**
 * The chat's history, as the lines the history view draws: one line a message,
 * time, who, words, grouped by day and by turn, newest day first and each day
 * in the order it happened (decided by the owner, 2026-11-02: "one
 * history file and then different views, so I can see today, I can see
 * yesterday, I can filter out thinking, I can see tool calls", drawn
 * left-aligned, one line each, Slack style). Pure, so the page and the console
 * draw the same lines from the same entries.
 */

import type { LedgerEntry, LedgerKind } from "../page/texPageTypes";
import type { TurnTimingSource } from "./turnTiming";

/** What the view can show or hide, and the ledger kinds each one is. */
export const SHOWS = ["texts", "tools", "thinking", "background"] as const;
export type Show = (typeof SHOWS)[number];

/**
 * "Background" was "Notes" until the owner asked "what is a note?"
 * (2026-11-02): it is what happened outside a text, a routine's run, an
 * answer given in another app, the advisor, the Mail checker and jobs, and
 * each of its lines now says which.
 */
export const SHOW_LABEL: Record<Show, string> = { texts: "Texts", tools: "Tool calls", thinking: "Thinking", background: "Background" };

/**
 * `reply` is left out of Texts: it is Tex's answer as it left the gateway, the
 * same words as Tex's own `text` entries, and showing both would say
 * everything twice.
 */
export const SHOW_KINDS: Record<Show, LedgerKind[]> = {
  texts: ["text"],
  tools: ["tool", "judge"],
  thinking: ["thinking", "said"],
  background: ["note", "advisor", "mail_check", "job"],
};

/** Thinking is off until asked for: it is the longest and the least often wanted. */
/**
 * There is no Jobs filter: a job's work is always read, folded under its own
 * line (Dev, 2026-11-03: "why can't i see the background jobs thinking and
 * actions", then the Jobs artboard approved).
 */
export const DEFAULT_SHOWN: Record<Show, boolean> = { texts: true, tools: true, thinking: false, background: true };

/** The ledger kinds to ask for; every kind the view shows when all four are on. `timing`: @context-lc editors also read each turn's `reply`, for where its time went (`turnTiming.ts`), and the calls it times. */
export function kindsFor(shown: Record<Show, boolean>, { timing = false }: { timing?: boolean } = {}): LedgerKind[] {
  const kinds = SHOWS.filter((s) => shown[s]).flatMap((s) => SHOW_KINDS[s]);
  return timing && shown.texts ? [...kinds, "reply", ...(shown.tools ? [] : (["tool"] as LedgerKind[]))] : kinds;
}

/** Which day the view shows. */
export type DayChoice = "today" | "yesterday" | "all" | "pick";

export const DAY_LABEL: Record<DayChoice, string> = { today: "Today", yesterday: "Yesterday", all: "All days", pick: "Pick a day" };

/** A day as the gateway takes it, `YYYY-MM-DD`, on this device's calendar. */
export function dayKey(at: number | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The day to ask the gateway for, or undefined for every day; a picked day only once it is whole. */
export function dayAsked(choice: DayChoice, picked: string, now: Date): string | undefined {
  if (choice === "today") return dayKey(now);
  if (choice === "yesterday") return dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  if (choice === "pick") return /^\d{4}-\d{2}-\d{2}$/.test(picked.trim()) ? picked.trim() : undefined;
  return undefined;
}

export interface HistoryLine {
  id: string;
  /** `9:41 AM` on a text, "" on the lines between texts. */
  time: string;
  /** Who sent a text ("Tex", a name, "You"), "" for anything else. */
  who: string;
  /** "tex" for Tex's texts, so they can be told apart at a glance. */
  tone: "text" | "tex" | "quiet" | "thinking";
  text: string;
  /** The message a text answers, in full (Dev2, 2026-11-05): who sent it and its words, from this view or the words kept with the reply. */
  replyTo?: string;
  /** The reactions on this text, under it as in the mock: `👍 Mom, Ada · ❤️ You`. */
  reactions?: string;
  /** The job whose work this is, by its title, when a job's turn wrote it. */
  job?: string;
  /** A run of tool calls drawn as one line (`text` sums them up); these are the calls, opened on a tap. */
  calls?: HistoryLine[];
  /** A background job's line: its work, folded under it (`foldJobs`). */
  run?: HistoryJob;
  /** On a turn's first text from Tex, for @context-lc editors: where the turn's time went (`turnTiming.ts`). */
  timing?: TurnTimingSource;
  entry: LedgerEntry;
}

/**
 * A background job as one line of the day, its work under it: who is `Tex ·
 * Minion 1`, numbered in the order the day's jobs began (Dev, 2026-11-03: "i
 * like the mock, maybe label it as Tex · Minion 1/2/3").
 */
export interface HistoryJob {
  key: string;
  minion: number;
  /** `done`, `running`, `waiting` or `stuck`, from its newest `job` entry; null when none is in view. */
  state: string | null;
  /** How many turns the job took at it. */
  tries: number;
  /** Its thinking, calls and checks, in the order they happened. */
  steps: HistoryLine[];
}

export interface HistoryTurn {
  id: string;
  lines: HistoryLine[];
}

export interface HistoryDay {
  key: string;
  title: string;
  turns: HistoryTurn[];
}

const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const oneLine = (v: unknown): string => str(v).replace(/\s+/g, " ").trim();
const short = (v: unknown, most: number): string => {
  const s = oneLine(v);
  return s.length > most ? `${s.slice(0, most - 1)}…` : s;
};

/** `9:41 AM`, on this device's clock. */
export function timeOf(at: number): string {
  const d = new Date(at);
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Who sent a text: Tex, Context, the person's name, or "You" in a person's own chat. */
function whoOf(e: LedgerEntry, group: boolean): string {
  const from = record(e.from);
  const kind = str(from?.kind);
  if (kind === "tex") return "Tex";
  if (kind === "system") return "Context";
  const name = oneLine(from?.name).replace(/^@+/, "");
  if (!group) return "You";
  return name || "Someone";
}

/** What a text was beside its words: a picture, a file, a link, a reaction. */
const EVENT_WORDS: Record<string, string> = { picture: "sent a picture", file: "sent a file", link: "sent a link", reaction: "reacted" };

function textWords(e: LedgerEntry): string {
  const words = oneLine(e.text);
  const what = e.heard === "voice" ? "sent a voice message" : EVENT_WORDS[str(e.event)];
  if (what === undefined) return words;
  return words ? `(${what}) ${words}` : `(${what})`;
}

function toolWords(e: LedgerEntry): string {
  const how = e.withheld ? "result withheld (another workspace)" : e.held ? "held" : e.ok === false ? "failed" : "";
  return [str(e.name) || "tool", how].filter(Boolean).join(" · ");
}

/**
 * One judging of a draft reply (`apps/mcp/src/agent/replyJudge.js`): which
 * draft, whether it went out or went back, the judges that failed with their
 * score against their threshold, and the draft (Dev2, 2026-11-05: "so we can
 * see how responses were shaped along the way").
 */
export function judgeWords(e: LedgerEntry): string {
  const judges = Array.isArray(e.judges) ? (e.judges as unknown[]).map(record).filter((j): j is Record<string, unknown> => j !== null) : [];
  const round = typeof e.round === "number" ? e.round : 0;
  const by = e.by === "code" ? "checks" : "judges";
  const outcome = e.went === true ? "went out" : "sent back";
  const num = (v: unknown) => (typeof v === "number" ? v.toFixed(2) : "–");
  const failed = judges.filter((j) => j.passed !== true).map((j) => `${str(j.id)} ${num(j.yes)} ≥ ${num(j.at)}`);
  const passed = judges.length - failed.length;
  const tally = judges.length === 0 ? "" : failed.length === 0 ? `all ${judges.length} passed` : `${failed.join(", ")}${passed ? ` · ${passed} passed` : ""}`;
  return [`${by} · draft ${round + 1} · ${outcome}`, tally, oneLine(e.reason), `"${short(e.text, 160)}"`].filter(Boolean).join(" · ");
}

function lineOf(e: LedgerEntry, group: boolean): HistoryLine {
  const job = oneLine(e.jobTitle) || (typeof e.jobId === "string" ? "a job" : "");
  const line = lineOfKind(e, group);
  return job && e.kind !== "job" && !(e.kind === "advisor" && e.check) ? { ...line, job } : line;
}

function lineOfKind(e: LedgerEntry, group: boolean): HistoryLine {
  const base = { id: e.id, entry: e };
  const quiet = (text: string): HistoryLine => ({ ...base, time: "", who: "", tone: "quiet", text });
  switch (e.kind) {
    case "text": {
      const who = whoOf(e, group);
      return { ...base, time: timeOf(e.at), who, tone: who === "Tex" ? "tex" : "text", text: textWords(e) };
    }
    case "thinking":
    case "said":
      return { ...base, time: "", who: "", tone: "thinking", text: oneLine(e.text) };
    case "tool":
      // The advisor asked mid-turn: its answer is what Tex was told.
      if (e.name === "ask_advisor" && typeof e.result === "string") return quiet(`advisor · ${short(e.result, 240)}`);
      return quiet(toolWords(e));
    case "advisor":
      return quiet(e.check ? `advisor · ${oneLine(e.question)} ${oneLine(e.answer)}` : `advisor · asked: ${oneLine(e.question)}`);
    case "mail_check":
      return quiet(`mail checker · email to ${short(e.to, 60)} · ${str(e.verdict) || "checked"}${oneLine(e.why) ? ` · ${short(e.why, 120)}` : ""}`);
    case "judge":
      return quiet(judgeWords(e));
    case "job":
      return quiet(`job · ${oneLine(e.title) || str(e.job)} · ${str(e.state).replace(/_/g, " ")}`);
    case "note":
      if (typeof e.routine === "string") return quiet(`routine · ${short(e.routine.replace(/\.md$/, ""), 60)} · ${oneLine(e.text)}`);
      // A message another of their agents asked Tex to pass on: that agent's words, never Tex's.
      if (typeof e.about === "string" && /another of their agents asked you/i.test(e.about)) return quiet(`passed on from another agent · ${oneLine(e.text)}`);
      if (typeof e.about === "string" && e.about) return quiet(`answered in another app · ${short(e.about, 80)} · ${oneLine(e.text)}`);
      return quiet(oneLine(e.text));
    default:
      return quiet(oneLine(e.text) || e.kind);
  }
}

/**
 * A reaction, as the texting Worker keeps it: the tapback answered as an
 * emoji alone (`👍`), or noted as `👍 (yes) on Tex's message "…"`, or taken
 * back (`took back 👍 on …`). Null for a text that isn't one.
 */
function reactionOf(e: LedgerEntry): { emoji: string; on: string | null; removed: boolean } | null {
  if (e.kind !== "text") return null;
  const words = oneLine(e.text);
  const noted = /^(took back )?(\S+)(?: \((?:yes|no)\))? on (?:Tex's message|the message|a message)(?: "(.*?)(?:…)?")?$/u.exec(words);
  if (noted) return { emoji: noted[2]!, on: noted[3] ?? null, removed: noted[1] !== undefined };
  // An answered tapback is kept as its emoji alone, marked as a reaction.
  if (str(e.event) === "reaction" && words !== "" && !/[\p{L}\p{N}]/u.test(words) && [...words].length <= 4) return { emoji: words, on: null, removed: false };
  return null;
}

/**
 * Which text a reaction is on, among the texts before it (`older`, newest
 * first): the one whose words it quotes, or, when it quotes none (an answered
 * tapback), the newest text before it from someone else, which is the text it
 * answered. Null when that text isn't in view.
 */
function reactedTo(e: LedgerEntry, on: string | null, older: readonly LedgerEntry[], group: boolean): LedgerEntry | null {
  const who = whoOf(e, group);
  for (const o of older) {
    if (o.kind !== "text" || reactionOf(o) !== null) continue;
    if (on !== null ? oneLine(o.text).startsWith(on) : whoOf(o, group) !== who) return o;
  }
  return null;
}

/** `👍 Mom, Ada · ❤️ You`: who reacted with what, in the order they did. */
function reactionWords(byEmoji: Map<string, string[]>): string {
  return [...byEmoji].filter(([, people]) => people.length > 0).map(([emoji, people]) => `${emoji} ${people.join(", ")}`).join(" · ");
}

/** A run of tool calls as one line: `12 tool calls · browse ×9, vault_list ×2, write_note · 3 failed`. */
function callsLine(calls: HistoryLine[]): HistoryLine {
  const counts = new Map<string, number>();
  let failed = 0;
  for (const c of calls) {
    const name = str(c.entry.name) || "tool";
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (c.entry.ok === false) failed += 1;
  }
  const names = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ");
  const first = calls[0]!;
  return { id: `calls:${first.id}`, entry: first.entry, ...(first.job ? { job: first.job } : {}), time: "", who: "", tone: "quiet", text: [`${calls.length} tool calls`, names, failed > 0 ? `${failed} failed` : ""].filter(Boolean).join(" · "), calls };
}

/** Two or more tool calls in a row in a turn are one line, opened on a tap (Dev, 2026-11-02: "the tool calls should be collapsed somehow"). */
function collapseCalls(lines: HistoryLine[]): HistoryLine[] {
  const out: HistoryLine[] = [];
  let run: HistoryLine[] = [];
  const close = () => {
    if (run.length > 1) out.push(callsLine(run));
    else out.push(...run);
    run = [];
  };
  for (const line of lines) {
    if (line.entry.kind === "tool" && line.entry.name !== "ask_advisor" && (run.length === 0 || run[0]!.job === line.job)) run.push(line);
    else if (line.entry.kind === "tool" && line.entry.name !== "ask_advisor") {
      close();
      run.push(line);
    }
    else {
      close();
      out.push(line);
    }
  }
  close();
  return out;
}

/** `Today`, `Yesterday`, or `Saturday, Oct 31`. */
export function dayTitle(key: string, now: Date): string {
  if (key === dayKey(now)) return "Today";
  if (key === dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return "Yesterday";
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

/**
 * The entries (newest first, as the gateway answers) as days of turns: the
 * newest day first, and each day in the order it happened. An entry with no
 * turn is a turn of its own, but a person's text joins the turn just after it. `group` names people by name rather
 * than "You".
 */
export function historyDays(entries: readonly LedgerEntry[], now: Date, { group = false, thinking = false, fold = true, timing = false, tools = true }: { group?: boolean; thinking?: boolean; /** Fold each job's work under its line; off on one job's own page, where all of it is that job's. */ fold?: boolean; /** Staff: each turn's first text from Tex carries where the turn's time went. */ timing?: boolean; /** Tool calls are drawn; off, they were read only for the timing. */ tools?: boolean } = {}): HistoryDay[] {
  const timed = timing ? timingByTurn(entries) : new Map<string, TurnTimingSource>();
  // Newest first: an event written again (a voice message once heard) is drawn once, where it first came, in its newest words.
  const byEventId = new Map<string, LedgerEntry>();
  const firstOf = new Map<string, LedgerEntry>();
  for (const e of entries) {
    if (e.kind !== "text" || typeof e.eid !== "string") continue;
    if (!byEventId.has(e.eid)) byEventId.set(e.eid, e);
    firstOf.set(e.eid, e);
  }
  // Reactions go under the text they are on, never on a line of their own, as in the mock; one whose text isn't in view stays a line.
  const reactions = new Map<string, Map<string, string[]>>();
  const folded = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]!;
    const r = reactionOf(e);
    if (r === null) continue;
    const target = reactedTo(e, r.on, entries.slice(i + 1), group);
    if (target === null) continue;
    folded.add(e.id);
    const byEmoji = reactions.get(target.id) ?? new Map<string, string[]>();
    reactions.set(target.id, byEmoji);
    const who = whoOf(e, group);
    if (r.removed) byEmoji.set(r.emoji, (byEmoji.get(r.emoji) ?? []).filter((p) => p !== who));
    else if (!(byEmoji.get(r.emoji) ?? []).includes(who)) byEmoji.set(r.emoji, [...(byEmoji.get(r.emoji) ?? []), who]);
  }
  const days: HistoryDay[] = [];
  for (const listed of entries) {
    const eid = listed.kind === "text" && typeof listed.eid === "string" ? listed.eid : null;
    if (eid !== null && firstOf.get(eid) !== listed) continue;
    const newest = eid !== null ? byEventId.get(eid) : undefined;
    const e: LedgerEntry = newest !== undefined && newest !== listed ? { ...listed, text: newest.text, heard: newest.heard } : listed;
    // A reply is the same words as Tex's texts: only its timing is drawn, on the first of them.
    if (folded.has(e.id) || e.kind === "reply" || (!tools && e.kind === "tool")) continue;
    const key = dayKey(e.at);
    let day = days.at(-1);
    if (day?.key !== key) {
      day = { key, title: dayTitle(key, now), turns: [] };
      days.push(day);
    }
    let turn = day.turns.at(-1);
    // A text from a person is not written by a turn; it belongs with the turn that answered it, just after it.
    const asked = !(typeof e.turn === "string" && e.turn) && e.kind === "text" && str(record(e.from)?.kind) === "person";
    const turnId = typeof e.turn === "string" && e.turn ? `t:${e.turn}` : asked && turn?.id.startsWith("t:") ? turn.id : `e:${e.id}`;
    if (turn?.id !== turnId) {
      turn = { id: turnId, lines: [] };
      day.turns.push(turn);
    }
    const line = lineOf(e, group);
    if (e.kind === "text" && line.tone === "tex" && typeof e.turn === "string") {
      // Newest first: the last one met is the turn's first text out.
      const source = timed.get(e.turn);
      if (source !== undefined) {
        for (const other of turn.lines) delete other.timing;
        line.timing = source;
      }
    }
    const answered = typeof e.replyTo === "string" ? byEventId.get(e.replyTo) : undefined;
    if (answered !== undefined) line.replyTo = `${whoOf(answered, group)}: ${textWords(answered)}`;
    else if (typeof e.quoted === "string" && e.quoted.trim() !== "") line.replyTo = oneLine(e.quoted); // replied-to message outside this view: the words kept with the reply
    const on = reactions.get(e.id);
    if (on !== undefined && reactionWords(on) !== "") line.reactions = reactionWords(on);
    // The advisor's own thinking, kept beside its answer, shown under it with Thinking on.
    const thought = oneLine(e.thinking);
    // Newest first in, oldest first within a turn: the thinking goes in first, so it reads after the answer.
    if (thinking && thought && (e.kind === "advisor" || (e.kind === "tool" && e.name === "ask_advisor"))) turn.lines.unshift({ id: `${e.id}:thinking`, entry: e, time: "", who: "", tone: "thinking", text: `advisor thinking · ${thought}`, ...(line.job ? { job: line.job } : {}) });
    turn.lines.unshift(line);
  }
  // Each day reads top to bottom as it happened; the newest day comes first.
  for (const day of days) {
    day.turns.reverse();
    for (const turn of day.turns) turn.lines = collapseCalls(turn.lines);
    if (fold) foldJobs(day, jobStates(entries));
  }
  return days;
}

/** Each turn's reply, the texts Tex sent and the calls it made, for the turns whose reply kept timing. */
function timingByTurn(entries: readonly LedgerEntry[]): Map<string, TurnTimingSource> {
  const out = new Map<string, TurnTimingSource>();
  for (const e of entries) if (e.kind === "reply" && typeof e.turn === "string" && e.timing && !out.has(e.turn)) out.set(e.turn, { reply: e, sent: [], tools: [] });
  for (const e of entries) {
    const source = typeof e.turn === "string" ? out.get(e.turn) : undefined;
    if (source === undefined) continue;
    if (e.kind === "text" && str(record(e.from)?.kind) === "tex") source.sent.push(e);
    else if (e.kind === "tool") source.tools.push(e);
  }
  return out;
}

/** Which job a line is the work of: the job its turn ran for, or the job a `job` entry is about. */
function jobKey(e: LedgerEntry): string | null {
  if (typeof e.jobId === "string" && e.jobId) return e.jobId;
  return e.kind === "job" && typeof e.job === "string" && e.job ? e.job : null;
}

const STATE_WORDS: Record<string, string> = { started: "running", keep_going: "running", waiting: "waiting", done: "done", stuck: "stuck" };

/** Each job's newest state and title, from its `job` entries (newest first, as read). */
function jobStates(entries: readonly LedgerEntry[]): Map<string, { state: string; title: string }> {
  const out = new Map<string, { state: string; title: string }>();
  for (const e of entries) {
    if (e.kind !== "job" || typeof e.job !== "string") continue;
    const was = out.get(e.job);
    const title = oneLine(e.title);
    if (was === undefined) out.set(e.job, { state: STATE_WORDS[str(e.state)] ?? str(e.state).replace(/_/g, " "), title });
    else if (!was.title && title) was.title = title;
  }
  return out;
}

/**
 * A day's job work folded under one line a job, where the job began: its
 * thinking, calls and checks open under it. What a job texted the person stays
 * in the chat, from `Tex · Minion N`; its `job` entries are its state.
 */
function foldJobs(day: HistoryDay, states: Map<string, { state: string; title: string }>): void {
  const runs = new Map<string, HistoryLine>();
  for (const turn of day.turns) {
    const kept: HistoryLine[] = [];
    for (const line of turn.lines) {
      const key = jobKey(line.entry);
      if (key === null) {
        kept.push(line);
        continue;
      }
      let head = runs.get(key);
      if (head === undefined) {
        const known = states.get(key);
        const title = known?.title || oneLine(line.entry.jobTitle) || oneLine(line.entry.title) || "A job";
        const run: HistoryJob = { key, minion: runs.size + 1, state: known?.state ?? null, tries: 0, steps: [] };
        head = { id: `job:${day.key}:${key}`, time: timeOf(line.entry.at), who: `Tex · Minion ${run.minion}`, tone: "tex", text: title, entry: line.entry, run };
        runs.set(key, head);
        kept.push(head);
      }
      if (line.entry.kind === "text") kept.push({ ...line, job: undefined, who: head.who, tone: "tex" });
      else if (line.entry.kind !== "job") head.run!.steps.push({ ...line, job: undefined, ...(line.calls ? { calls: line.calls.map((c) => ({ ...c, job: undefined })) } : {}) });
    }
    turn.lines = kept;
  }
  for (const head of runs.values()) {
    const run = head.run!;
    run.tries = new Set(run.steps.flatMap((s) => s.calls ?? [s]).map((s) => s.entry.turn).filter((t) => typeof t === "string" && t)).size;
  }
  day.turns = day.turns.filter((turn) => turn.lines.length > 0);
}

/** `3 tries · 14 steps`: what a job's line says it holds. */
export function jobCount(run: HistoryJob): string {
  const steps = run.steps.reduce((n, s) => n + (s.calls?.length ?? 1), 0);
  return [run.tries > 1 ? `${run.tries} tries` : "", steps === 1 ? "1 step" : `${steps} steps`].filter(Boolean).join(" · ");
}

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

/** What the view can show or hide, and the ledger kinds each one is. */
export const SHOWS = ["texts", "tools", "thinking", "notes"] as const;
export type Show = (typeof SHOWS)[number];

export const SHOW_LABEL: Record<Show, string> = { texts: "Texts", tools: "Tool calls", thinking: "Thinking", notes: "Notes" };

/**
 * `reply` is left out of Texts: it is Tex's answer as it left the gateway, the
 * same words as Tex's own `text` entries, and showing both would say
 * everything twice.
 */
export const SHOW_KINDS: Record<Show, LedgerKind[]> = {
  texts: ["text"],
  tools: ["tool"],
  thinking: ["thinking", "said"],
  notes: ["note", "advisor", "mail_check", "job"],
};

/** Thinking is off until asked for: it is the longest and the least often wanted. */
export const DEFAULT_SHOWN: Record<Show, boolean> = { texts: true, tools: true, thinking: false, notes: true };

/** The ledger kinds to ask for; every kind the view shows when all four are on. */
export function kindsFor(shown: Record<Show, boolean>): LedgerKind[] {
  return SHOWS.filter((s) => shown[s]).flatMap((s) => SHOW_KINDS[s]);
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
  /** The message a text answers, in a few words, when it names one this view holds. */
  replyTo?: string;
  entry: LedgerEntry;
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
  const what = EVENT_WORDS[str(e.event)];
  if (what === undefined) return words;
  return words ? `(${what}) ${words}` : `(${what})`;
}

function toolWords(e: LedgerEntry): string {
  const how = e.withheld ? "result withheld (another workspace)" : e.held ? "held" : e.ok === false ? "failed" : "";
  return [str(e.name) || "tool", how].filter(Boolean).join(" · ");
}

function lineOf(e: LedgerEntry, group: boolean): HistoryLine {
  const base = { id: e.id, entry: e };
  switch (e.kind) {
    case "text": {
      const who = whoOf(e, group);
      return { ...base, time: timeOf(e.at), who, tone: who === "Tex" ? "tex" : "text", text: textWords(e) };
    }
    case "thinking":
    case "said":
      return { ...base, time: "", who: "", tone: "thinking", text: oneLine(e.text) };
    case "tool":
      return { ...base, time: "", who: "", tone: "quiet", text: toolWords(e) };
    case "advisor":
      return { ...base, time: "", who: "", tone: "quiet", text: `asked the advisor: ${oneLine(e.question)}` };
    case "mail_check":
      return { ...base, time: "", who: "", tone: "quiet", text: `email to ${short(e.to, 60)} · ${str(e.verdict) || "checked"}` };
    case "job":
      return { ...base, time: "", who: "", tone: "quiet", text: `${oneLine(e.title) || str(e.job)} · ${str(e.state)}` };
    default:
      return { ...base, time: "", who: "", tone: "quiet", text: oneLine(e.text) || e.kind };
  }
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
export function historyDays(entries: readonly LedgerEntry[], now: Date, { group = false }: { group?: boolean } = {}): HistoryDay[] {
  const byEventId = new Map<string, LedgerEntry>();
  for (const e of entries) if (e.kind === "text" && typeof e.eid === "string") byEventId.set(e.eid, e);
  const days: HistoryDay[] = [];
  for (const e of entries) {
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
    const answered = typeof e.replyTo === "string" ? byEventId.get(e.replyTo) : undefined;
    if (answered !== undefined) line.replyTo = `${whoOf(answered, group)}: ${short(textWords(answered), 60)}`;
    // Newest first in, oldest first within a turn.
    turn.lines.unshift(line);
  }
  // Each day reads top to bottom as it happened; the newest day comes first.
  for (const day of days) day.turns.reverse();
  return days;
}

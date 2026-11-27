/**
 * A bot's helpers: the sessions it starts for deep work (Claude Code headless, `claude -p`), each a sub-agent of its
 * bot. Read from the notes the page already holds, one note per helper at `bots/<bot>/helpers/<date>-<slug>.md`, whose
 * front matter says what the row draws. Nothing here is a store of its own.
 *
 *   kind: helper                       (or a helper_id: line, as the gateway writes it)
 *   helper: Claude                     who the helper is (its app's name)
 *   task: Fix the reading-list search miss
 *   status: working | waiting | done | stopped
 *   started: 2026-11-27T18:58:00Z
 *   ended: 2026-11-27T16:20:00Z        when done or stopped
 *   ends: 2026-11-28T03:06:00Z         when its time runs out; past it, a live one reads stopped
 *   progress: Opened PR #3744, CI running
 *   usage: 2                           percent of the bot's week, when it said
 *
 * A helper is always named with its bot, "Claude via Grok Bot", never a bare "Claude": `helperName`.
 */

import type { ListNote } from "../../listBlock/model";

export type HelperStatus = "working" | "waiting" | "done" | "stopped";

export interface Helper {
  readonly path: string;
  /** "Claude". */
  readonly helper: string;
  /** "Claude via Grok Bot". */
  readonly name: string;
  readonly task: string;
  readonly status: HelperStatus;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** Its last progress line, or null. */
  readonly progress: string | null;
  /** Percent of the bot's week, or null when it said none. */
  readonly usage: number | null;
}

/** "Claude via Grok Bot": the one way a helper is named, anywhere it shows. */
export const helperName = (helper: string, bot: string) => `${helper} via ${bot}`;

/** "Claude via Grok Bot" → { helper: "Claude", bot: "Grok Bot" }; null for any other name. */
export function splitHelperName(name: string): { helper: string; bot: string } | null {
  const match = /^(.+?) via (.+)$/.exec(name.trim());
  return match === null ? null : { helper: match[1]!, bot: match[2]! };
}

const STATUSES: readonly HelperStatus[] = ["working", "waiting", "done", "stopped"];
const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const time = (value: unknown) => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(at) ? null : at;
};

/** The helpers in the folder beside its card, `bots/<bot>/helpers/`, live first (newest first), then ended (newest first). */
export function helpersOf(bot: { name: string; card: { path: string } }, notes: readonly ListNote[], now: number = Date.now()): Helper[] {
  // Beside its card, wherever the card is (`bots/<bot>/about.md` → `bots/<bot>/helpers/`).
  const folder = `${bot.card.path.slice(0, bot.card.path.lastIndexOf("/") + 1)}helpers/`;
  const helpers: Helper[] = [];
  for (const note of notes) {
    if (!note.path.startsWith(folder) || note.path.slice(folder.length).includes("/")) continue;
    const p = note.properties as Record<string, unknown>;
    if (p.kind !== "helper" && typeof p.helper_id !== "string") continue;
    const said = STATUSES.includes(p.status as HelperStatus) ? (p.status as HelperStatus) : "working";
    // A helper whose time ran out without ending itself still says working; its `ends:` says it stopped then.
    const ends = time(p.ends);
    const lapsed = (said === "working" || said === "waiting") && ends !== null && ends <= now;
    const status: HelperStatus = lapsed ? "stopped" : said;
    const helper = text(p.helper) ?? "Helper";
    const usage = typeof p.usage === "number" ? p.usage : Number.parseFloat(String(p.usage ?? ""));
    helpers.push({
      path: note.path,
      helper,
      name: helperName(helper, bot.name),
      task: text(p.task) ?? note.heading ?? "A task",
      status,
      startedAt: time(p.started),
      endedAt: time(p.ended) ?? (lapsed ? ends : null),
      progress: text(p.progress),
      usage: Number.isFinite(usage) ? usage : null,
    });
  }
  const live = (each: Helper) => each.status === "working" || each.status === "waiting";
  const at = (each: Helper) => (live(each) ? each.startedAt : each.endedAt) ?? 0;
  return helpers.sort((a, b) => Number(live(b)) - Number(live(a)) || at(b) - at(a));
}

export const isLive = (helper: Helper) => helper.status === "working" || helper.status === "waiting";

/** "14 min", "1 h 20 min": how long a live helper has been at it. */
export function sinceWords(from: number | null, now: number): string {
  if (from === null) return "";
  const minutes = Math.max(1, Math.round((now - from) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

/** "11:20 am". */
function clock(at: number): string {
  const date = new Date(at);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  return `${hours % 12 === 0 ? 12 : hours % 12}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "am" : "pm"}`;
}

/** The status as the row says it: "Working · 14 min", "Waiting on an answer · 3 min", "Done 11:20 am". */
export function statusWords(helper: Helper, now: number): string {
  if (helper.status === "working") return `Working · ${sinceWords(helper.startedAt, now)}`;
  if (helper.status === "waiting") return `Waiting on an answer · ${sinceWords(helper.startedAt, now)}`;
  const word = helper.status === "done" ? "Done" : "Stopped";
  return helper.endedAt === null ? word : `${word} ${clock(helper.endedAt)}`;
}

/** "2 helpers working", "1 helper working, 1 waiting"; null when none is live (the Bots page says nothing). */
export function liveLine(helpers: readonly Helper[]): string | null {
  const working = helpers.filter((each) => each.status === "working").length;
  const waiting = helpers.filter((each) => each.status === "waiting").length;
  if (working + waiting === 0) return null;
  if (waiting === 0) return `${working} helper${working === 1 ? "" : "s"} working`;
  if (working === 0) return `${waiting} helper${waiting === 1 ? "" : "s"} waiting on an answer`;
  return `${working} helper${working === 1 ? "" : "s"} working, ${waiting} waiting`;
}

/** "1 done earlier today", "2 ended earlier today": the folded line under the live rows. */
export function endedLine(ended: readonly Helper[], now: number): string {
  const allDone = ended.every((each) => each.status === "done");
  const allStopped = ended.every((each) => each.status === "stopped");
  const word = allDone ? "done" : allStopped ? "stopped" : "ended";
  const today = ended.every((each) => each.endedAt !== null && new Date(each.endedAt).toDateString() === new Date(now).toDateString());
  return `${ended.length} ${word} ${today ? "earlier today" : "this week"}`;
}

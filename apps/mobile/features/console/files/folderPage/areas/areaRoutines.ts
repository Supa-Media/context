/**
 * An area's routines as the side panel draws them (`PanelRoutines.tsx`; Dev approved the artboards, 2026-11-27).
 * Pure: no React, no storage.
 *
 * - **A routine** is a note at `<area>/routines/<how often>/<name>.md` (`@context/shared/src/areaRoutines.cjs`): the
 *   folder says how often, front matter says when (`at`, `on`, `paused`), the body is the job. Its row is drawn from
 *   the note's front matter as the folder page already holds it, so names and schedules show before anything else
 *   is asked.
 * - **Its runs** (next, last, outcome, answer) and the area bot's week come from the workspace object's state,
 *   through the gateway's `/files/area-routines` (`useAreaRoutineState.ts`); `"loading"` until it answers, null
 *   where it can't be asked.
 * - **A draft** is what the editor shows. Repeats is the folder (so changing it moves the note), On is `on:`, At is
 *   `at:` (a list when there are several), the switch is `paused:`.
 */

import { areaRoutineNext, areaRoutineOf, areaRoutineWhen, botCapIn, cardSlug, DEFAULT_ROUTINE_ZONE, MAX_ROUTINE_TIMES, parseWorksIn, type AreaRoutine } from "@context/shared/src/areaRoutines.cjs";
import { pulseTemplates, templatePath, templateText } from "@context/shared/src/areaRoutineTemplates.cjs";
import { mailJoinName } from "@context/shared/src/areaBots.cjs";
import { cadenceFromFolder, frontMatter, parseTime, parseWeekdays } from "@context/shared/src/routines.cjs";
import type { ListNote, PropertyValue } from "../../listBlock/model";

export type Outcome = "sent" | "held" | "no_bot" | "failed";
export type Repeats = "Daily" | "Weekly" | "Monthly" | "Hourly";
export const REPEATS: readonly Repeats[] = ["Daily", "Weekly", "Monthly", "Hourly"];

/** One routine as the workspace object's state says it ran. */
export interface RoutineRunState {
  readonly path: string;
  readonly area: string;
  readonly nextAt: number | null;
  readonly lastAt: number | null;
  readonly outcome: Outcome | null;
  readonly bot: string | null;
  readonly answeredAt: number | null;
  readonly problem: string | null;
}

/** The gateway's answer: every routine's runs and each bot's week in each area. */
export interface RoutineState {
  readonly week: string;
  readonly routines: readonly RoutineRunState[];
  readonly usage: readonly { bot: string; area: string; used: number }[];
}

/** What the panel knows of the runs: the answer, still asking, or nothing (no gateway, or it doesn't keep runs). */
export type RoutineStateNow = RoutineState | "loading" | null;

export interface LastRun {
  readonly at: number | null;
  readonly outcome: Outcome | null;
  readonly answeredAt: number | null;
}

export interface RoutineRow {
  readonly path: string;
  readonly title: string;
  /** "Weekdays at 10 am"; "" when it can't be said. */
  readonly when: string;
  readonly mode: string | null;
  readonly paused: boolean;
  /** Why it won't run, in the routine format's own sentence; null when it will. */
  readonly problem: string | null;
  /** When it runs next; undefined while the state loads. */
  readonly next?: number | null;
  /** Its last run; undefined while the state loads, null where no state can be had. */
  readonly last?: LastRun | null;
}

/** The area bot's week here: undefined while loading, null when no bot holds the area. */
export interface RoutineBudget {
  readonly bot: string;
  /** Its share of its week spent here so far, in percent; null where no state can be had. */
  readonly used: number | null;
  /** Its card's cap here, a whole percent of its week; null where no number is written. */
  readonly cap: number | null;
}

/** Reads the gateway's answer by name; null for anything that isn't a served state. */
export function readRoutineState(body: unknown): RoutineState | null {
  if (!body || typeof body !== "object") return null;
  const fields = body as Record<string, unknown>;
  if (fields.served !== true) return null;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const str = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  const outcomes: readonly Outcome[] = ["sent", "held", "no_bot", "failed"];
  const routines: RoutineRunState[] = [];
  for (const raw of Array.isArray(fields.routines) ? fields.routines : []) {
    if (!raw || typeof raw !== "object") continue;
    const one = raw as Record<string, unknown>;
    const path = str(one.path);
    if (path === null) continue;
    routines.push({
      path,
      area: str(one.area) ?? "",
      nextAt: num(one.nextAt),
      lastAt: num(one.lastAt),
      outcome: outcomes.includes(one.outcome as Outcome) ? (one.outcome as Outcome) : null,
      bot: str(one.bot),
      answeredAt: num(one.answeredAt),
      problem: str(one.problem)?.slice(0, 500) ?? null,
    });
  }
  const usage: { bot: string; area: string; used: number }[] = [];
  for (const raw of Array.isArray(fields.usage) ? fields.usage : []) {
    if (!raw || typeof raw !== "object") continue;
    const one = raw as Record<string, unknown>;
    const bot = str(one.bot);
    const area = str(one.area);
    const used = num(one.used);
    if (bot !== null && area !== null && used !== null) usage.push({ bot, area, used });
  }
  return { week: str(fields.week) ?? "", routines, usage };
}

/** A front matter value as its line would read: a list joined with commas, a yes/no as written. */
function lineValue(value: PropertyValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value);
  return text.includes("\n") ? null : text;
}

/** The note's front matter rebuilt from its properties, for the routine format's readers. */
export function frontText(properties: Readonly<Record<string, PropertyValue>>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(properties)) {
    const line = lineValue(value);
    if (line !== null && /^[A-Za-z][\w-]*$/.test(key)) lines.push(`${key}: ${line}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

const word = (value: PropertyValue | undefined) => (typeof value === "string" ? value.trim() : Array.isArray(value) ? String(value[0] ?? "").trim() : "");

/** `revenue-digest` → "Revenue digest". */
function nameWords(name: string): string {
  const words = name.replace(/[-_]+/g, " ").trim();
  return words === "" ? name : words.charAt(0).toUpperCase() + words.slice(1);
}

/** The area's routine notes (not a sub-area's), in path order. */
export function routineNotesOf(area: string, root: string, notes: readonly ListNote[]): { note: ListNote; routine: AreaRoutine }[] {
  const out: { note: ListNote; routine: AreaRoutine }[] = [];
  for (const note of notes) {
    const routine = areaRoutineOf(note.path, root);
    if (routine !== null && routine.area === area) out.push({ note, routine });
  }
  return out.sort((a, b) => a.note.path.localeCompare(b.note.path));
}

/** One row per routine in `area`, with what the state says of its runs. */
export function routineRows(area: string, root: string, notes: readonly ListNote[], state: RoutineStateNow, now: number): RoutineRow[] {
  return routineNotesOf(area, root, notes).map(({ note, routine }) => {
    const text = frontText(note.properties);
    const next = areaRoutineNext(routine, text, now);
    const ran = state !== null && state !== "loading" ? state.routines.find((one) => one.path === note.path) : undefined;
    const paused = (next.settings as { paused?: boolean } | null)?.paused === true;
    const problem = next.problems[0] ?? ran?.problem ?? null;
    const title = word(note.properties.title) || (note.heading ?? "").trim() || nameWords(routine.name);
    const row: RoutineRow = { path: note.path, title, when: areaRoutineWhen(routine, text), mode: word(note.properties.mode) || null, paused, problem };
    if (state === "loading") return row;
    if (state === null) return { ...row, next: next.at, last: null };
    return {
      ...row,
      next: paused || problem !== null ? null : (ran?.nextAt ?? next.at),
      last: ran === undefined ? { at: null, outcome: null, answeredAt: null } : { at: ran.lastAt, outcome: ran.outcome, answeredAt: ran.answeredAt },
    };
  });
}

/** The bot routines are sent to: a bot owner, or a person owner's delegate bot; never Tex. */
export function areaBotOf(owner: string | null, delegate: string | null, isBot: (name: string) => boolean): string | null {
  if (owner === null) return null;
  if (isBot(owner)) return owner;
  if (!owner.startsWith("@") || delegate === null || delegate.trim().toLowerCase() === "tex") return null;
  return isBot(delegate) ? delegate : null;
}

/** The bot's week in `area`: its card's cap here (none where no number is written) and what the state says it used. */
export function budgetOf(area: string, bot: string | null, worksIn: PropertyValue | undefined, state: RoutineStateNow, botSlug?: string): RoutineBudget | null | undefined {
  if (state === "loading") return undefined;
  if (bot === null) return null;
  const cap = botCapIn(parseWorksIn(worksIn), area);
  // The workspace object counts usage under the bot's mail name (`mailJoinName`), which cuts a long name short.
  const names = new Set([cardSlug(bot), cardSlug(mailJoinName(bot)), ...(botSlug === undefined ? [] : [cardSlug(botSlug)])]);
  const used = state === null ? null : (state.usage.find((one) => one.area.toLowerCase() === area.toLowerCase() && names.has(cardSlug(one.bot)))?.used ?? 0);
  return { bot, used, cap };
}

const ZONE = DEFAULT_ROUTINE_ZONE;

function civil(ms: number): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(ms);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** Eastern, 12-hour: "today 10:12 am", "tomorrow 9 am", "Mon 10 am", "Nov 1, 4:20 pm". */
export function clockAt(ms: number, now: number): string {
  const time = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hour: "numeric", minute: "2-digit", hour12: true })
    .format(ms)
    .replace(/\u202f|\u00a0/g, " ")
    .replace(":00", "")
    .replace(" AM", " am")
    .replace(" PM", " pm");
  const a = civil(ms);
  const b = civil(now);
  const away = Math.round((Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)) / 86_400_000);
  if (away === 0) return `today ${time}`;
  if (away === 1) return `tomorrow ${time}`;
  if (away === -1) return `yesterday ${time}`;
  if (Math.abs(away) < 7) return `${new Intl.DateTimeFormat("en-US", { timeZone: ZONE, weekday: "short" }).format(ms)} ${time}`;
  return `${new Intl.DateTimeFormat("en-US", { timeZone: ZONE, month: "short", day: "numeric" }).format(ms)}, ${time}`;
}

// ── Drafts ───────────────────────────────────────────────────────────────────

export interface Draft {
  readonly name: string;
  readonly repeats: Repeats;
  /** The folder it is in now, kept while Repeats still says the same (`every-2-weeks` stays). */
  readonly folder: string;
  /** 0 = Monday. */
  readonly days: readonly number[];
  /** "9 am", "1:30 pm". */
  readonly times: readonly string[];
  readonly everyHours: number;
  readonly paused: boolean;
  /** `on:` for a monthly one (`1st`, `last`), kept as written. */
  readonly monthDay: string | null;
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAY_WORDS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** `{hour: 13, minute: 30}` → "1:30 pm". */
export function timeWords(at: { hour: number; minute: number }): string {
  const hour = at.hour % 12 === 0 ? 12 : at.hour % 12;
  return `${hour}${at.minute === 0 ? "" : `:${String(at.minute).padStart(2, "0")}`} ${at.hour < 12 ? "am" : "pm"}`;
}

/** A time typed in the editor, "2pm" or "14:00", as the chip says it; null when it isn't one. */
export function readTime(typed: string): string | null {
  const at = parseTime(typed);
  return at === null ? null : timeWords(at);
}

function repeatsOf(folder: string): { repeats: Repeats; everyHours: number } {
  const cadence = cadenceFromFolder(folder);
  if (cadence?.unit === "hour") return { repeats: "Hourly", everyHours: cadence.every };
  if (cadence?.unit === "week") return { repeats: "Weekly", everyHours: 3 };
  if (cadence?.unit === "month") return { repeats: "Monthly", everyHours: 3 };
  return { repeats: "Daily", everyHours: 3 };
}

/** A new routine's draft: every day at 9 am. */
export function blankDraft(): Draft {
  return { name: "", repeats: "Daily", folder: "daily", days: ALL_DAYS, times: ["9 am"], everyHours: 3, paused: false, monthDay: null };
}

/** The draft a routine note is now. */
export function draftOf(note: ListNote, title: string): Draft {
  const routine = /\/routines\/([^/]+)\/[^/]+$/.exec(note.path);
  const folder = routine?.[1] ?? "daily";
  const { repeats, everyHours } = repeatsOf(folder);
  const fields = frontMatter(frontText(note.properties));
  const at = (fields.at ?? "").replace(/^\s*\[|\]\s*$/g, "");
  const times = at.split(",").map((item) => readTime(item.trim().replace(/^["']|["']$/g, ""))).filter((item): item is string => item !== null);
  const sunday = repeats === "Monthly" || fields.on === undefined ? null : parseWeekdays(fields.on);
  const days = sunday === null ? (repeats === "Weekly" ? [0] : ALL_DAYS) : sunday.map((day) => (day + 6) % 7).sort((a, b) => a - b);
  const paused = /^(yes|true|on|y)$/i.test(fields.paused ?? "");
  return { name: title, repeats, folder, days, times, everyHours, paused, monthDay: repeats === "Monthly" ? (fields.on ?? null) : null };
}

/** The folder a draft's Repeats says. */
export function folderOf(draft: Draft): string {
  const kept = repeatsOf(draft.folder);
  if (draft.repeats === "Hourly") return draft.everyHours <= 1 ? "hourly" : `every-${draft.everyHours}-hours`;
  if (kept.repeats === draft.repeats && cadenceFromFolder(draft.folder) !== null) return draft.folder;
  return draft.repeats.toLowerCase();
}

/** Repeats changed: On and At follow what the new one can say. */
export function withRepeats(draft: Draft, repeats: Repeats): Draft {
  if (repeats === draft.repeats) return draft;
  const times = repeats === "Hourly" ? [] : draft.times.length === 0 ? ["9 am"] : draft.times;
  const days = repeats === "Weekly" && draft.days.length === 7 ? [0] : draft.repeats === "Monthly" || repeats === "Hourly" ? ALL_DAYS : draft.days;
  return { ...draft, repeats, times, days, monthDay: null };
}

function onValue(draft: Draft): string | null {
  if (draft.repeats === "Hourly") return null;
  if (draft.repeats === "Monthly") return draft.monthDay;
  const sorted = [...draft.days].sort((a, b) => a - b);
  if (draft.repeats === "Daily" && sorted.length === 7) return null;
  const key = sorted.join(",");
  if (key === "0,1,2,3,4") return "weekdays";
  if (key === "5,6") return "weekends";
  if (sorted.length === 7) return "every day";
  return sorted.map((day) => WEEKDAY_WORDS[day]).join(", ");
}

/** `at:` as written: one time bare, several as a list. */
function atValue(draft: Draft): string | readonly string[] | null {
  if (draft.repeats === "Hourly" || draft.times.length === 0) return null;
  const written = draft.times.map((time) => time.replace(" ", ""));
  return written.length === 1 ? written[0]! : written;
}

/** The front matter lines a draft writes: `on`, `at` and `paused`. */
export function draftFields(draft: Draft): readonly (readonly [string, string | readonly string[] | null])[] {
  return [
    ["on", onValue(draft)],
    ["at", atValue(draft)],
    ["paused", draft.paused ? "true" : null],
  ];
}

/** What changed between two drafts, as property writes. */
export function draftChanges(before: Draft, after: Draft): readonly (readonly [string, string | readonly string[] | null])[] {
  const was = new Map(draftFields(before).map(([key, value]) => [key, JSON.stringify(value)]));
  return draftFields(after).filter(([key, value]) => was.get(key) !== JSON.stringify(value));
}

function fieldsText(draft: Draft): string {
  const lines = ["---"];
  for (const [key, value] of draftFields(draft)) if (value !== null) lines.push(`${key}: ${Array.isArray(value) ? `[${value.join(", ")}]` : value}`);
  lines.push("---", "");
  return lines.join("\n");
}

/** The draft's schedule in words, as its row will say it: "Weekdays at 9 am, 1 pm and 5 pm"; "" when it can't be. */
export function draftWords(area: string, root: string, draft: Draft): string {
  const routine = areaRoutineOf(`${area}/routines/${folderOf(draft)}/x.md`, root);
  return areaRoutineWhen(routine, fieldsText({ ...draft, paused: false }));
}

/** A new routine's note: where it goes and its text, the schedule and the name as its heading. */
export function newRoutineNote(area: string, draft: Draft): { path: string; text: string } | { error: string } {
  const name = draft.name.trim();
  if (name === "") return { error: "Give the routine a name." };
  if (draft.times.length > MAX_ROUTINE_TIMES) return { error: `A routine runs at most ${MAX_ROUTINE_TIMES} times a day.` };
  const slug = cardSlug(name);
  if (slug === "") return { error: "Give the routine a name with a letter or a number in it." };
  return { path: `${area}/routines/${folderOf(draft)}/${slug}.md`, text: `${fieldsText(draft)}# ${name}\n\n` };
}

/** Where a routine note goes when its folder changes. */
export function movedPath(path: string, folder: string): string {
  return path.replace(/\/routines\/[^/]+\/([^/]+)$/, `/routines/${folder}/$1`);
}

/**
 * Turn on pulse checks, as `manage area { pulse: true }` does (`apps/mcp/src/tools/notes/areaPulse.js`): each template
 * the area's modes ask for is written where none is, and one an earlier pulse paused is resumed; any other is kept.
 */
export function pulsePlan(area: string, modes: readonly string[], notes: readonly ListNote[]): { create: { path: string; text: string }[]; resume: string[] } {
  const create: { path: string; text: string }[] = [];
  const resume: string[] = [];
  for (const template of pulseTemplates(modes)) {
    const path = templatePath(area, template);
    const there = notes.find((note) => note.path.toLowerCase() === path.toLowerCase());
    if (there === undefined) create.push({ path, text: templateText(template) });
    else if (/^(yes|true)$/i.test(lineValue(there.properties.paused) ?? "") && word(there.properties.template) !== "") resume.push(there.path);
  }
  return { create, resume };
}

/** Whether pulse checks are on: a routine a pulse wrote (its `template:` line) runs here, unpaused. */
export function pulseNow(area: string, root: string, notes: readonly ListNote[]): { on: boolean } {
  return {
    on: routineNotesOf(area, root, notes).some(({ note }) => word(note.properties.template) !== "" && !/^(yes|true)$/i.test(lineValue(note.properties.paused) ?? "")),
  };
}

/** What pulse checks would add, by title: "Improve metric loop and Manager loop". */
export function pulseTitles(modes: readonly string[]): string[] {
  return pulseTemplates(modes).map((template) => template.title);
}

export const ROUTINE_ZONE_WORDS = "New York time";

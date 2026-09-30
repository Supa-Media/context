/**
 * The Activity page: the audit trail as sentences a person can read.
 *
 * The trail used to be a wall of rows reading "agent session renewed ·
 * someone@example.com · 2 minutes ago", one per console load, and a tester
 * called it "actually disgusting". The events are unchanged; this is only how
 * they are drawn:
 *
 *  - **Sentences, not labels.** "Seyi edited Board update" rather than
 *    "Edited a note" over an email and a path.
 *  - **Days.** Today, Yesterday, then dates, so the time on a row can be short.
 *  - **Routine sign-ins are hidden unless asked for.** The in-app agent renews
 *    its sign-in on every load (`agent.session.*`); that is a real event and
 *    stays one tap away, but it is not a change to the workspace.
 *  - **Filters** by what a person is looking for: notes, people and sharing,
 *    or connected apps; and by who, from the people in the trail.
 *  - **Repeats fold** (`auditGroups.ts`), within a day, after hiding and
 *    filtering, so what is left still reads in order.
 *
 * Pure and React-free, like `advanced.ts`.
 */

import { baseName } from "../files/paths";
import { auditActionLabel, auditDetailLine, type ConsoleAuditEvent } from "./advanced";
import { groupAuditEvents, type AuditGroup } from "./auditGroups";

export type ActivityFilter = "all" | "notes" | "people" | "apps";

export const ACTIVITY_FILTERS: ReadonlyArray<{ key: ActivityFilter; label: string }> = [
  { key: "all", label: "Everything" },
  { key: "notes", label: "Notes" },
  { key: "people", label: "People & sharing" },
  { key: "apps", label: "Apps" },
];

/**
 * Which filter an action answers to, by its family. An action this build has
 * never heard of lands in none of the three and still shows under Everything,
 * the same read-openly rule `auditActionLabel` follows.
 */
export function activityCategory(action: string): Exclude<ActivityFilter, "all"> | null {
  if (/^(file|folder|visibility)\./.test(action)) return "notes";
  if (/^(member|invitation|share|privacy)\./.test(action)) return "people";
  if (/^(grant|oauth|agent|plugin)\./.test(action)) return "apps";
  return null;
}

/**
 * The in-app agent keeping its own sign-in alive. Recorded every console load
 * and every expiry, which is correct for a trail and noise on a page.
 */
export function isRoutineActivity(action: string): boolean {
  return action.startsWith("agent.session.");
}

export interface ActivityActor {
  /** What the sentence calls them. */
  name: string;
  /** Drawn as a robot rather than a face: an AI app, never a person. */
  isAgent: boolean;
}

export interface ActivityRow {
  key: string;
  actor: ActivityActor;
  /**
   * The sentence in three parts so the two names can be bold: "Seyi" "edited"
   * "Board update". `actor` is null when the label already says who, like
   * "A plugin reached the internet".
   */
  sentence: { actor: string | null; verb: string; subject: string | null; rest?: string };
  /** A second line: where a move went, or a plugin's detail line. */
  detail: string | null;
  /**
   * Every note a several-note row stands for, by name, so "See the 3 notes"
   * can open them in place. Empty for a row about one note or none.
   */
  notes: string[];
  /** "4 min ago", "6:12 PM", or "12 times · 9:03 AM to 6:12 PM". */
  when: string;
  count: number;
}

export interface ActivityDay {
  label: string;
  rows: ActivityRow[];
}

export interface ActivityPage {
  days: ActivityDay[];
  /** Routine sign-ins left out, so the switch can say how many. */
  hiddenRoutine: number;
  /** True when every hidden sign-in happened today, so the line can say "today". */
  hiddenRoutineToday: boolean;
  /**
   * Everybody who appears in the trail under the current kind filter, for the
   * "Anyone" menu: names, in the order they first appear (newest first).
   */
  people: string[];
}

/**
 * Who acted, in the words the sentence uses. A member's name where the
 * console knows it (by user id, or by their email when the event carries only
 * that), then their email, then an AI app's name; never a raw id.
 */
export function activityActor(
  event: ConsoleAuditEvent,
  names: ReadonlyMap<string, string>,
): ActivityActor {
  const email = event.actorEmail?.trim();
  const known =
    (event.actorUserId === undefined ? undefined : names.get(event.actorUserId)?.trim()) ||
    (email ? names.get(email.toLowerCase())?.trim() : undefined);
  if (known) return { name: known, isAgent: false };
  if (email) return { name: email, isAgent: false };
  const client = event.actorClientId?.trim();
  if (client) return { name: client, isAgent: true };
  if (event.actorUserId !== undefined) return { name: "Someone who has left", isAgent: false };
  return { name: "Context", isAgent: true };
}

/**
 * "1-projects/board-update.md" → "board-update", the name a note is shown by.
 * Not contained here: `ActivityPanel` isolates every name it draws.
 */
function noteName(path: string): string {
  const leaf = baseName(path);
  return leaf.replace(/\.md$/i, "") || leaf;
}

function folderOf(path: string): string | null {
  const at = path.lastIndexOf("/");
  return at <= 0 ? null : path.slice(0, at);
}

/**
 * The sentence for one event. Labels with "a note" in them name the note instead
 * ("edited Board update"); a label that already names its subject ("A plugin
 * reached the internet") stands alone; anything else is the actor and the
 * label lowercased ("Seyi invited somebody").
 */
function sentenceFor(
  event: ConsoleAuditEvent,
  actor: ActivityActor,
): { sentence: ActivityRow["sentence"]; detail: string | null; notes: string[] } {
  const label = auditActionLabel(event.action);
  const pluginLine = auditDetailLine(event);
  if (/^A /.test(label)) {
    return { sentence: { actor: null, verb: label, subject: null }, detail: pluginLine, notes: [] };
  }
  const verb = label.charAt(0).toLowerCase() + label.slice(1);
  const first = event.paths[0];
  const noteAt = verb.search(/ a note( |$)/);
  if (first !== undefined && noteAt >= 0) {
    const moves = event.action === "file.move" || event.action === "file.copy";
    const rest = verb.length > noteAt + 7 ? { rest: verb.slice(noteAt + 7) } : {};
    if (moves) {
      return {
        sentence: { actor: actor.name, verb: verb.slice(0, noteAt), subject: noteName(first), ...rest },
        detail: event.paths[1] !== undefined ? `to ${folderOf(event.paths[1]) ?? "the top level"}` : null,
        notes: [],
      };
    }
    if (event.paths.length === 1) {
      /*
        No folder line under one note: the artboard drew the sentence alone,
        and "1-projects" under "edited Board update" was a path read as a
        second fact. A move keeps its line, because there the folder is the news.
      */
      return {
        sentence: { actor: actor.name, verb: verb.slice(0, noteAt), subject: noteName(first), ...rest },
        detail: null,
        notes: [],
      };
    }
    const notes = event.paths.map(noteName);
    const folders = new Set(event.paths.map((path) => folderOf(path) ?? ""));
    const [folder] = [...folders];
    const oneFolder = folders.size === 1 && folder !== undefined && folder !== "";
    return {
      sentence: oneFolder
        ? {
            actor: actor.name,
            verb: verb.slice(0, noteAt),
            subject: `${notes.length} notes`,
            rest: ` in ${folder}`,
          }
        : {
            actor: actor.name,
            verb: verb.slice(0, noteAt),
            // Only the name is bold; the count is part of the sentence.
            subject: notes[0] ?? "",
            rest: ` and ${notes.length - 1} more${rest.rest ?? ""}`,
          },
      detail: null,
      notes,
    };
  }
  return {
    sentence: { actor: actor.name, verb, subject: null },
    detail: pluginLine ?? (event.paths.length > 0 ? event.paths.join(", ") : null),
    notes: [],
  };
}

function startOfDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function dayLabel(dayStart: number, now: number): string {
  const today = startOfDay(now);
  if (dayStart === today) return "Today";
  if (dayStart === startOfDay(today - 1)) return "Yesterday";
  return new Date(dayStart).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * "4m", "1h": today's times on a phone, where "4 minutes ago" wraps the
 * sentence beside it onto a third line. The artboard's phone frame drew these.
 */
export function shortAgo(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

/** "4 min ago", "1 hr ago": today's times beside a sentence, as the artboard drew them. */
function minutesAgo(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} hr ago`;
}

function whenFor(group: AuditGroup, today: boolean, now: number, short: boolean): string {
  const show = (at: number) =>
    today ? (short ? shortAgo(at, now) : minutesAgo(at, now)) : clock(at);
  const latest = show(group.event.at);
  if (group.count === 1) return latest;
  const first = show(group.firstAt);
  return first === latest ? `${group.count} times · ${latest}` : `${group.count} times · ${first} to ${latest}`;
}

/** Newest-first events in, the page to draw out. */
export function buildActivity(
  events: readonly ConsoleAuditEvent[],
  options: {
    filter: ActivityFilter;
    showRoutine: boolean;
    /** One person's rows only, by the name the sentence uses; absent for anyone. */
    who?: string | null;
    /** Today's times as "4m" rather than "4 min ago" (a phone). */
    short?: boolean;
    now: number;
    /** Member names by user id, so a sentence says "Seyi" rather than an email. */
    names?: ReadonlyMap<string, string>;
  },
): ActivityPage {
  const names = options.names ?? new Map<string, string>();
  const today = startOfDay(options.now);
  let hiddenRoutine = 0;
  let hiddenRoutineToday = true;
  const people: string[] = [];
  const who = options.who ?? null;
  const kept = events.filter((event) => {
    if (options.filter !== "all" && activityCategory(event.action) !== options.filter) {
      return false;
    }
    const name = activityActor(event, names).name;
    if (!options.showRoutine && isRoutineActivity(event.action)) {
      if (who === null || who === name) {
        hiddenRoutine += 1;
        if (startOfDay(event.at) !== today) hiddenRoutineToday = false;
      }
      return false;
    }
    if (!people.includes(name)) people.push(name);
    return who === null || who === name;
  });

  const days: ActivityDay[] = [];
  let run: ConsoleAuditEvent[] = [];
  let runDay: number | null = null;
  const flush = () => {
    if (runDay === null || run.length === 0) return;
    const isToday = runDay === today;
    days.push({
      label: dayLabel(runDay, options.now),
      rows: groupAuditEvents(run).map((group) => {
        const actor = activityActor(group.event, names);
        const { sentence, detail, notes } = sentenceFor(group.event, actor);
        return {
          key: group.event.eventId,
          actor,
          sentence,
          detail,
          notes,
          when: whenFor(group, isToday, options.now, options.short === true),
          count: group.count,
        };
      }),
    });
  };
  for (const event of kept) {
    const day = startOfDay(event.at);
    if (day !== runDay) {
      flush();
      run = [];
      runDay = day;
    }
    run.push(event);
  }
  flush();
  return { days, hiddenRoutine, hiddenRoutineToday: hiddenRoutine > 0 && hiddenRoutineToday, people };
}

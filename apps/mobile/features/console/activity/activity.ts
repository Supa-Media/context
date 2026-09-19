/**
 * What the console draws for `activity.md`, decided outside a component.
 *
 * The file, its format and its substance rules are
 * `packages/shared/src/activity.cjs`; this is the viewing layer's arithmetic.
 * It is a `.ts` beside the components for the reason `foot.ts` and `tabs.ts`
 * give: a rule expressed inside a component is a rule nothing holds, and every
 * one of these — which row carries a dot, what the foot line says, where the
 * unread line sits — is a rule somebody will want to change without reading
 * JSX.
 *
 * ## The whole feature, in three sentences
 *
 * A dot on a tree row says something under it is new to you. The line at the
 * foot of the tree says how much, and opens the list. Everything else is that
 * list, drawn in two places — a popover, and the file itself opened as a page.
 */

import {
  actorLabel,
  folderOf,
  nameOf,
} from "@context/shared/src/activity.cjs";
import { displayName, displayPath } from "../files/paths";

export { ACTIVITY_PATH } from "@context/shared/src/activity.cjs";
/*
  Re-exported rather than reached for directly by the page, for the reason the
  rest of this file exists: the console imports its activity vocabulary from
  one module, so a `.cjs` path typed slightly differently in a component is a
  thing that cannot happen.
*/
export { repairPrompt, strayRows } from "@context/shared/src/activity.cjs";

/** One line of the file, as the console receives it. */
export interface ActivityEntry {
  at: string;
  kind: string;
  paths: string[];
  n: number;
  vis: "team" | "private";
  by: string | null;
  via: string | null;
  note: string | null;
}

/**
 * How long an unread marker keeps saying a date rather than a day.
 *
 * Under a week people think in days ("Thursday"); past it they think in dates.
 * The same threshold the rest of the console uses for a note's age.
 */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * How long ago, for a list somebody scans rather than studies.
 *
 * Minutes for the last hour, hours for the last day, then the weekday, then
 * the date — each step the largest unit that still distinguishes two rows.
 * A clock time on a row from three weeks ago is precision nobody asked for and
 * three more characters to read past.
 */
export function relativeWhen(at: string, now: number): string {
  const when = Date.parse(at);
  if (!Number.isFinite(when)) return "";
  const ago = now - when;
  if (ago < MINUTE_MS) return "just now";
  if (ago < HOUR_MS) return `${Math.round(ago / MINUTE_MS)} min`;
  if (ago < DAY_MS) return `${Math.round(ago / HOUR_MS)}h`;
  const date = new Date(when);
  if (ago < WEEK_MS) return DAYS[date.getDay()].slice(0, 3);
  return `${date.getDate()} ${MONTHS[date.getMonth()].slice(0, 3)}`;
}

/** The day a row belongs to, in the reader's own zone. */
export function dayLabel(at: string, now: number): string {
  const when = Date.parse(at);
  if (!Number.isFinite(when)) return "Undated";
  const date = new Date(when);
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(date, today)) return "Today";
  const yesterday = new Date(now - DAY_MS);
  if (sameDay(date, yesterday)) return "Yesterday";
  if (now - when < WEEK_MS) return DAYS[date.getDay()];
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/**
 * The two lines of a row.
 *
 * **Names, not paths.** The shared module's sentence names the full path,
 * which is right for the file — somebody reading `activity.md` in Obsidian has
 * no tree beside them — and wrong in a 240pt column, where it wraps to two
 * lines and ends in an ellipsis over the part that identifies it. This was
 * visible in a browser and in no test: `A meeting landed: 0-inbox/meetings/
 * 2026-0…` is a row that has spent its whole width saying nothing.
 *
 * So the first line names the thing and the second says where it is, which is
 * the order a reader wants and the order the tree beside it already uses.
 *
 * `meta` is the agent's own sentence where it sent one, and the folder
 * otherwise. Never both — two greys under one line is furniture, and the
 * sentence is always the more useful of the two.
 */
export function rowText(entry: ActivityEntry): { title: string; meta: string } {
  const who = actorLabel(entry);
  const first = entry.paths[0] ?? "";
  const last = entry.paths[entry.paths.length - 1] ?? first;
  const many = entry.n > 1;
  const folder = folderOf(last);
  const here = folder === "" ? "the root" : displayName(nameOf(folder));
  /*
    Named the way the tree beside this names the same file: no sort number, no
    `.md`. `displayName`'s own header argues both, and a list that disagreed
    with the tree about what a note is called would be two names for one row.
  */
  const called = (path: string) => displayName(nameOf(path));
  const title = (() => {
    switch (entry.kind) {
      case "added":
        return many ? `${who} added ${entry.n} notes to ${here}` : `${who} added ${called(first)}`;
      case "revised":
        return many
          ? `${who} revised ${entry.n} notes in ${here}`
          : `${who} revised ${called(first)}`;
      case "archived":
        return `${who} archived ${called(first)}`;
      case "moved":
        return many
          ? `${who} moved ${entry.n} notes into ${here}`
          : `${who} moved ${called(first)} to ${here}`;
      case "published":
        return many
          ? `${who} gave the team ${entry.n} notes in ${here}`
          : `${who} gave the team ${called(first)}`;
      case "meeting":
        return `A meeting landed: ${called(first)}`;
      case "session":
        return `${who} saved a session`;
      default:
        return `${who} changed ${called(first)}`;
    }
  })();
  if (entry.note) return { title, meta: entry.note };
  return { title, meta: folder === "" ? called(last) : displayPath(folder) };
}

/** Which mark a row draws. A closed set — see the shared module's `KINDS`. */
export type ActivityMark =
  | "added"
  | "revised"
  | "moved"
  | "archived"
  | "published"
  | "meeting"
  | "session";

export function markFor(entry: ActivityEntry): ActivityMark {
  const kinds: ActivityMark[] = [
    "added",
    "revised",
    "moved",
    "archived",
    "published",
    "meeting",
    "session",
  ];
  return kinds.includes(entry.kind as ActivityMark)
    ? (entry.kind as ActivityMark)
    : "revised";
}

/** Where a row goes when it is pressed, or `null` where nothing can be opened. */
export function targetOf(entry: ActivityEntry): string | null {
  // The destination, for a move: the source is where it is not any more.
  const last = entry.paths[entry.paths.length - 1] ?? null;
  if (last === null) return null;
  return last.endsWith(".md") ? last : null;
}

/**
 * How many of these are new to this reader.
 *
 * `null` for a reader who has never looked, which reads as "everything" — the
 * right answer for somebody who just joined, and the one that does not require
 * inventing a moment they arrived.
 */
export function unseenCount(
  entries: readonly ActivityEntry[],
  seenAt: number | null,
  /** The reader's own `@name`, so their own hand is not news to them. */
  me?: string | null,
): number {
  return entries.filter((entry) => isUnseen(entry, seenAt, me)).length;
}

/**
 * Whether one entry is new to this reader.
 *
 * Two rules. The first is the timestamp. The second is that **your own hand in
 * the console is never news to you**: you made that change, you watched it
 * happen, and a console that tells you three things changed when all three
 * were yours is a console nobody believes the fourth time.
 *
 * Your own *client* is a different matter and stays unread: ChatGPT filing
 * something into your context while you were not looking is exactly what the
 * feature was asked for, and "@seyi's ChatGPT" is not @seyi at a keyboard.
 * That is the whole reason the entry carries `via` separately from `by`.
 */
function isUnseen(
  entry: ActivityEntry,
  seenAt: number | null,
  me?: string | null,
): boolean {
  if (me !== undefined && me !== null && entry.by === me && entry.via === null) return false;
  if (seenAt === null) return true;
  const at = Date.parse(entry.at);
  return Number.isFinite(at) && at > seenAt;
}

/**
 * The line at the foot of the file tree.
 *
 * It is the note-count line that is already there, rewritten when there is
 * something to say and left alone when there is not — the whole of "a number
 * of updates at the bottom", and the reason this feature adds no furniture to
 * a screen that had none spare.
 */
export function footLabel(options: {
  unseen: number;
  since: number | null;
  counts: string;
  now: number;
}): string {
  const { unseen, since, counts, now } = options;
  if (unseen <= 0) return counts;
  // Past fifty it stops counting. A precise number is useful at three and
  // noise at sixty, where the only actionable fact is "a lot, and you have
  // been away".
  const many = unseen > 50 ? "50+ updates" : unseen === 1 ? "1 update" : `${unseen} updates`;
  if (since === null) return many;
  const ago = now - since;
  if (ago < HOUR_MS) return `${many} since you looked`;
  if (ago < DAY_MS) return `${many} since this morning`;
  const date = new Date(since);
  if (ago < WEEK_MS) return `${many} since ${DAYS[date.getDay()]}`;
  return `${many} since ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/**
 * Which tree rows carry a dot.
 *
 * A note you have not seen gets one. A folder gets one when it is **collapsed**
 * and something under it is new — so opening a folder moves the dot inward
 * rather than lighting the whole path from the root, which is the version that
 * makes every ancestor permanently marked and the mark meaningless.
 *
 * `expanded` is the set of folder paths the tree has open. Rows the tree is not
 * drawing cost nothing: this returns paths, and the tree marks the ones it has.
 */
export function markedRows(
  unseenPaths: ReadonlySet<string>,
  expanded: ReadonlySet<string>,
): Set<string> {
  const marked = new Set<string>();
  for (const path of unseenPaths) {
    const segments = path.split("/");
    let collapsedAt: string | null = null;
    for (let cut = 1; cut < segments.length; cut += 1) {
      const folder = segments.slice(0, cut).join("/");
      if (!expanded.has(folder)) {
        collapsedAt = folder;
        break;
      }
    }
    marked.add(collapsedAt ?? path);
  }
  return marked;
}

/**
 * Whether a context has moved since this person last looked at it.
 *
 * The dot on *another* workspace's mark, which is the half of this feature
 * that answers the question it was asked for — "especially in shared
 * workspaces too". It is deliberately not an unread *count*: a count would
 * have to be a count of what this reader may see, which cannot be computed
 * from a shared row without opening that context's bucket, and four bucket
 * reads on every console load to decide four pixels is the wrong trade. The
 * number is one press away, inside the context.
 *
 * Both absent is "nothing recorded, nobody looked", which draws nothing.
 */
export function hasNewActivity(
  activityAt: number | null | undefined,
  seenAt: number | null | undefined,
): boolean {
  if (typeof activityAt !== "number") return false;
  return activityAt > (typeof seenAt === "number" ? seenAt : 0);
}

/**
 * Whether being here, right now, should move this reader's marker on its own.
 *
 * This closes a hole the dot on another context's mark opens. `activityAt` is
 * one timestamp for a whole context and cannot know who wrote the line, so a
 * person's *own* console edit stamps it and lights the dot on their own
 * workspace. Inside the context that edit is correctly not news — `isUnseen`
 * drops it for `me` — so the foot line never appears, so there is no popover
 * to close, so nothing ever calls `markSeen` and **the dot never goes out.**
 * A permanent mark is worse than no mark: it stops meaning anything.
 *
 * So: a context you are looking at, whose newest line is not news to you, is a
 * context you are caught up on. The marker moves once, quietly, and the dot
 * goes out. It is not "opening the list marks it read" — that rule is about
 * the case where something *is* unread, and it is untouched: this returns
 * false the moment there is one line this reader has not seen.
 *
 * `loaded` matters. Before the read lands, `entries` is empty and every
 * context would look caught up, which would put out a dot that was telling the
 * truth.
 */
export function shouldCatchUp(
  entries: readonly ActivityEntry[],
  seenAt: number | null,
  loaded: boolean,
  me?: string | null,
): boolean {
  if (!loaded || entries.length === 0) return false;
  if (entries.some((entry) => isUnseen(entry, seenAt, me))) return false;
  // Only when the marker is actually behind: otherwise this fires on every
  // visit to a quiet context and writes a mutation per page load.
  const newest = entries.reduce(
    (latest, entry) => Math.max(latest, Date.parse(entry.at) || 0),
    0,
  );
  return newest > (seenAt ?? 0);
}

/** The note paths in the entries newer than the reader's last visit. */
export function unseenNotePaths(
  entries: readonly ActivityEntry[],
  seenAt: number | null,
  me?: string | null,
): Set<string> {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (!isUnseen(entry, seenAt, me)) continue;
    for (const path of entry.paths) {
      if (path.endsWith(".md")) paths.add(path);
    }
  }
  return paths;
}

/** One thing to draw. The list is flat, because a divider is not a container. */
export type ActivityRow =
  | { kind: "day"; label: string }
  | { kind: "unread"; label: string }
  | { kind: "entry"; entry: ActivityEntry };

/**
 * The list, with its day headings and its unread line.
 *
 * The unread line is a **position in the list**, not a filter on it: catching
 * up moves the marker and shows the same rows it always did, because a list
 * that empties itself when you read it is a list you cannot look back at. It
 * is drawn only when there is something above it and something below it — a
 * marker at the very top of a fully-read list is a claim about nothing.
 */
export function rows(
  entries: readonly ActivityEntry[],
  seenAt: number | null,
  now: number,
  /** The reader's own `@name` — see `isUnseen`. */
  me?: string | null,
): ActivityRow[] {
  const unseen = unseenCount(entries, seenAt, me);
  const out: ActivityRow[] = [];
  let day: string | null = null;
  entries.forEach((entry, index) => {
    if (index === unseen && index > 0 && seenAt !== null) {
      // "Earlier", not "Before 18h" — which is what a relative age reads as
      // when it is used as a heading, and was on the glass before anybody
      // looked at it. The line's job is to separate new from seen; when you
      // last looked is the foot line's sentence, not this one's.
      out.push({ kind: "unread", label: "Earlier" });
      // A day heading after the line, even if the day has not changed: the
      // two sides of the marker are two lists to a reader, and the lower one
      // starting with a bare row reads as part of the upper one.
      day = null;
    }
    const label = dayLabel(entry.at, now);
    if (label !== day) {
      out.push({ kind: "day", label });
      day = label;
    }
    out.push({ kind: "entry", entry });
  });
  return out;
}

/**
 * Everything a surface needs to draw this feature.
 *
 * A plain value rather than the hook's return type, so the components that
 * draw it — the tree's foot, the popover, the page — never import Convex. The
 * demo console and the visual fixtures hand them a literal.
 */
export interface ActivityView {
  entries: ActivityEntry[];
  /** When this reader last caught up. `null` for never — everything is new. */
  seenAt: number | null;
  /** How many entries are newer than that. */
  unseen: number;
  /** Note paths in the unseen entries, for the dots in the tree. */
  unseenPaths: ReadonlySet<string>;
  /** Whether the first read has landed. Nothing is drawn as `0` before it. */
  loaded: boolean;
  /** Re-read the file. Called when this console writes something. */
  refresh: () => void;
  /** Catch up to now. Safe to call twice; the marker only moves forward. */
  markSeen: () => void;
}

/** What the list says when there is nothing in it. Never an empty box. */
export function emptyLine(shared: boolean): string {
  return shared
    ? "Nothing yet. This fills in as people and their AI clients work in this context."
    : "Nothing yet. This fills in as you and your AI clients work — every client that writes a note leaves a line here.";
}

/** A row's own name, for the accessibility label that has to say what it opens. */
export function rowName(entry: ActivityEntry): string {
  const target = targetOf(entry);
  return target === null ? "" : nameOf(target);
}

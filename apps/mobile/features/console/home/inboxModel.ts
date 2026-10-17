import { clientOf } from "@context/shared/src/activityActors.cjs";
import { folderRole } from "@context/shared/src/folderRoles.cjs";
import { baseName, folderLabel, parentPath } from "../files/paths";
import type { Home, HomeFolder, HomeNote } from "./homeModel";
import { INBOX_FOLDER } from "./homeView";

/**
 * The phone's first page, Inbox: what each part holds.
 *
 * From the leadership weekly of 2026-10-17 and the boards drawn from it
 * (`meeting-2026-10-17/phone-inbox/`, boards 1 and 2):
 *
 *  - **Loose notes**: the notes lying in the Inbox itself, newest first —
 *    "if I want to write a note I want to write to inbox and then have my
 *    agent organize it".
 *  - **Filed today**: notes moved out of the Inbox today, with where they
 *    went and who moved them — "when it gets organized it's not going to be
 *    in inbox anymore", so the last thing you wrote does not vanish from the
 *    page you start on. One calendar day (board 2's recommendation).
 *  - **Folder dots**: one row of small round icons, the folders this person
 *    opens most first, then the rest, at most five — "smaller dots or
 *    something with their icons". The last dot, All, opens Folders.
 *
 * A pure function over what the phone already has, like `homeModel.ts`.
 */

/** One line of `activity.md` as far as this page reads it (`activity/activity.ts`). */
export interface InboxActivity {
  at: string;
  kind: string;
  by: string | null;
  via: string | null;
  moves?: readonly (readonly [string, string])[];
}

export interface LooseNote {
  path: string;
  title: string;
  lede: string | null;
  updatedAt?: number;
}

export interface FiledNote {
  /** Where the note is now. */
  path: string;
  title: string;
  /** Where it went, as folder names: "areas › preaching". */
  place: string;
  /** Who moved it: "Tex", "Claude", "you", "@sayo". */
  who: string;
  at: number;
}

export interface Inbox {
  loose: LooseNote[];
  filed: FiledNote[];
  dots: HomeFolder[];
}

export const DOT_COUNT = 5;
const FILED_COUNT = 10;

const startOfDay = (at: number) => {
  const day = new Date(at);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
};

/** "areas › people › ana": every folder above the note, by its own name. */
export function placeOf(path: string): string {
  const parts = parentPath(path).split("/").filter(Boolean);
  return parts.map((part) => folderLabel(part)).join(" › ");
}

export function buildInbox({
  notes,
  home,
  entries,
  isMe,
  now,
}: {
  notes: readonly HomeNote[];
  /** Home's own sections, for the folders and what this person opens most. */
  home: Pick<Home, "folders" | "openMost">;
  entries: readonly InboxActivity[];
  /** Whether an activity line's `by` is the person looking. */
  isMe: (by: string) => boolean;
  now: number;
}): Inbox {
  const loose = notes
    .filter((note) => parentPath(note.path) === INBOX_FOLDER)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.title.localeCompare(b.title))
    .map((note) => ({
      path: note.path,
      title: note.title,
      lede: note.lede,
      ...(note.updatedAt === undefined ? {} : { updatedAt: note.updatedAt }),
    }));

  const byPath = new Map(notes.map((note) => [note.path, note]));
  const today = startOfDay(now);
  const seen = new Set<string>();
  const filed: FiledNote[] = [];
  const newestFirst = [...entries]
    .map((entry) => ({ entry, at: Date.parse(entry.at) }))
    .filter(({ entry, at }) => entry.kind === "moved" && Number.isFinite(at) && at >= today)
    .sort((a, b) => b.at - a.at);
  for (const { entry, at } of newestFirst) {
    for (const [from, to] of entry.moves ?? []) {
      if (parentPath(from) !== INBOX_FOLDER || parentPath(to) === INBOX_FOLDER) continue;
      // Drawn where it is now: a note moved again since, or gone, is not this row.
      const note = byPath.get(to);
      if (note === undefined || seen.has(to)) continue;
      seen.add(to);
      // The app's own moves are a person's hand, not a client (`clientOf`).
      const who = clientOf(entry.via) ?? (entry.by === null ? "someone" : isMe(entry.by) ? "you" : entry.by);
      filed.push({ path: to, title: note.title, place: placeOf(to), who, at });
    }
  }

  const isDot = (folder: HomeFolder) => folder.path !== INBOX_FOLDER && folderRole(baseName(folder.path)) !== "archive";
  const dots: HomeFolder[] = [];
  for (const folder of [...home.openMost.filter((row) => !row.path.includes("/")), ...home.folders]) {
    if (dots.length >= DOT_COUNT) break;
    if (isDot(folder) && !dots.some((dot) => dot.path === folder.path)) dots.push(folder);
  }

  return { loose, filed: filed.slice(0, FILED_COUNT), dots };
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * When a loose note last changed, as board 1 says it: the clock time today
 * ("11:42"), "Yesterday", the weekday for the rest of the week ("Thursday"),
 * then the date ("Sep 12").
 */
export function inboxWhen(at: number, now: number): string {
  const then = new Date(at);
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days <= 0) return `${then.getHours()}:${String(then.getMinutes()).padStart(2, "0")}`;
  if (days === 1) return "Yesterday";
  if (days < 7) return then.toLocaleString("en-US", { weekday: "long" });
  const month = then.toLocaleString("en-US", { month: "short" });
  return then.getFullYear() === new Date(now).getFullYear()
    ? `${month} ${then.getDate()}`
    : `${month} ${then.getDate()}, ${then.getFullYear()}`;
}

/** "5 loose notes", "1 loose note · 3 filed today", "Nothing loose". */
export function inboxCount(loose: number, filed: number): string {
  if (loose === 0) return "Nothing loose";
  const parts = [
    `${loose} loose note${loose === 1 ? "" : "s"}`,
    ...(filed > 0 ? [`${filed} filed today`] : []),
  ];
  return parts.join(" · ");
}

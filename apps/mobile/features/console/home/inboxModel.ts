import { clientOf } from "@context/shared/src/activityActors.cjs";
import { folderRole } from "@context/shared/src/folderRoles.cjs";
import { baseName, folderLabel, isUnlistedFile, parentPath, restoreTargetFor } from "../files/paths";
import type { Home, HomeFolder, HomeNote, HomePin, HomeRecent } from "./homeModel";
import { inboxFolderNow } from "./homeView";
import { archiveFolderNow } from "../files/jobIcons/jobFoldersNow";

/**
 * The phone's first page, Inbox: what each part holds.
 *
 * From the leadership weekly of 2026-10-17 and the boards drawn from it
 * (`meeting-2026-10-17/phone-inbox/`, boards 1 and 2):
 *
 *  - **Pinned**: the notes this person pinned, wherever they are filed, with
 *    the folder each is in — as Apple Notes opens (Dev2, 2026-10-18: "we need
 *    a pinned and prev 30 days section like apple notes").
 *  - **The notes people wrote by hand, by date**, newest first, wherever they
 *    are filed, under Apple Notes' own headings: Today, Yesterday, Previous 7
 *    Days, Previous 30 Days, then each month of this year, then each earlier
 *    year. These replaced one "Loose notes" list ("“loose notes” is
 *    stupid"), and hold **only notes a person edited themselves** ("please
 *    make sure it's only notes that a human has actually edited
 *    themselves"): an AI's writes neither add a note nor move it up. A note
 *    is dated by the last time a person's own hand changed it.
 *  - **Filed today**: notes moved out of the Inbox today, with where they
 *    went and who moved them — "when it gets organized it's not going to be
 *    in inbox anymore", so the last thing you wrote does not vanish from the
 *    page you start on. One calendar day (board 2's recommendation).
 *  - **Folders**: every top-level folder in one row that scrolls sideways,
 *    the Inbox first as the folder it is (Dev2, 2026-10-18: "Inbox is just a
 *    folder, so we should show it … why not just have a horizontal scroll").
 *
 * A pure function over what the phone already has, like `homeModel.ts`.
 */

/** One line of `activity.md` as far as this page reads it (`activity/activity.ts`). */
export interface InboxActivity {
  at: string;
  kind: string;
  by: string | null;
  via: string | null;
  paths?: readonly string[];
  moves?: readonly (readonly [string, string])[];
}

export interface InboxNote {
  path: string;
  title: string;
  lede: string | null;
  /** When it last changed: by a person's hand where that is known. */
  at?: number;
  /** The folder it is in, by its own name: "projects"; "" at the top. */
  folder: string;
}

/** One dated run of notes: "Previous 30 Days" and what is in it. */
export interface InboxGroup {
  label: string;
  notes: InboxNote[];
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
  pinned: InboxNote[];
  /** The notes a person edited by hand, not pinned, by date, newest group first. */
  groups: InboxGroup[];
  filed: FiledNote[];
  /** Every top-level folder, for the row that scrolls under the title. */
  folders: HomeFolder[];
}

const FILED_COUNT = 10;
const DAY = 24 * 60 * 60 * 1000;

const startOfDay = (at: number) => {
  const day = new Date(at);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
};

/** "areas › people › ana": every folder above the note, by its own name. */
export function placeOf(path: string): string {
  const parts = parentPath(path).split("/").filter(Boolean);
  return parts.map((part) => folderLabel(part)).join(" › ");
}

/**
 * Apple Notes' heading for a note last changed at `at`: Today, Yesterday,
 * Previous 7 Days, Previous 30 Days, then the month ("September") within this
 * year, then the year ("2025").
 */
export function inboxGroupOf(at: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 Days";
  if (days < 30) return "Previous 30 Days";
  const then = new Date(at);
  return then.getFullYear() === new Date(now).getFullYear()
    ? then.toLocaleString("en-US", { month: "long" })
    : String(then.getFullYear());
}

/** The kinds of `activity.md` line that mean a note's words changed. */
const WRITES = new Set(["added", "revised"]);

/**
 * When the looker's own hand last changed each note, by the note's path today.
 *
 * From two records, both of which only a person's hand reaches: `activity.md`'s
 * `added` and `revised` lines with no AI client on them (`clientOf`; the app's
 * own console is a person) signed by the looker (`isMe`), never a teammate's,
 * read oldest first so a later move
 * carries the date to the note's new name; and the looker's own Recent rows the
 * app marked edited (`editedAt`, kept through later opens), which reach further
 * back than the feed's last 400 lines.
 */
export function humanEdits(
  entries: readonly InboxActivity[],
  recents: readonly HomeRecent[],
  isMe: (by: string) => boolean,
): Map<string, number> {
  const edits = new Map<string, number>();
  const note = (path: string, at: number) => {
    if (at > (edits.get(path) ?? -Infinity)) edits.set(path, at);
  };
  const oldestFirst = entries
    .map((entry) => ({ entry, at: Date.parse(entry.at) }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((a, b) => a.at - b.at);
  for (const { entry, at } of oldestFirst) {
    for (const [from, to] of entry.moves ?? []) {
      const was = edits.get(from);
      if (was === undefined) continue;
      edits.delete(from);
      note(to, was);
    }
    // Your own hand only, in a shared workspace too (Dev2, 2026-10-18): a teammate's edit is not yours.
    if (!WRITES.has(entry.kind) || entry.by === null || !isMe(entry.by) || clientOf(entry.via) !== null) continue;
    for (const path of entry.paths ?? []) note(path, at);
  }
  for (const recent of recents) {
    // `editedAt` survives a later open; a row from before it says edited at its time.
    const edited = recent.editedAt ?? (recent.kind === "edited" ? recent.at : undefined);
    if (edited !== undefined) note(recent.path, edited);
  }
  return edits;
}

/** Context's own files, dot folders and the Archive: never a row on this page. */
const offPage = (path: string) =>
  path.split("/").some((segment) => segment.startsWith(".")) || isUnlistedFile(path) || restoreTargetFor(path) !== null;

export function buildInbox({
  notes,
  pins = [],
  recents = [],
  home,
  entries,
  isMe,
  now,
  inbox = inboxFolderNow(),
}: {
  notes: readonly HomeNote[];
  /** This person's pins; only the notes among them are drawn here. */
  pins?: readonly HomePin[];
  /** This person's Recent, for the notes they edited themselves. */
  recents?: readonly HomeRecent[];
  /** Home's own sections, for the folders and what this person opens most. */
  home: Pick<Home, "folders" | "openMost">;
  entries: readonly InboxActivity[];
  /** Whether an activity line's `by` is the person looking. */
  isMe: (by: string) => boolean;
  now: number;
  /** The folder doing the Inbox's job, whatever it is called (`inboxFolderNow`). */
  inbox?: string;
}): Inbox {
  const byPath = new Map(notes.map((note) => [note.path, note]));
  const edits = humanEdits(entries, recents, isMe);
  const row = (note: HomeNote): InboxNote => {
    const parent = parentPath(note.path);
    const at = edits.get(note.path) ?? note.updatedAt;
    return {
      path: note.path,
      title: note.title,
      lede: note.lede,
      ...(at === undefined ? {} : { at }),
      folder: parent === "" ? "" : folderLabel(baseName(parent)),
    };
  };

  const pinned: InboxNote[] = [];
  for (const pin of pins) {
    const note = pin.kind === "note" ? byPath.get(pin.path) : undefined;
    if (note === undefined || offPage(note.path) || pinned.some((done) => done.path === note.path)) continue;
    pinned.push(row(note));
  }
  const pinnedPaths = new Set(pinned.map((note) => note.path));

  const groups: InboxGroup[] = [];
  const written = [...edits]
    .flatMap(([path, at]) => {
      const note = byPath.get(path);
      return note === undefined || pinnedPaths.has(path) || offPage(path) ? [] : [{ note, at }];
    })
    .sort((a, b) => b.at - a.at || a.note.title.localeCompare(b.note.title));
  for (const { note, at } of written) {
    const label = inboxGroupOf(at, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.notes.push(row(note));
    else groups.push({ label, notes: [row(note)] });
  }

  const today = startOfDay(now);
  const seen = new Set<string>();
  const filed: FiledNote[] = [];
  const newestFirst = [...entries]
    .map((entry) => ({ entry, at: Date.parse(entry.at) }))
    .filter(({ entry, at }) => entry.kind === "moved" && Number.isFinite(at) && at >= today)
    .sort((a, b) => b.at - a.at);
  for (const { entry, at } of newestFirst) {
    for (const [from, to] of entry.moves ?? []) {
      if (parentPath(from) !== inbox || parentPath(to) === inbox) continue;
      // Drawn where it is now: a note moved again since, or gone, is not this row.
      const note = byPath.get(to);
      if (note === undefined || seen.has(to)) continue;
      seen.add(to);
      // The app's own moves are a person's hand, not a client (`clientOf`).
      const who = clientOf(entry.via) ?? (entry.by === null ? "someone" : isMe(entry.by) ? "you" : entry.by);
      filed.push({ path: to, title: note.title, place: placeOf(to), who, at });
    }
  }

  // The Inbox first, as the folder it is; then pinned folders, the ones opened
  // most, and the rest; Archive last.
  const top = new Map(home.folders.filter((folder) => !folder.path.includes("/")).map((folder) => [folder.path, folder]));
  const order = [
    inbox,
    ...pins.filter((pin) => pin.kind === "folder").map((pin) => pin.path),
    ...home.openMost.map((folder) => folder.path),
    ...top.keys(),
  ];
  const folders: HomeFolder[] = [];
  for (const path of order) {
    const folder = top.get(path);
    if (folder !== undefined && !folders.includes(folder)) folders.push(folder);
  }
  const isArchive = (folder: HomeFolder) =>
    folder.path === archiveFolderNow() || folderRole(baseName(folder.path)) === "archive";

  return {
    pinned,
    groups,
    filed: filed.slice(0, FILED_COUNT),
    folders: [...folders.filter((folder) => !isArchive(folder)), ...folders.filter(isArchive)],
  };
}

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

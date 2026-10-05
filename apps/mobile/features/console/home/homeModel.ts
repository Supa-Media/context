import { baseName, displayName, folderLabel, isUnlistedFile, parentPath, restoreTargetFor } from "../files/paths";

/**
 * The phone's Home: what each section holds.
 *
 * The board the owner approved on 2026-09-30 (Apple Notes as the reference):
 * the workspace's name and size, **Pinned** tiles, a **You open most** rail,
 * the three most **Recent** notes, and **All folders** with what each holds.
 *
 * ## No tag chips (2026-10-05)
 *
 * The board also had a row of tag chips, "Galatians 7", and it went after the
 * owner's team tried it on a phone (`mobile-feedback-2026-10-02`, item 3). The
 * number was every note carrying the tag, archived ones included, but pressing
 * the chip never listed those notes: it narrowed the sections, which show
 * three recent notes and the top-level folders holding the rest. Nobody could
 * find the seven. A tag still opens here from search or a folder's tags
 * (`homeTag.ts`), and then `tagged` names it and **Notes** lists every note
 * that carries it, so the count and the list are the same notes. Everything here is arithmetic over two things the phone already
 * has — its copy of the workspace (`useHomeSource`) and the person's own pins
 * and opens from Convex (`functions/places.ts`) — so it is a pure function and
 * the component only draws it.
 *
 * ## A place is a pointer, and the tree is what decides it is drawn
 *
 * Pins and opens are paths saved on the account. The tree the person can see
 * now is what decides whether one is drawn: a note moved, made private, or
 * archived since is simply absent, never a tile pointing nowhere. Only the
 * mover's own places follow a move on the server
 * (`docs/decisions/app-and-console/phone-home-places.md`), so this
 * intersection is also what keeps another member's stale pin from showing.
 */

export interface HomeNote {
  path: string;
  updatedAt?: number;
  title: string;
  /** The note's first paragraph, for the line under a recent note. */
  lede: string | null;
  tags: readonly string[];
}

export interface HomePin {
  path: string;
  kind: "note" | "folder";
}

export interface HomeOpened {
  path: string;
  opens: number;
  daysOpened: number;
  lastAt: number;
}

export interface HomeInput {
  notes: readonly HomeNote[];
  /** Every folder the device knows of, empty ones included. */
  folders: readonly string[];
  /** Folders whose default is `team`: drawn with the people mark. */
  shared: ReadonlySet<string>;
  pins: readonly HomePin[];
  opened: readonly HomeOpened[];
  /** The chosen tag chip; `null` is All. */
  tag: string | null;
  now: number;
}

export interface HomeFolder {
  kind: "folder";
  path: string;
  title: string;
  notes: number;
  folders: number;
  shared: boolean;
}

export interface HomeNoteTile {
  kind: "note";
  path: string;
  title: string;
  updatedAt?: number;
  /** The folder it is in, drawn under a recent note: `projects`. */
  place: string;
  lede: string | null;
}

export interface HomeOpenedFolder extends HomeFolder {
  label: string;
}

export interface Home {
  totals: { folders: number; notes: number };
  /** The tag Home is narrowed to and how many notes carry it; `null` for none. */
  tagged: { tag: string; count: number } | null;
  pinned: (HomeFolder | HomeNoteTile)[];
  openMost: HomeOpenedFolder[];
  recent: HomeNoteTile[];
  folders: HomeFolder[];
  /**
   * The notes outside every folder, by title: Home is the only page that lists
   * them. Narrowed to a tag, every note carrying it, wherever it is filed.
   */
  notes: HomeNoteTile[];
}

export const RECENT_COUNT = 3;
export const OPEN_MOST_COUNT = 6;

/** Context's own files and anything under a dot folder: never a row anybody wrote. */
function isPlumbing(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith(".")) || isUnlistedFile(path);
}

const isArchived = (path: string) => restoreTargetFor(path) !== null;

const inside = (path: string, folder: string) => folder === "" || path.startsWith(`${folder}/`);

/**
 * "Once lately", "5 times in 2 weeks", "Almost every day" — the line under a
 * folder in You open most. The window is the server's 14 days.
 */
export function openedLabel({ opens, daysOpened }: { opens: number; daysOpened: number }): string {
  if (daysOpened >= 10) return "Almost every day";
  if (opens === 1) return "Once lately";
  return `${opens} times in 2 weeks`;
}

export function buildHome(input: HomeInput): Home {
  const notes = input.notes.filter((note) => !isPlumbing(note.path));
  const folderSet = new Set(input.folders.filter((folder) => folder !== "" && !isPlumbing(folder)));
  // A folder a note lives in exists, whether or not a listing named it.
  for (const note of notes) {
    for (let at = parentPath(note.path); at !== ""; at = parentPath(at)) folderSet.add(at);
  }
  const folders = [...folderSet].sort((a, b) => a.localeCompare(b));

  // Archived notes are out of every section, so a tag's count leaves them out too.
  const tagged =
    input.tag === null
      ? notes
      : notes.filter((note) => note.tags.includes(input.tag as string) && !isArchived(note.path));
  const taggedFolders = new Set<string>();
  for (const note of tagged) {
    for (let at = parentPath(note.path); at !== ""; at = parentPath(at)) taggedFolders.add(at);
  }
  const folderShown = (path: string) => input.tag === null || taggedFolders.has(path);

  const folderOf = (path: string): HomeFolder => ({
    kind: "folder",
    path,
    title: folderLabel(baseName(path)),
    notes: tagged.filter((note) => inside(note.path, path)).length,
    folders: folders.filter((other) => other !== path && inside(other, path) && folderShown(other)).length,
    shared: input.shared.has(path),
  });
  const noteTile = (note: HomeNote): HomeNoteTile => ({
    kind: "note",
    path: note.path,
    title: note.title,
    ...(note.updatedAt === undefined ? {} : { updatedAt: note.updatedAt }),
    place: parentPath(note.path) === "" ? "" : folderLabel(baseName(parentPath(note.path))),
    lede: note.lede,
  });

  const noteByPath = new Map(tagged.map((note) => [note.path, note]));
  const pinned = input.pins.flatMap((pin): (HomeFolder | HomeNoteTile)[] => {
    if (isArchived(pin.path) || isPlumbing(pin.path)) return [];
    if (pin.kind === "note") {
      const note = noteByPath.get(pin.path);
      return note === undefined ? [] : [noteTile(note)];
    }
    return folderSet.has(pin.path) && folderShown(pin.path) ? [folderOf(pin.path)] : [];
  });

  const pinnedFolders = new Set(input.pins.filter((pin) => pin.kind === "folder").map((pin) => pin.path));
  const openMost = [...input.opened]
    .filter((row) => folderSet.has(row.path) && !pinnedFolders.has(row.path) && !isArchived(row.path))
    .filter((row) => folderShown(row.path))
    .sort((a, b) => b.opens - a.opens || b.lastAt - a.lastAt)
    .slice(0, OPEN_MOST_COUNT)
    .map((row) => ({ ...folderOf(row.path), label: openedLabel(row) }));

  const recent = tagged
    .filter((note) => !isArchived(note.path))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, RECENT_COUNT)
    .map(noteTile);

  const topLevel = folders.filter((folder) => !folder.includes("/"));
  return {
    totals: { folders: topLevel.length, notes: notes.length },
    tagged: input.tag === null ? null : { tag: input.tag, count: tagged.length },
    pinned,
    openMost,
    recent,
    folders: topLevel.filter(folderShown).map(folderOf),
    notes: tagged
      .filter((note) => input.tag !== null || parentPath(note.path) === "")
      .sort((a, b) => a.title.localeCompare(b.title))
      .map(noteTile),
  };
}

/** What a note is called on Home: its title, then its heading, then its file name. */
export function noteTitle(path: string, title: unknown, heading: string | null | undefined): string {
  if (typeof title === "string" && title.trim() !== "") return title.trim();
  if (typeof heading === "string" && heading.trim() !== "") return heading.trim();
  return displayName(baseName(path));
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * When a recent note changed, the way Apple Notes says it: the clock time
 * today ("10:12"), a weekday for the six days before ("Mon"), otherwise the
 * date ("Sep 12", with the year when it is not this one). Local time.
 */
export function whenLabel(at: number, now: number): string {
  const then = new Date(at);
  const today = new Date(now);
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(then)) / DAY);
  if (days <= 0) {
    return `${then.getHours()}:${String(then.getMinutes()).padStart(2, "0")}`;
  }
  if (days < 7) return then.toLocaleString("en-US", { weekday: "short" });
  const month = then.toLocaleString("en-US", { month: "short" });
  return then.getFullYear() === today.getFullYear()
    ? `${month} ${then.getDate()}`
    : `${month} ${then.getDate()}, ${then.getFullYear()}`;
}

/** "14 notes · 3 folders", "1 note", "Empty". */
export function countLabel(notes: number, folders: number): string {
  const parts = [
    ...(notes > 0 ? [`${notes} note${notes === 1 ? "" : "s"}`] : []),
    ...(folders > 0 ? [`${folders} folder${folders === 1 ? "" : "s"}`] : []),
  ];
  return parts.length === 0 ? "Empty" : parts.join(" · ");
}

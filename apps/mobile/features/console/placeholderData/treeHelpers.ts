import type { FileEntry, FolderListing, Visibility } from "../files/types";

/**
 * PLACEHOLDER — the three sample contexts the landing page browses.
 *
 * Replaced by: nothing, ever. This is the read-only console on the marketing
 * page, and it is deliberately not a screenshot — it runs the real
 * `BrowsePane` against these literals, so the components cannot drift from the
 * product. The signed-in console never reads these trees; it reads the
 * customer's bucket.
 *
 * The material is chosen to make three different things legible at a glance:
 *
 *  - **`@seyi`** — a personal context you own. Full PARA, projects *and*
 *    standing areas, with private items sitting inside folders whose default
 *    is team. That combination is the whole visibility model in one screen.
 *  - **`@lk`** — someone else's context you have *team* access to. Visibly
 *    fewer items and not one private thing, because a team caller is never
 *    shown what it may not read. Its smallness is the privacy model working
 *    rather than a loading state, and the pane says so in words.
 *  - **`@public-worship`** — a shared context with several members, carrying
 *    the organisation's actual workstreams.
 *
 * Public Worship is a real Christian nonprofit in New York, founded September
 * 2024 and operating under Global Echo Charitable's 501(c)(3); Seyi is its
 * Executive Director. Using its real workstreams rather than lorem is the
 * point — a demo whose notes say nothing teaches nothing about what this is
 * for.
 */

export interface DemoContextTree {
  /** Folder listings by path. `""` is the root. */
  listings: Record<string, FolderListing>;
  /** Note bodies by path. A path with no entry here is a folder. */
  notes: Record<string, string>;
  /** What is open when you arrive in this context. */
  defaultSelection: string;
  /** Folders expanded on arrival, so the point of each tree is visible. */
  defaultExpanded: string[];
  /**
   * Why this console cannot edit. Two different reasons live in the demo and
   * the difference matters: a visitor cannot edit anything, and `@lk` is
   * additionally a context they only ever read.
   */
  readOnlyReason: string;
}

export function file(path: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    kind: "file",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
    ...over,
  };
}

/** A file held back from — or shared out of — its folder's default. */
export function exception(path: string, visibility: Visibility, inherited: Visibility): FileEntry {
  return file(path, { visibility, inherited, exception: true });
}

export function folder(path: string, visibility: Visibility): FileEntry {
  return {
    kind: "folder",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility,
    inherited: visibility,
    exception: false,
    readOnly: false,
  };
}

/** A file in a `team` folder inherits team, so it carries no marker of its own. */
export function teamFile(path: string): FileEntry {
  return file(path, { visibility: "team", inherited: "team" });
}

export function listing(path: string, folderDefault: Visibility, entries: FileEntry[]): FolderListing {
  return { path, folderDefault, entries, truncated: false, manifestUsable: true };
}

/** The generated manifest, wrapped in the markers the gateway looks for. */
export function privacyNote(rules: string): string {
  return [
    "---",
    "role: privacy-manifest",
    "---",
    "",
    "# Access map",
    "",
    "This file decides what a connected AI client is allowed to see.",
    "",
    "<!-- BEGIN BRAIN PRIVACY RULES -->",
    "",
    "```yaml",
    rules,
    "```",
    "",
    "<!-- END BRAIN PRIVACY RULES -->",
    "",
  ].join("\n");
}

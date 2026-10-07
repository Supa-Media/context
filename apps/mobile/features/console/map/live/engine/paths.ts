/**
 * How a note's path places it: workspace, then root folder, then the first
 * subfolder, then the note. Deeper folders fold into their first subfolder,
 * because the map has four levels of zoom and a fifth would be noise.
 */

/** The four top folders people mean by PARA, plus Inbox, in reading order. */
export const PARA_ORDER = ["inbox", "projects", "areas", "resources", "archive"] as const;

export type PathParts = {
  /** The root folder's segment (`1-projects`), or "" for a note at the top level. */
  root: string;
  /** The first subfolder's segment, or "" for a note directly in its root folder. */
  sub: string;
};

export function splitPath(path: string): PathParts {
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.length <= 1) return { root: "", sub: "" };
  if (segments.length === 2) return { root: segments[0]!, sub: "" };
  return { root: segments[0]!, sub: segments[1]! };
}

/**
 * What a person calls a folder: `0-inbox` is "Inbox", `context-launch` is
 * "Context launch". A leading number and its separator are a sort key, not
 * part of the name.
 */
export function folderLabel(segment: string): string {
  const bare = segment.replace(/^\d+[\s._-]+/, "").replace(/[-_]+/g, " ").trim();
  const text = bare.length > 0 ? bare : segment;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A note's name when it has no title: its file name without `.md`. */
export function fileTitle(path: string): string {
  const leaf = path.split("/").pop() ?? path;
  return leaf.replace(/\.md$/i, "");
}

/** 0..4 for the PARA folders, 5 for anything else. */
export function paraRank(segment: string): number {
  const name = folderLabel(segment).toLowerCase();
  const index = (PARA_ORDER as readonly string[]).indexOf(name);
  return index < 0 ? PARA_ORDER.length : index;
}

/** Root folders in display order: PARA first, in PARA order, then the rest by name. */
export function sortFolders(segments: Iterable<string>): string[] {
  return [...new Set(segments)].sort((a, b) => {
    const ra = paraRank(a);
    const rb = paraRank(b);
    if (ra !== rb) return ra - rb;
    const la = folderLabel(a).toLowerCase();
    const lb = folderLabel(b).toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
}

/** One key for a note across workspaces. A newline never appears in a note key. */
export const noteKey = (workspaceId: string, path: string): string => `${workspaceId}\n${path}`;

export function splitKey(key: string): { workspaceId: string; path: string } {
  const at = key.indexOf("\n");
  return { workspaceId: key.slice(0, at), path: key.slice(at + 1) };
}

export const folderKey = (workspaceId: string, root: string): string => `${workspaceId}\n${root}/`;
export const subKey = (workspaceId: string, root: string, sub: string): string =>
  `${workspaceId}\n${root}/${sub}/`;

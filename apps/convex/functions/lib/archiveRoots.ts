import type { PrivacyRule } from "./privacy";

/**
 * A root folder this product recognises as an archive: `archive`, or a
 * PARA-ish `<number>-archive`.
 *
 * **Mirrors `ARCHIVE_FOLDER_PATTERN` in `apps/mcp/src/index.js`.** The gateway
 * and the console must agree about where archiving lands, or a note archived
 * by Claude and the same note archived from the file browser end up in two
 * different folders in one bucket. `archiveResolution.test.ts` extracts the
 * gateway's real resolver from its source and drives both over the same
 * manifests, the way `scaffold.test.ts` does for the manifest format.
 *
 * Deliberately a shape and not a list. A list would be the same layout
 * assumption with one more entry, and the next preset would reintroduce the
 * bug it was written for — the `company` preset ships `5-archive`, is the
 * default for a shared context, and its workspaces were told they had no
 * archive while looking at their own. What this will still not do is guess:
 * `retired`, `old` and `cold-storage` name the same idea and cannot be read
 * off a folder name, and inventing a destination in somebody's bucket is what
 * refusing was right about.
 */
export const ARCHIVE_FOLDER_PATTERN = /^(?:\d+-)?archive$/i;

/**
 * Every archive root this context declares, deduplicated and ordered.
 *
 * A rule may name the folder or something inside it; both say the folder
 * exists, so the root segment is what is matched. More than one is not
 * hypothetical, which is why "is this already archived" asks about all of them
 * and not only the one that would be written to.
 */
export function archiveRoots(rules: readonly PrivacyRule[]): string[] {
  const roots = new Set<string>();
  for (const rule of rules ?? []) {
    const root = String(rule?.prefix ?? "").split("/")[0];
    if (ARCHIVE_FOLDER_PATTERN.test(root)) roots.add(root);
  }
  return [...roots].sort();
}

/**
 * The one this context archives into, or `null` when it has none.
 *
 * **`4-archive` wins whenever it is declared at all**, so no context that
 * already had one can have its archive moved by widening this — a PARA
 * workspace that later gains a `5-archive` keeps filing where its history
 * already is. Everything else takes the first in sorted order: a rule about
 * the set rather than the order somebody's manifest happens to be in, because
 * reordering `privacy.md` must not silently repoint archiving.
 */
export function archiveRoot(rules: readonly PrivacyRule[]): string | null {
  const roots = archiveRoots(rules);
  if (roots.length === 0) return null;
  return roots.includes("4-archive") ? "4-archive" : roots[0];
}

/** Whether a path is inside one of this context's archives. */
export function insideArchive(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * The messages between the mirror's sync and the console's file tree.
 *
 * - **Listed**: a context's metadata was just committed to its index, so a
 *   tree drawn from the index is out of date. `mirrorSync.ts` says it (through
 *   `useMirrorSync`); the file browser listens and redraws from the index.
 * - **Notes changed**: new bodies of a context's notes were just committed —
 *   a sync fetched them, or a folder list put back the note it wrote. The
 *   folder lists, which read frontmatter from bodies, listen; the tree, which
 *   is drawn from metadata alone, does not need to.
 * - **Refresh requested**: somebody opened a context, or something said its
 *   files changed, and its tree should be re-listed now rather than at the
 *   next five-minute pass. The file browser asks; `useMirrorSync` answers with
 *   a metadata-only walk, which does not wait behind any body download.
 *
 * Module-level rather than context: one sync hook and any number of browsers
 * share it, and neither owns the other. It carries workspace ids and nothing
 * else — never a path, never a body.
 */

type Listener = (workspaceId: string) => void;

const listed = new Set<Listener>();
const requested = new Set<Listener>();
const notes = new Set<Listener>();

export function publishMirrorListed(workspaceId: string): void {
  for (const listener of [...listed]) listener(workspaceId);
}

export function onMirrorListed(listener: Listener): () => void {
  listed.add(listener);
  return () => listed.delete(listener);
}

export function publishMirrorNotesChanged(workspaceId: string): void {
  for (const listener of [...notes]) listener(workspaceId);
}

export function onMirrorNotesChanged(listener: Listener): () => void {
  notes.add(listener);
  return () => notes.delete(listener);
}

export function requestMirrorRefresh(workspaceId: string): void {
  for (const listener of [...requested]) listener(workspaceId);
}

export function onMirrorRefreshRequest(listener: Listener): () => void {
  requested.add(listener);
  return () => requested.delete(listener);
}

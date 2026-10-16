/**
 * Which bucket keys the old-copy cleanup may delete: everything outside
 * `notes/` and `files/`, except that under `.context/` only the trash, the
 * move log and the access log are the cleanup's. `.context/collaboration/` is
 * customer-owned essential data (merge history for offline edits), and every
 * other `.context/` key is plumbing the cleanup does not own. Every other
 * dot-prefixed root (`.obsidian/`, `.audit/`, `.history/`) is kept too.
 *
 * One rule, read by the control plane when it plans a page
 * (`apps/convex/functions/lib/cleanup/gate.ts`, which imports this module) and
 * again here before anything is deleted, so a page the control plane got wrong
 * still cannot reach a note's bytes.
 *
 * The decision: `docs/decisions/storage-and-credentials/notes-by-id.md`, "Old
 * keys are deleted seven days after the owner confirms the switch".
 */

/** The `.context/` folders the cleanup owns. Anything else under `.context/` is kept. */
export const CLEANUP_CONTEXT_FOLDERS = Object.freeze([".context/trash/", ".context/moves/", ".context/access/"]);

/** Whether the cleanup may delete this key. The first path segment decides, so `notesx.md` is a path copy and `notes` alone is kept. */
export function cleanupKey(key) {
  if (typeof key !== "string" || key === "") return false;
  const first = key.split("/")[0];
  if (first === "notes" || first === "files") return false;
  // Every other dot-prefixed root is plumbing someone still reads: plugins in
  // `.obsidian/`, the customer's own audit copy in `.audit/`, `.history/`.
  if (first.startsWith(".")) return CLEANUP_CONTEXT_FOLDERS.some((folder) => key.startsWith(folder));
  return true;
}

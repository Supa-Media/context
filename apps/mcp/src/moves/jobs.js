/**
 * The one prefix rule the listings and searches share. The legacy move-job
 * markers under `.context/moves/` are gone: no drain finishes them and no
 * write waits on them: a folder move is rows in the control plane
 * (`tools/moves/queuedFolder.js`), so nothing is left in the bucket to wait on.
 */

export function noteUnderPrefix(path, prefix) {
  if (!prefix) return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

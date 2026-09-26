/**
 * Whether a caller must hand the list every note under its folder, not just
 * the ones directly in it. A project folder's rows come from notes inside it.
 */
export function listLoadsSubfolders(config) {
  return config.subfolders === true || config.rows === "projects";
}

/**
 * Archive keeps the shape of the workspace (decided by the owner, 2026-10-18;
 * `docs/decisions/app-and-console/folder-jobs.md`, "Archive mirrors the
 * folders"). One module, read by the gateway, the control plane and the app,
 * so "where does this land in Archive" and "where does Restore put it back"
 * have one answer each.
 *
 * - **Archiving `P` puts it at `<archive>/<P>`**: the same path, under the
 *   folder doing the Archive's job. Archive/Projects then holds every project
 *   ever archived, beside each other.
 * - **A built-in folder has a twin inside Archive**: the folder at
 *   `<archive>/<that folder's path>`, marked on its row with `archiveOf`
 *   (the job's original name). When the built-in folder is renamed or moved,
 *   its twin is too, so the two always match. Folders a person made are not
 *   kept in step: Archive shows them as they were.
 * - **A name already in Archive is merged into**, and a note whose name is
 *   taken arrives with a number, `notes (2).md`; nothing is overwritten.
 * - **Restore** takes the archive's name off the front. Archives made before
 *   this, under a date folder (`<archive>/2026-10-15T22-16-49-545Z/...`), lose
 *   the date as well.
 */

/** What `timestampSlug` writes, with the `-2` ... the console added for two archives in one millisecond. */
const ARCHIVE_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/;

function isArchiveStamp(segment) {
  return typeof segment === "string" && ARCHIVE_STAMP.test(segment);
}

function trimSlashes(path) {
  return String(path).replace(/^\/+|\/+$/g, "");
}

/** Where `path` lands when archived into `archive`. */
function archiveDestination(archive, path) {
  return `${trimSlashes(archive)}/${trimSlashes(path)}`;
}

/**
 * What restoring `archivedPath` puts back, or null for a path that is not in
 * `archive` (or is the archive itself, or only a date folder in it).
 */
function restoreTarget(archive, archivedPath) {
  const root = trimSlashes(archive ?? "");
  const path = trimSlashes(archivedPath ?? "");
  if (root === "" || !path.startsWith(`${root}/`)) return null;
  let inside = path.slice(root.length + 1);
  const slash = inside.indexOf("/");
  if (isArchiveStamp(slash < 0 ? inside : inside.slice(0, slash))) {
    if (slash < 0) return null;
    inside = inside.slice(slash + 1);
  }
  return inside === "" ? null : inside;
}

/**
 * The `n`th free form of a name: `notes.md` → `notes (2).md`, `launch` →
 * `launch (2)`. A leading dot is part of the name, not an extension.
 */
function numberedName(name, n) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  return `${stem} (${n})${extension}`;
}

/**
 * The first free path for `path` (`numberedName` on its last segment, from 2),
 * asking `taken(candidate)`; null after `limit` tries.
 */
async function firstFreePath(path, taken, limit = 100) {
  if (!(await taken(path))) return path;
  const slash = path.lastIndexOf("/");
  const folder = slash < 0 ? "" : path.slice(0, slash + 1);
  const name = slash < 0 ? path : path.slice(slash + 1);
  for (let n = 2; n <= limit; n += 1) {
    const candidate = `${folder}${numberedName(name, n)}`;
    if (!(await taken(candidate))) return candidate;
  }
  return null;
}

/**
 * The twins an archived path sits in: for each built-in folder (other than
 * the Archive) whose path `inside` is, or is under, the folder at
 * `<archive>/<its path>` with that job, outermost first. `jobs` is
 * `folderJobs`'s answer, read now.
 */
function twinsAlong(jobs, archive, archivedPath) {
  const root = trimSlashes(archive ?? "");
  const path = trimSlashes(archivedPath ?? "");
  if (!jobs || root === "" || !path.startsWith(`${root}/`)) return [];
  const inside = path.slice(root.length + 1);
  const twins = [];
  for (const [job, home] of Object.entries(jobs.jobs ?? {})) {
    if (job === "archive" || typeof home !== "string" || home === "") continue;
    if (inside === home || inside.startsWith(`${home}/`)) twins.push({ path: `${root}/${home}`, role: job });
  }
  return twins.sort((a, b) => a.path.length - b.path.length);
}

/**
 * Move `from` to `to`, merging into what is already there (board 7): a free
 * `to` takes the whole thing in one move; a folder onto a folder moves each
 * child into it the same way; a note whose name is taken arrives numbered.
 * `ops.kindAt(path)` is `"file"`, `"folder"` or null, `ops.children(folder)`
 * the names directly in it, `ops.move(from, to)` the move. Answers each move
 * made. Stops (throws) at the first move that fails, keeping what already
 * moved: each move is whole on its own.
 */
async function mergeInto(from, to, ops, depth = 0) {
  if (depth > 64) throw new Error("archive merge is nested too deeply");
  const there = await ops.kindAt(to);
  if (there === null) {
    await ops.move(from, to);
    return [{ from, to }];
  }
  const here = await ops.kindAt(from);
  if (here === "folder" && there === "folder") {
    const moved = [];
    for (const name of await ops.children(from)) {
      moved.push(...(await mergeInto(`${from}/${name}`, `${to}/${name}`, ops, depth + 1)));
    }
    return moved;
  }
  const free = await firstFreePath(to, async (candidate) => (await ops.kindAt(candidate)) !== null);
  if (free === null) throw new Error("no free name in the archive");
  await ops.move(from, free);
  return [{ from, to: free }];
}

module.exports = {
  mergeInto,
  ARCHIVE_STAMP,
  isArchiveStamp,
  archiveDestination,
  restoreTarget,
  numberedName,
  firstFreePath,
  twinsAlong,
};

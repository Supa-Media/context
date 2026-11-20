/**
 * Paths inside Tex's computer: every read and write stays under the work folder (`WORK`), resolved and then checked
 * again after symlinks, so `../`, an absolute path or a link the model made cannot reach the rest of the box.
 * No dependencies: the container image runs this file with the stock Node.
 */
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const WORK = process.env.TEX_WORK ?? "/work";

/** Whether `child` is `root` or inside it. */
export function inside(root, child) {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
}

/**
 * The absolute path a request names, or null when it leaves the work folder. `path` is relative to it (a leading
 * "/work/" is accepted as the same folder). Empty means the folder itself.
 */
export function workPath(path, root = WORK) {
  if (typeof path !== "string" || path.length > 1024 || path.includes("\0")) return null;
  const named = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path === root ? "" : path;
  if (isAbsolute(named)) return null;
  const full = resolve(root, named);
  return inside(root, full) ? full : null;
}

/**
 * The same path after symlinks: the deepest part that exists is resolved, and it must still be inside the real work
 * folder. Null when it is not.
 */
export async function realWorkPath(path, root = WORK) {
  const full = workPath(path, root);
  if (full === null) return null;
  const realRoot = await realpath(root);
  let probe = full;
  for (;;) {
    try {
      const real = await realpath(probe);
      return inside(realRoot, real) ? full : null;
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
      const up = dirname(probe);
      if (up === probe) return null;
      probe = up;
    }
  }
}

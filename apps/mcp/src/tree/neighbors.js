/**
 * One note's links and backlinks for `related_notes`, resolved from link rows
 * the way the map resolves them (`apps/convex/functions/lib/fileOps/graph.ts`):
 * a path names the visible note at it, else the one visible note carrying its
 * file name; a bare `[[name]]` names the note of that name beside the one
 * linking, else the one visible note carrying it.
 *
 * One copy for both places that answer it: the control plane's facts
 * (`apps/convex/functions/lib/nodes/gatewayFacts.ts`) and a workspace object's
 * own (`workspaceStore/facts.js`), so the two cannot come to disagree.
 *
 * `visible` is every note the reader may see, at the names the tree shows
 * now, and the caller hands the rows over at those names too. Names are
 * looked up among visible notes only, so a hidden note never changes which
 * note a name means.
 *
 * One asymmetry with the map: a backlink is a row naming the seed's own path
 * or bare name, so a path link the map resolves to the seed only through the
 * file-name fallback (it names a path that does not exist) is not one.
 */

import { bareNameOf } from "./links.js";

function decoded(target) {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

const fileNameOf = (path) => path.slice(path.lastIndexOf("/") + 1);
const folderOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "");

/**
 * @param {string} seed
 * @param {{ links: Array<{ kind: "path" | "name", target: string }>, byPath: string[], byName: string[] }} rows
 * @param {ReadonlySet<string>} visible
 * @returns {{ links: string[], backlinks: string[] }}
 */
export function resolveNeighbors(seed, rows, visible) {
  const byFileName = new Map();
  for (const path of visible) {
    const name = fileNameOf(path);
    byFileName.set(name, byFileName.has(name) ? null : path);
  }
  const unique = (file) => byFileName.get(file) ?? null;
  const named = (from, name) => {
    const file = name.endsWith(".md") || /\.[a-z0-9]{1,8}$/i.test(name) ? name : `${name}.md`;
    const beside = `${folderOf(from)}${file}`;
    return visible.has(beside) ? beside : unique(file);
  };
  const targetOf = (from, kind, target) => {
    if (kind === "name") return named(from, target);
    if (visible.has(target)) return target;
    const plain = decoded(target);
    return visible.has(plain) ? plain : unique(fileNameOf(plain));
  };

  const links = new Set();
  if (visible.has(seed)) {
    for (const { kind, target } of rows.links) {
      const to = targetOf(seed, kind, target);
      if (to !== null && to !== seed) links.add(to);
    }
  }
  const backlinks = new Set();
  for (const source of rows.byPath) if (source !== seed && visible.has(source)) backlinks.add(source);
  for (const source of rows.byName) {
    if (source !== seed && visible.has(source) && named(source, bareNameOf(seed)) === seed) backlinks.add(source);
  }
  return { links: [...links].sort(), backlinks: [...backlinks].sort() };
}

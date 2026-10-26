/**
 * One note's links and backlinks for `related_notes`, resolved from the
 * tree's link rows (`nodeFacts.neighbors`) the way the map resolves them
 * (`lib/fileOps/graph.ts`): a path names the visible note at it, else the one
 * visible note carrying its file name; a bare `[[name]]` names the note of
 * that name beside the one linking, else the one visible note carrying it.
 *
 * `visible` is every note the reader may see, at the names the tree shows
 * now. A link row names the bucket key it was read at, so a note whose row is
 * mid-move is absent from `visible` at that key and is left out rather than
 * judged at a name the reader may not see it under. Names are looked up among
 * visible notes only, so a hidden note never changes which note a name means.
 */

/** `1-projects/x/overview.md` → `overview`: what a bare link to it is written as. */
export function bareNameOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

const fileNameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "");

export type NeighborRows = {
  links: Array<{ kind: "path" | "name"; target: string }>;
  byPath: string[];
  byName: string[];
};

export function resolveNeighbors(seed: string, rows: NeighborRows, visible: ReadonlySet<string>): { links: string[]; backlinks: string[] } {
  const byFileName = new Map<string, string | null>();
  for (const path of visible) {
    const name = fileNameOf(path);
    byFileName.set(name, byFileName.has(name) ? null : path);
  }
  const unique = (file: string) => byFileName.get(file) ?? null;
  const named = (from: string, name: string) => {
    const file = name.endsWith(".md") || /\.[a-z0-9]{1,8}$/i.test(name) ? name : `${name}.md`;
    const beside = `${folderOf(from)}${file}`;
    return visible.has(beside) ? beside : unique(file);
  };
  const targetOf = (from: string, kind: "path" | "name", target: string) =>
    kind === "name" ? named(from, target) : visible.has(target) ? target : unique(fileNameOf(target));

  const links = new Set<string>();
  if (visible.has(seed)) {
    for (const { kind, target } of rows.links) {
      const to = targetOf(seed, kind, target);
      if (to !== null && to !== seed) links.add(to);
    }
  }
  const backlinks = new Set<string>();
  for (const source of rows.byPath) if (source !== seed && visible.has(source)) backlinks.add(source);
  for (const source of rows.byName) {
    if (source !== seed && visible.has(source) && named(source, bareNameOf(seed)) === seed) backlinks.add(source);
  }
  return { links: [...links].sort(), backlinks: [...backlinks].sort() };
}

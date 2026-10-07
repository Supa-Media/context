import type { WorkspaceGraph } from "../types";
import { discRadius, packBubbles, scatter, SPACING, type Bubble } from "./pack";
import { fileTitle, folderKey, folderLabel, noteKey, paraRank, sortFolders, splitPath, subKey } from "./paths";

/**
 * Where everything sits, in world units: workspaces as islands side by side,
 * root folders as bubbles inside them, subfolders as bubbles inside those, and
 * notes scattered inside the innermost bubble.
 *
 * Deterministic by path. Nothing depends on the order the graph listed its
 * nodes in, and a note's seed depends only on its own path, so the same
 * workspace draws the same on every device and a new note does not shuffle
 * the others (see `pack.ts`).
 */

export type NotePlace = {
  key: string;
  workspaceId: string;
  path: string;
  title: string;
  x: number;
  y: number;
  /** Links, for sizing the dot. */
  deg: number;
  sub: SubPlace;
};

export type SubPlace = {
  key: string;
  /** The subfolder's segment; "" for notes directly in the root folder. */
  name: string;
  label: string;
  x: number;
  y: number;
  r: number;
  folder: FolderPlace;
  notes: NotePlace[];
};

export type FolderPlace = {
  key: string;
  workspaceId: string;
  /** The root folder's segment; "" for notes at the top level. */
  name: string;
  label: string;
  x: number;
  y: number;
  r: number;
  island: IslandPlace;
  subs: SubPlace[];
  /** Every note the layout holds here, including ones only in the history. */
  size: number;
};

export type IslandPlace = {
  workspaceId: string;
  name: string;
  kind: "personal" | "shared";
  x: number;
  y: number;
  r: number;
  folders: FolderPlace[];
  size: number;
};

export type Layout = {
  islands: IslandPlace[];
  notes: Map<string, NotePlace>;
  folders: Map<string, FolderPlace>;
  subs: Map<string, SubPlace>;
  /** Graph links, as pairs of note keys. */
  edges: Array<[string, string]>;
  /** Smallest circle round everything. */
  center: { x: number; y: number };
  radius: number;
};

/** A path that is not in any graph now but was during the window (a move's origin). */
export type ExtraPath = { workspaceId: string; path: string; title?: string };

/** Relaxation is the only costly step, so it is cached by the exact member list. */
export type LayoutCache = Map<string, Array<{ x: number; y: number }>>;

export const createLayoutCache = (): LayoutCache => new Map();

/** Preferred directions for the PARA folders round Projects, as in the prototype. */
const PARA_ANGLE: Record<number, number> = {
  0: (-145 * Math.PI) / 180,
  2: (-35 * Math.PI) / 180,
  3: (35 * Math.PI) / 180,
  4: (145 * Math.PI) / 180,
};

type Raw = { workspaceId: string; path: string; title: string; deg: number };

export function buildLayout(
  graphs: readonly WorkspaceGraph[],
  extra: readonly ExtraPath[] = [],
  cache: LayoutCache = createLayoutCache(),
): Layout {
  const notes = new Map<string, NotePlace>();
  const folders = new Map<string, FolderPlace>();
  const subs = new Map<string, SubPlace>();
  const edges: Array<[string, string]> = [];
  const islands: IslandPlace[] = [];

  for (const graph of graphs) {
    const raw = new Map<string, Raw>();
    graph.nodes.forEach((node) => {
      raw.set(node.path, { workspaceId: graph.workspaceId, path: node.path, title: node.title || fileTitle(node.path), deg: 0 });
    });
    for (const [a, b] of graph.edges) {
      const na = graph.nodes[a];
      const nb = graph.nodes[b];
      if (!na || !nb || na.path === nb.path) continue;
      raw.get(na.path)!.deg += 1;
      raw.get(nb.path)!.deg += 1;
      edges.push([noteKey(graph.workspaceId, na.path), noteKey(graph.workspaceId, nb.path)]);
    }
    for (const e of extra) {
      if (e.workspaceId !== graph.workspaceId || raw.has(e.path)) continue;
      raw.set(e.path, { workspaceId: e.workspaceId, path: e.path, title: e.title || fileTitle(e.path), deg: 0 });
    }
    islands.push(buildIsland(graph, [...raw.values()], cache, notes, folders, subs));
  }

  placeIslands(islands);
  // Islands are placed: turn every local coordinate into a world one.
  for (const island of islands) {
    for (const folder of island.folders) {
      folder.x += island.x;
      folder.y += island.y;
      for (const sub of folder.subs) {
        sub.x += folder.x;
        sub.y += folder.y;
        for (const note of sub.notes) {
          note.x += sub.x;
          note.y += sub.y;
        }
      }
    }
  }
  let radius = 0;
  for (const island of islands) radius = Math.max(radius, Math.hypot(island.x, island.y) + island.r);
  return { islands, notes, folders, subs, edges, center: { x: 0, y: 0 }, radius };
}

function buildIsland(
  graph: WorkspaceGraph,
  raws: Raw[],
  cache: LayoutCache,
  notes: Map<string, NotePlace>,
  folders: Map<string, FolderPlace>,
  subs: Map<string, SubPlace>,
): IslandPlace {
  const island: IslandPlace = {
    workspaceId: graph.workspaceId,
    name: graph.name,
    kind: graph.kind,
    x: 0,
    y: 0,
    r: discRadius(1),
    folders: [],
    size: raws.length,
  };
  const byRoot = new Map<string, Map<string, Raw[]>>();
  for (const raw of raws) {
    const { root, sub } = splitPath(raw.path);
    let bySub = byRoot.get(root);
    if (!bySub) byRoot.set(root, (bySub = new Map()));
    const list = bySub.get(sub);
    if (list) list.push(raw);
    else bySub.set(sub, [raw]);
  }

  const rootNames = sortFolders([...byRoot.keys()].filter((r) => r !== ""));
  if (byRoot.has("")) rootNames.push("");
  for (const root of rootNames) {
    const bySub = byRoot.get(root)!;
    const folder: FolderPlace = {
      key: folderKey(graph.workspaceId, root),
      workspaceId: graph.workspaceId,
      name: root,
      label: root === "" ? "" : folderLabel(root),
      x: 0,
      y: 0,
      r: 0,
      island,
      subs: [],
      size: 0,
    };
    const subNames = [...bySub.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a < b ? -1 : a > b ? 1 : 0));
    const bubbles: Bubble[] = [];
    for (const name of subNames) {
      const members = bySub.get(name)!.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const sub: SubPlace = {
        key: subKey(graph.workspaceId, root, name),
        name,
        label: name === "" ? "" : folderLabel(name),
        x: 0,
        y: 0,
        r: discRadius(members.length),
        folder,
        notes: [],
      };
      const ids = members.map((m) => m.path);
      const signature = `${graph.workspaceId}\n${sub.r}\n${ids.join("\n")}`;
      let pts = cache.get(signature);
      if (!pts) {
        pts = scatter(ids, sub.r);
        cache.set(signature, pts);
      }
      members.forEach((m, i) => {
        const note: NotePlace = {
          key: noteKey(m.workspaceId, m.path),
          workspaceId: m.workspaceId,
          path: m.path,
          title: m.title,
          x: pts![i]!.x,
          y: pts![i]!.y,
          deg: m.deg,
          sub,
        };
        sub.notes.push(note);
        notes.set(note.key, note);
      });
      folder.subs.push(sub);
      folder.size += members.length;
      subs.set(sub.key, sub);
      bubbles.push({ id: sub.key, r: sub.r });
    }
    if (bubbles.length === 1) {
      // A folder with no subfolders is just its notes, with a little more rim.
      folder.r = folder.subs[0]!.r * 1.08;
    } else {
      const packed = packBubbles(bubbles, SPACING * 0.8);
      packed.items.forEach((p, i) => {
        folder.subs[i]!.x = p.x;
        folder.subs[i]!.y = p.y;
      });
      folder.r = packed.r + SPACING * 1.6;
    }
    island.folders.push(folder);
    folders.set(folder.key, folder);
  }

  // Projects (or the biggest folder) in the middle, the rest round it.
  const order = [...island.folders];
  const centreIndex = (() => {
    const projects = order.findIndex((f) => f.name !== "" && paraRank(f.name) === 1);
    if (projects >= 0) return projects;
    let best = 0;
    order.forEach((f, i) => {
      if (f.size > order[best]!.size) best = i;
    });
    return best;
  })();
  if (order.length > 0) order.unshift(order.splice(centreIndex, 1)[0]!);
  const others = order.length - 1;
  const bubbles: Bubble[] = order.map((f, i) => {
    if (i === 0) return { id: f.key, r: f.r };
    const rank = f.name === "" ? -1 : paraRank(f.name);
    const angle = PARA_ANGLE[rank] ?? (Math.PI / 2 + ((i - 1) / Math.max(1, others)) * Math.PI * 2);
    return { id: f.key, r: f.r, angle };
  });
  const packed = packBubbles(bubbles, SPACING * 2.5);
  const byKey = new Map(packed.items.map((p) => [p.id, p]));
  for (const folder of island.folders) {
    const p = byKey.get(folder.key)!;
    folder.x = p.x;
    folder.y = p.y;
  }
  island.r = Math.max(packed.r + SPACING * 1.5, discRadius(1));
  return island;
}

/**
 * Islands in a grid, read left to right then down, in the order the graphs
 * came (the caller decides: their own workspace first). Each row and column
 * is as wide as its biggest island, so neighbours never touch.
 */
function placeIslands(islands: IslandPlace[]): void {
  const n = islands.length;
  if (n === 0) return;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const gap = Math.max(...islands.map((i) => i.r)) * 0.45 + SPACING * 6;
  const colW = new Array<number>(cols).fill(0);
  const rowH = new Array<number>(rows).fill(0);
  islands.forEach((island, i) => {
    colW[i % cols] = Math.max(colW[i % cols]!, island.r * 2);
    rowH[Math.floor(i / cols)] = Math.max(rowH[Math.floor(i / cols)]!, island.r * 2);
  });
  const totalW = colW.reduce((a, b) => a + b, 0) + gap * (cols - 1);
  const totalH = rowH.reduce((a, b) => a + b, 0) + gap * (rows - 1);
  islands.forEach((island, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    let x = -totalW / 2;
    for (let k = 0; k < c; k += 1) x += colW[k]! + gap;
    let y = -totalH / 2;
    for (let k = 0; k < r; k += 1) y += rowH[k]! + gap;
    island.x = x + colW[c]! / 2;
    island.y = y + rowH[r]! / 2;
  });
  // A short last row sits centred under the others.
  const lastRow = rows - 1;
  const inLast = islands.filter((_, i) => Math.floor(i / cols) === lastRow);
  if (rows > 1 && inLast.length < cols) {
    let used = 0;
    inLast.forEach((_, k) => (used += colW[k]! + (k > 0 ? gap : 0)));
    const shift = (totalW - used) / 2;
    inLast.forEach((island) => (island.x += shift));
  }
}

/** The note keys a folder or subfolder holds, for counts and hit tests. */
export function notesUnder(container: FolderPlace | SubPlace): NotePlace[] {
  return "subs" in container ? container.subs.flatMap((s) => s.notes) : container.notes;
}

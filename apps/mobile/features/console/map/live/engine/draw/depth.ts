import type { FolderPlace } from "../layout";
import type { Point } from "../math";

/**
 * How near each thing on the map sits, for the 3D tilt: -1 far to 1 near,
 * one depth per folder, so a folder and everything in it lean together.
 * Notes, subfolders, folders and faces on a note take their folder's depth;
 * anything else (a workspace, a point between them) stays at 0.
 */
const depths = new WeakMap<FolderPlace, number>();
export function folderDepth(f: FolderPlace): number {
  const known = depths.get(f);
  if (known !== undefined) return known;
  let h = 2166136261;
  for (let i = 0; i < f.key.length; i += 1) h = Math.imul(h ^ f.key.charCodeAt(i), 16777619);
  const z = ((h >>> 0) / 4294967296) * 2 - 1;
  depths.set(f, z);
  return z;
}

type Placed = Point & { sub?: { folder: FolderPlace }; folder?: FolderPlace; subs?: unknown; island?: unknown; note?: { sub: { folder: FolderPlace } } | null };

export function depthOf(p: Point): number {
  const q = p as Placed;
  if (q.sub) return folderDepth(q.sub.folder);
  if (q.folder) return folderDepth(q.folder);
  if (q.subs && q.island) return folderDepth(q as unknown as FolderPlace);
  if (q.note) return folderDepth(q.note.sub.folder);
  return 0;
}

import type { FolderPlace } from "../layout";
import type { Point } from "../math";

/**
 * How near each thing on the map sits, for the 3D tilt. Every folder sits at
 * its own depth and every note a little in front of or behind its folder, as
 * in the approved prototype: turned, the map reads as a cloud, not a sheet.
 *
 * `folderDepth` is -1 far to 1 near; `zOf` is the depth in the layout's own
 * units, which the view turns and puts in perspective (`render.ts`).
 */
const depths = new WeakMap<FolderPlace, number>();
export function folderDepth(f: FolderPlace): number {
  const known = depths.get(f);
  if (known !== undefined) return known;
  const z = (hashOf(f.key) / 4294967296) * 2 - 1;
  depths.set(f, z);
  return z;
}

/** How deep a folder can sit, in layout units (the prototype's ±182 at its note spacing). */
export const FOLDER_Z = 38;

/** How far a note sits off its folder's depth: a share of the folder's radius, never less than this. */
export const NOTE_Z_MIN = 9;
export const NOTE_Z_SHARE = 0.25;

function hashOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Roughly normal, from a key: the sum of three even draws, centred. */
function gaussOf(key: string): number {
  let h = hashOf(key);
  let sum = 0;
  for (let i = 0; i < 3; i += 1) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    sum += h / 4294967296;
  }
  return (sum - 1.5) * 2;
}

const noteZ = new WeakMap<object, number>();

type Placed = Point & { key?: string; sub?: { folder: FolderPlace }; folder?: FolderPlace; subs?: unknown; island?: unknown; note?: { key: string; sub: { folder: FolderPlace } } | null };

/** The folder a placed thing belongs to, if any. */
function folderOf(q: Placed): FolderPlace | null {
  if (q.sub) return q.sub.folder;
  if (q.folder) return q.folder;
  if (q.subs && q.island) return q as unknown as FolderPlace;
  if (q.note) return q.note.sub.folder;
  return null;
}

/** -1..1: the folder's depth of anything in a folder, 0 for anything else. */
export function depthOf(p: Point): number {
  const f = folderOf(p as Placed);
  return f ? folderDepth(f) : 0;
}

/** Depth in layout units: the folder's, and for a note (or a face on one) its own place in front of or behind it. */
export function zOf(p: Point): number {
  const q = p as Placed;
  const f = folderOf(q);
  if (!f) return 0;
  const base = folderDepth(f) * FOLDER_Z;
  const note = q.sub && typeof q.key === "string" ? q : q.note ?? null;
  if (!note) return base;
  let z = noteZ.get(note);
  if (z === undefined) {
    z = gaussOf(note.key!) * Math.max(NOTE_Z_MIN, f.r * NOTE_Z_SHARE);
    noteZ.set(note, z);
  }
  return base + z;
}

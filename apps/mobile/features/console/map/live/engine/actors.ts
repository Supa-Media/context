import type { ActorView } from "./scene";
import { facesApart } from "./lod";
import type { Point } from "./math";

/**
 * Where faces are drawn: one per note up close, a pile per container further
 * out. A pile sits on the smallest container that is still big enough on
 * screen to tell apart — the subfolder, else the root folder, else the whole
 * workspace — so zooming out gathers people the way the folders gather.
 */

export type Group = {
  key: string;
  /** Screen position of the face, or of the pile's centre. */
  x: number;
  y: number;
  actors: ActorView[];
  /** One face with its own name tag, rather than a pile. */
  single: boolean;
};

/** Up close, a face sits just above and right of its note, so reading dots have room to flow. */
export const FACE_OFFSET = { x: 16, y: -18 };

/**
 * The container an actor is piled into at scale `s`, as a key:
 * `a:<actor>` alone, `s:<sub key>`, `f:<folder key>` or `i:<workspace id>`.
 */
export function pileKeyFor(actor: ActorView, s: number): string {
  if (actor.across.length >= 2 || actor.riding || facesApart(s)) return `a:${actor.id}`;
  const note = actor.note;
  if (!note) return `i:${actor.island?.workspaceId ?? ""}`;
  const sub = note.sub;
  const folder = sub.folder;
  if (sub.name !== "" && sub.r * s > 40) return `s:${sub.key}`;
  if (folder.r * s > 34) return `f:${folder.key}`;
  return `i:${folder.island.workspaceId}`;
}

/** Group actors into faces and piles and place them on screen. */
export function groupActors(actors: readonly ActorView[], s: number, screen: (p: Point) => Point): Group[] {
  const groups = new Map<string, Group>();
  for (const a of actors) {
    const key = pileKeyFor(a, s);
    let g = groups.get(key);
    if (!g) {
      const at = anchorFor(a, key, screen);
      g = { key, x: at.x, y: at.y, actors: [], single: key.startsWith("a:") };
      groups.set(key, g);
    }
    g.actors.push(a);
  }
  return [...groups.values()];
}

function anchorFor(a: ActorView, key: string, screen: (p: Point) => Point): Point {
  if (key.startsWith("a:")) {
    const p = screen(a);
    if (a.across.length >= 2 || !a.note) return p;
    return { x: p.x + FACE_OFFSET.x, y: p.y + FACE_OFFSET.y };
  }
  const note = a.note;
  if (key.startsWith("s:") && note) {
    const sub = note.sub;
    return screen({ x: sub.x, y: sub.y + sub.r });
  }
  if (key.startsWith("f:") && note) {
    const f = note.sub.folder;
    return screen({ x: f.x + f.r * 0.55, y: f.y + f.r * 0.72 });
  }
  const island = note?.sub.folder.island ?? a.island;
  if (!island) return screen(a);
  return screen({ x: island.x + island.r * 0.6, y: island.y + island.r * 0.8 });
}

/** The words under a name: what they are doing, plainly. */
export function flagLine(a: ActorView): string | null {
  if (a.across.length >= 2) {
    const names = a.across.map((i) => i.name);
    const both = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    return a.doing === "read" ? `reading from ${both}` : `working in ${both}`;
  }
  switch (a.doing) {
    case "read":
      return a.kind === "agent" && a.readCount > 1 ? `has read ${a.readCount} notes` : "reading";
    case "edit":
      return "writing";
    case "create":
      return "writing a new note";
    case "move":
      return a.movingTo ? `moving to ${a.movingTo}` : "moving a note";
    default:
      return null;
  }
}

/** The name on a flag: the viewer is "You". */
export const flagName = (a: ActorView): string => (a.self ? "You" : a.name);

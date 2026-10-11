import { toScreen, visibleRect, type Cam, type Viewport } from "./camera";
import type { Layout } from "./layout";
import { notePx } from "./lod";
import { SPACING } from "./pack";
import type { Doing } from "../types";
import type { SceneAt } from "./scene";

/**
 * Following one actor: what the panel beside the map lists ("Has read 6
 * notes, in this order") and where the camera goes when you start.
 */

export type FollowState = {
  actorId: string;
  name: string;
  kind: "person" | "agent";
  /** What they are doing now, or null when idle or gone from the map. */
  doing: Doing | null;
  /** The note they are on. */
  at: { workspaceId: string; path: string; title: string } | null;
  /** Notes read so far, oldest first. */
  reads: Array<{ workspaceId: string; path: string; title: string }>;
};

export function followSnapshot(actorId: string, scene: SceneAt): FollowState | null {
  const a = scene.actors.find((x) => x.id === actorId);
  if (!a) return null;
  return {
    actorId,
    name: a.name,
    kind: a.kind,
    doing: a.doing,
    at: a.note ? { workspaceId: a.note.workspaceId, path: a.note.path, title: a.note.title } : null,
    reads: scene.followReads.map((n) => ({ workspaceId: n.workspaceId, path: n.path, title: n.title })),
  };
}

/**
 * Where to point the camera when following starts: nowhere if the actor is
 * comfortably in view, else centred on them, close enough to see faces.
 */
export function focusTarget(scene: SceneAt, actorId: string, _layout: Layout, vp: Viewport, cam: Cam): Cam | null {
  const a = scene.actors.find((x) => x.id === actorId);
  if (!a) return null;
  const p = toScreen(cam, vp, a);
  const r = visibleRect(vp);
  const margin = 40;
  const inView = p.x > r.x + margin && p.x < r.x + r.w - margin && p.y > r.y + margin && p.y < r.y + r.h - margin;
  const closeEnough = notePx(cam.s) >= 12;
  if (inView && closeEnough) return null;
  return { x: a.x, y: a.y, s: closeEnough ? cam.s : 14 / SPACING };
}

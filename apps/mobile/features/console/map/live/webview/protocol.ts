import type { ShownFace } from "../../../faces/faceStore";
import type { Cam, CameraDetail, Inset } from "../engine/camera";
import type { FollowState } from "../engine/follow";
import type { HitTarget } from "../engine/hit";
import type { MapData } from "../engine/model";
import type { ZoomLevel } from "../types";

/**
 * The messages between the phone app and the map inside its web view.
 *
 * The map's engine draws on a `<canvas>`, which React Native does not have,
 * so the app runs the same engine in a `WebView` (`entry.ts`, compiled into
 * `bundle.generated.ts`) and talks to it in these. The host sends what the
 * web wrapper would pass as props and engine calls; the guest sends back what
 * the web wrapper's callbacks receive.
 *
 * Everything the guest sends is checked here before the app acts on it
 * (`parseGuestMessage`): opening a note is a navigation, and a message that
 * does not have exactly the expected shape is dropped.
 */

export const MAP_PROTOCOL_VERSION = 1;

/** The engine calls the zoom control, breadcrumb and panels make. */
export type MapCall =
  | { name: "zoomIn" }
  | { name: "zoomOut" }
  | { name: "zoomTo"; level: ZoomLevel }
  | { name: "fit" }
  | { name: "focusPath"; workspaceId: string; path: string }
  | { name: "diveInto"; workspaceId: string; path: string }
  | { name: "select"; note: { workspaceId: string; path: string } | null }
  | { name: "follow"; actorId: string | null }
  | { name: "restoreCamera"; cam: Cam };

export type HostMessage =
  | {
      v: number;
      type: "graphs";
      /** Bumped whenever the graphs change, so the rest of the data can travel without them. */
      graphsVersion: number;
      graphs: MapData["graphs"];
    }
  | { v: number; type: "data"; graphsVersion: number; data: Omit<MapData, "graphs"> }
  | {
      v: number;
      type: "props";
      inset: Inset | null;
      reducedMotion: boolean;
      playing: boolean;
      following: string | null | undefined;
      minimap: boolean | undefined;
    }
  | { v: number; type: "faces"; faces: Record<string, ShownFace> }
  | { v: number; type: "call"; call: MapCall };

/** A message as written, before the protocol version is stamped on it. */
export type Unversioned<T> = T extends unknown ? Omit<T, "v"> : never;

export type GuestMessage =
  | { type: "ready" }
  | { type: "failed"; message: string }
  | { type: "camera"; info: CameraDetail }
  | { type: "follow"; state: FollowState | null }
  | { type: "hover"; target: HitTarget | null }
  | { type: "openNote"; note: { workspaceId: string; path: string; at?: { x: number; y: number } } }
  | { type: "tapEmpty" }
  | { type: "diveInto"; folder: { workspaceId: string; path: string } }
  | { type: "time"; t: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

const isCoordinate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 100_000;

function place(v: unknown): { workspaceId: string; path: string } | null {
  if (!isRecord(v) || !isText(v.workspaceId, 256) || !isText(v.path)) return null;
  return { workspaceId: v.workspaceId, path: v.path };
}

/**
 * A raw `onMessage` payload as a guest message, or `null` for anything that is
 * not exactly one. The camera, follow and hover payloads go only to the
 * page's own display state, so they are checked for their outline; opening a
 * note and diving into a folder are re-built field by field.
 */
export function parseGuestMessage(raw: unknown): GuestMessage | null {
  if (typeof raw !== "string" || raw.length > 1_000_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== MAP_PROTOCOL_VERSION) return null;
  switch (value.type) {
    case "ready":
      return { type: "ready" };
    case "failed":
      return { type: "failed", message: typeof value.message === "string" ? value.message.slice(0, 500) : "unknown" };
    case "camera":
      return isRecord(value.info) && isRecord(value.info.cam) ? { type: "camera", info: value.info as unknown as CameraDetail } : null;
    case "follow":
      if (value.state === null) return { type: "follow", state: null };
      return isRecord(value.state) && isText(value.state.actorId, 256)
        ? { type: "follow", state: value.state as unknown as FollowState }
        : null;
    case "hover":
      if (value.target === null) return { type: "hover", target: null };
      return isRecord(value.target) && typeof value.target.kind === "string"
        ? { type: "hover", target: value.target as unknown as HitTarget }
        : null;
    case "openNote": {
      const note = place(value.note);
      if (note === null) return null;
      const at = isRecord(value.note) ? value.note.at : undefined;
      if (isRecord(at) && isCoordinate(at.x) && isCoordinate(at.y)) return { type: "openNote", note: { ...note, at: { x: at.x, y: at.y } } };
      return { type: "openNote", note };
    }
    case "tapEmpty":
      return { type: "tapEmpty" };
    case "diveInto": {
      const folder = place(value.folder);
      return folder ? { type: "diveInto", folder } : null;
    }
    case "time":
      return typeof value.t === "number" && Number.isFinite(value.t) ? { type: "time", t: value.t } : null;
    default:
      return null;
  }
}

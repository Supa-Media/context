import type { MapClock, ZoomLevel } from "../types";
import type { Cam, CameraDetail, Inset } from "./camera";
import type { FaceFor } from "./draw/primitives";
import type { FollowState } from "./follow";
import type { HitFrame, HitTarget } from "./hit";
import type { MapData } from "./model";

/** What `createMapEngine` takes and gives back (`engine.ts`). */

export type MapEngineOptions = {
  /** A person's picture. Agents are always drawn as the robot. */
  faceFor?: FaceFor;
  reducedMotion?: boolean;
  /** Play the map's opening (`look.opening`) the first time it has notes to draw. Off for tests and fixtures. */
  opening?: boolean;
  /** The map's own motion: the 3D tilt following the mouse and the dots breathing (`look.depth`, `look.motion`). Off for tests and fixtures. */
  ambient?: boolean;
  /** Schedule a slow frame for ambient motion (default about 15 a second). */
  slowFrame?: (cb: () => void) => unknown;
  /** Parts of the canvas covered by other UI (a bottom sheet); the camera fits the rest. */
  inset?: Inset;
  /** Draw the overview in the top-right corner once zoomed in. Default true. */
  minimap?: boolean;
  font?: string;
  /** Replay: how long somebody stays on the map after their last event. Default 10 minutes. */
  idleMs?: number;
  onCamera?: (info: CameraDetail) => void;
  onFollow?: (state: FollowState | null) => void;
  onHover?: (target: HitTarget | null) => void;
  /** A note was tapped; `at` is where, in canvas pixels, for a card beside it. */
  onOpenNote?: (note: { workspaceId: string; path: string; at?: { x: number; y: number } }) => void;
  /** A tap that landed on nothing: whatever a note tap opened can close. */
  onTapEmpty?: () => void;
  onDiveInto?: (folder: { workspaceId: string; path: string }) => void;
  /** Replay: the playhead while the engine plays it. */
  onTime?: (t: number) => void;
  /** Injected for tests: wall clock and frame scheduling. */
  now?: () => number;
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (id: number) => void;
};

export type MapEngine = {
  setData(data: MapData): void;
  setClock(clock: MapClock): void;
  /** Replay: advance the playhead at the clock's speed. */
  setPlaying(playing: boolean): void;
  follow(actorId: string | null): void;
  select(note: { workspaceId: string; path: string } | null): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomTo(level: ZoomLevel): void;
  fit(): void;
  focusPath(workspaceId: string, path: string): void;
  diveInto(workspaceId: string, folderPath: string): void;
  /** Put the camera back where it was (coming back to the map); before the first data, on its arrival. */
  restoreCamera(cam: Cam): void;
  resize(width: number, height: number, dpr?: number): void;
  setInset(inset: Inset): void;
  setReducedMotion(reduced: boolean): void;
  /** Draw again (a face image finished loading). */
  redraw(): void;
  getCamera(): CameraDetail | null;
  getFollow(): FollowState | null;
  /** Draw now at time `t` (a replay frame, or a test). */
  renderAt(t: number): HitFrame;
  hitTest(x: number, y: number): HitTarget | null;
  destroy(): void;
};


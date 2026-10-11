import { LiveMapCanvas } from "../LiveMapCanvas";
import type { MapPeek } from "../hooks/useMapPeek";
import type { MapPageState } from "../hooks/useMapPage";
import type { CameraStore } from "./CanvasOverlay";

/** Opening a note from the map: its workspace and its path. */
export type OpenMapNote = (workspaceId: string, path: string) => void;

/**
 * The canvas, wired to the page: the engine out, the camera and the playhead
 * back. A tapped note opens the card (`peek`) rather than leaving the map.
 */
export function MapCanvas({
  page,
  camera,
  peek,
  inset,
}: {
  page: MapPageState;
  camera: CameraStore;
  peek: MapPeek;
  inset?: { top: number; right: number; bottom: number; left: number };
}) {
  return (
    <LiveMapCanvas
      data={page.data}
      inset={inset}
      reducedMotion={page.reducedMotion}
      playing={page.replay?.playing === true && page.replaying}
      onEngine={(engine) => {
        page.engineRef.current = engine;
        peek.onEngine(engine);
      }}
      onCamera={(detail) => {
        camera.set(detail);
        peek.onCamera(detail);
      }}
      onFollow={page.setFollow}
      onTime={page.onTime}
      onOpenNote={(note) => peek.onTapNote({ workspaceId: note.workspaceId, path: note.path, at: note.at ?? null })}
      onTapEmpty={peek.onTapEmpty}
    />
  );
}

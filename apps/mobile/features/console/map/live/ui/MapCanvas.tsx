import { LiveMapCanvas } from "../LiveMapCanvas";
import type { MapPageState } from "../hooks/useMapPage";
import type { CameraStore } from "./CanvasOverlay";

/** Opening a note from the map: its workspace and its path. */
export type OpenMapNote = (workspaceId: string, path: string) => void;

/** The canvas, wired to the page: the engine out, the camera and the playhead back. */
export function MapCanvas({
  page,
  camera,
  onOpenNote,
  inset,
}: {
  page: MapPageState;
  camera: CameraStore;
  onOpenNote: OpenMapNote;
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
      }}
      onCamera={camera.set}
      onFollow={page.setFollow}
      onTime={page.onTime}
      onOpenNote={(note) => onOpenNote(note.workspaceId, note.path)}
    />
  );
}

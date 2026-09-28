import { useSyncExternalStore } from "react";

import { faceFor, facesVersion, myFace, myHandle, myPhotoUploaded, subscribeFaces, type ShownFace } from "./faceStore";

/**
 * The face for a name, redrawn when faces arrive or change. Touches no Convex,
 * so the homepage and the demo console can draw it (as a silhouette).
 */
export function useFace(name: string | null | undefined): ShownFace | undefined {
  useSyncExternalStore(subscribeFaces, facesVersion, facesVersion);
  return faceFor(name);
}

/** The signed-in person's own face, and the handle that colours the drawn one. */
export function useMyFace(): { face: ShownFace | undefined; handle: string | undefined; uploaded: boolean } {
  useSyncExternalStore(subscribeFaces, facesVersion, facesVersion);
  return { face: myFace(), handle: myHandle(), uploaded: myPhotoUploaded() };
}

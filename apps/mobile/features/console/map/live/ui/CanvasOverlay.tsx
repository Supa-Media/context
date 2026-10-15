import type { CameraDetail } from "../engine";

/**
 * Where the camera is, told by the engine on every frame it moves. A store
 * rather than page state, so a camera flight redraws the trail beside the
 * workspace menu (`MapDock.tsx`) and nothing else on the page.
 */
export type CameraStore = {
  set(info: CameraDetail): void;
  get(): CameraDetail | null;
  subscribe(listener: () => void): () => void;
};

export function createCameraStore(): CameraStore {
  let current: CameraDetail | null = null;
  const listeners = new Set<() => void>();
  return {
    set(info) {
      current = info;
      for (const l of listeners) l();
    },
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

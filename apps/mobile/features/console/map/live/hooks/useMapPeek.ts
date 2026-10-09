import { useCallback, useEffect, useRef, useState } from "react";
import type { CameraDetail, MapEngine } from "../engine";
import { mapMemoryKey, recallMap, rememberCamera, rememberPeek } from "../peek/mapMemory";
import type { OpenPeek } from "../ui/NotePeek";
import type { MapPageState } from "./useMapPage";

export type MapPeek = {
  /** The note the card is open on, or `null`. */
  peek: OpenPeek | null;
  close: () => void;
  /** The canvas's handlers: a note tap opens the card, a tap on nothing closes it. */
  onTapNote: (note: OpenPeek) => void;
  onTapEmpty: () => void;
  /** Kept as you move, so the map comes back where you left it. */
  onCamera: (detail: CameraDetail) => void;
  /** The engine arriving: put the camera and the highlighted note back. */
  onEngine: (engine: MapEngine | null) => void;
};

/**
 * The map's card and its memory. A dot tap opens the card on that note and
 * highlights the dot; the camera is remembered as it moves, and the card as
 * it opens and closes, per workspace and scope (`peek/mapMemory.ts`). So when
 * Expand leaves the map for the note and Back brings the map again, the
 * engine is handed the same camera and the card opens on the same note.
 */
export function useMapPeek(page: MapPageState): MapPeek {
  const key = mapMemoryKey(page.selected?.id ?? null, page.scope);
  const recalled = (k: string): OpenPeek | null => {
    const kept = recallMap(k).peek;
    return kept === null ? null : { ...kept, at: null };
  };
  const [state, setState] = useState<{ key: string; peek: OpenPeek | null }>(() => ({ key, peek: recalled(key) }));
  // Another workspace or scope remembers its own card.
  const peek = state.key === key ? state.peek : recalled(key);
  const peekRef = useRef(peek);
  peekRef.current = peek;
  const keyRef = useRef(key);
  keyRef.current = key;
  const engineRef = page.engineRef;

  const open = useCallback(
    (next: OpenPeek | null) => {
      setState({ key: keyRef.current, peek: next });
      rememberPeek(keyRef.current, next === null ? null : { workspaceId: next.workspaceId, path: next.path });
      engineRef.current?.select(next === null ? null : { workspaceId: next.workspaceId, path: next.path });
    },
    [engineRef],
  );

  useEffect(() => {
    // The card for this scope, highlighted, once the scope changes under it.
    const kept = recallMap(key).peek;
    engineRef.current?.select(kept);
  }, [key, engineRef]);

  const onCamera = useCallback((detail: CameraDetail) => rememberCamera(keyRef.current, detail.cam), []);
  const onEngine = useCallback((engine: MapEngine | null) => {
    if (engine === null) return;
    const { cam } = recallMap(keyRef.current);
    if (cam !== null) engine.restoreCamera(cam);
    const shown = peekRef.current;
    if (shown !== null) engine.select({ workspaceId: shown.workspaceId, path: shown.path });
  }, []);

  return {
    peek,
    close: useCallback(() => open(null), [open]),
    onTapNote: open,
    onTapEmpty: useCallback(() => {
      if (peekRef.current !== null) open(null);
    }, [open]),
    onCamera,
    onEngine,
  };
}

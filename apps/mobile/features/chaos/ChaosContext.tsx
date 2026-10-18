import { createContext, useContext, useMemo, useState } from "react";
import type { ChaosSource } from "./useChaosScore";

/** Where the panel is drawn: a sheet, from a folder page's line or the phone's @name menu. */
export type ChaosPanelPlace = "sheet";

/** The chaos score as every surface reads it: the numbers, the panel, and where a press goes. */
export interface ChaosView extends ChaosSource {
  panel: ChaosPanelPlace | null;
  openPanel: (place: ChaosPanelPlace) => void;
  closePanel: () => void;
  /** Opens a folder or a note, and closes the panel. */
  open: (path: string) => void;
}

/**
 * The chaos score, handed down from the console layout.
 *
 * A context because the surfaces are scattered — a folder page's head, the phone's @name menu — and each treats absence as "draw nothing", so the demo
 * console, the homepage and every render harness keep the screen they had.
 */
const ChaosContext = createContext<ChaosView | undefined>(undefined);

export const ChaosProvider = ChaosContext.Provider;

export function useChaosView(): ChaosView | undefined {
  return useContext(ChaosContext);
}

/** The view the layout provides: the source, plus which panel is open and where a press goes. */
export function useConsoleChaos(source: ChaosSource | undefined, select: (path: string) => unknown): ChaosView | undefined {
  const [panel, setPanel] = useState<ChaosPanelPlace | null>(null);
  return useMemo(
    () =>
      source === undefined
        ? undefined
        : {
            ...source,
            panel,
            openPanel: (place: ChaosPanelPlace) => setPanel(place),
            closePanel: () => setPanel(null),
            open: (path: string) => {
              setPanel(null);
              select(path);
            },
          },
    [source, panel, select],
  );
}

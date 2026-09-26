import { createContext, useContext } from "react";
import type { OrganizerView } from "./useOrganizer";

/**
 * Auto-organize, handed down from the console layout.
 *
 * A context rather than a prop because the surfaces are scattered — the
 * explorer's foot, the notices band, Settings › Premium, Activity, and the
 * phone's sheet — and every one of them treats absence as "draw nothing":
 * the landing page's demo console, the render harnesses and any mount outside
 * the console layout get exactly the screen they had before this existed.
 */
const OrganizerContext = createContext<OrganizerView | undefined>(undefined);

export const OrganizerProvider = OrganizerContext.Provider;

export function useOrganizerView(): OrganizerView | undefined {
  return useContext(OrganizerContext);
}

/** Activity's Undo for rows auto-organize wrote, or `undefined` where there is none to offer. */
export function useOrganizerUndoFor(): OrganizerView["undoFor"] | undefined {
  return useContext(OrganizerContext)?.undoFor;
}

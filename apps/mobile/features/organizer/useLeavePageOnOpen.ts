import { useEffect, useRef } from "react";
import type { OrganizerView } from "./useOrganizer";

/**
 * What changed is drawn where a note would be, so choosing a note or folder
 * is leaving it. Keyed to a *change* of selection, not to there being one:
 * the page opens over whatever was already open, and that must not close it.
 */
export function useLeavePageOnOpen(organizer: OrganizerView | undefined, selectedPath: string | null): void {
  const last = useRef(selectedPath);
  const open = organizer?.pageOpen === true;
  const close = organizer?.closePage;
  useEffect(() => {
    const changed = last.current !== selectedPath;
    last.current = selectedPath;
    if (changed && open && selectedPath !== null) close?.();
  }, [selectedPath, open, close]);
}

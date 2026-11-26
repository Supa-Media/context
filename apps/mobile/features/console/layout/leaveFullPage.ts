import { useCallback } from "react";
import { useMailRoute } from "../mailPage/MailRouteContext";
import { useMapRoute } from "../map/live/MapRouteContext";
import { useTrashRoute } from "../trash/TrashRouteContext";

/** The full pages drawn where a note would be, each closable on its own. */
export interface FullPages {
  mail?: { open: boolean; closeMail(): void };
  map?: { open: boolean; closeMap(): void };
  trash?: { open: boolean; closeTrash(): void };
}

/**
 * Close whichever full page is open (Agent Mail, the map, the trash), so what was chosen in the tree shows.
 *
 * Choosing a *different* row already left them (`useLeaveMapOnOpen`, `useConsoleMailRoute`), because the selection
 * moved. Choosing the row already selected did nothing: the selection stayed put, so the page stayed over it (Dev,
 * 2026-11-26, with "bots" selected under Agent Mail: "when people click on the left it clears the full page"). A
 * click on the tree is the signal, not a change of selection.
 */
export function leaveFullPages(pages: FullPages): void {
  if (pages.mail?.open) pages.mail.closeMail();
  if (pages.map?.open) pages.map.closeMap();
  if (pages.trash?.open) pages.trash.closeTrash();
}

/** `leaveFullPages` over the routes the console provides; a no-op outside it. */
export function useLeaveFullPages(): () => void {
  const mail = useMailRoute();
  const map = useMapRoute();
  const trash = useTrashRoute();
  return useCallback(() => leaveFullPages({ mail, map, trash }), [mail, map, trash]);
}

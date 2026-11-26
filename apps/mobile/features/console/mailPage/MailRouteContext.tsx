import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { ConsoleRouter } from "../layout/types";

/**
 * Whether the URL has the Mail page open: `?mail=1`, beside `?note=` the way
 * the Trash page rides as `?trash=1`, so Browse and the tree stay mounted under
 * it and Back and a shared link both find it. Anything but `1` is closed.
 *
 * The owner, 2026-11-25: "a mail icon underneath the map that opens up in a
 * full page view - and it can show special views for mail to bots, mail to
 * areas, and other regular notes" (boards approved the same night).
 */
export function mailFromQuery(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "1";
}

/** The Mail page's address, as the console's pieces use it. */
export interface MailRoute {
  open: boolean;
  /** The workspace whose mail this is. */
  workspaceId: string;
  /** The reader's own `@handle`, whose own messages are never new to them; absent until it is known. */
  me?: string;
  openMail(): void;
  closeMail(): void;
  /** The rail's button: open when closed, closed when open. */
  toggle(): void;
}

/** One page in the document slot at a time: opening the mail closes the map, the trash and Settings. */
export function routeMail(router: Pick<ConsoleRouter, "setParams">, open: boolean, workspaceId: string, me?: string): MailRoute {
  const openMail = () => router.setParams({ mail: "1", map: undefined, trash: undefined, settings: undefined, vault: undefined });
  const closeMail = () => router.setParams({ mail: undefined });
  return { open, workspaceId, ...(me === undefined ? {} : { me }), openMail, closeMail, toggle: () => (open ? closeMail() : openMail()) };
}

/**
 * Handed down from the console layout, for the map's reason (`MapRouteContext`):
 * the Mail button is on the right rail, the page in the document slot. Absent
 * outside the console layout (the homepage, the demo, a visitor), and then no
 * Mail button is drawn and no page can open.
 */
const MailRouteContext = createContext<MailRoute | undefined>(undefined);

export const MailRouteProvider = MailRouteContext.Provider;

export function useMailRoute(): MailRoute | undefined {
  return useContext(MailRouteContext);
}

/** The route the layout provides, and choosing a note or folder in the tree leaves it, as it leaves the map. */
export function useConsoleMailRoute(
  router: ConsoleRouter,
  open: boolean,
  { available, workspaceId, selectedPath, me }: { available: boolean; workspaceId: string | null; selectedPath: string | null; me?: string },
): MailRoute | undefined {
  const route = useMemo(
    () => (available && workspaceId !== null ? routeMail(router, open, workspaceId, me) : undefined),
    [available, router, open, workspaceId, me],
  );
  const last = useRef(selectedPath);
  const close = route?.closeMail;
  useEffect(() => {
    const changed = last.current !== selectedPath;
    last.current = selectedPath;
    if (changed && open && selectedPath !== null) close?.();
  }, [selectedPath, open, close]);
  return route;
}

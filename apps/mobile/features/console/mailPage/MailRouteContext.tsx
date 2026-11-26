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
  /** Open Agent Mail on one conversation, the note at `path` (a bot panel's "Open your mail with …"). */
  openThread(path: string): void;
  closeMail(): void;
  /** The rail's button: open when closed, closed when open. */
  toggle(): void;
}

/** One page in the document slot at a time: opening the mail closes the map, the trash and Settings. */
export function routeMail(
  router: Pick<ConsoleRouter, "setParams">,
  open: boolean,
  workspaceId: string,
  me?: string,
): MailRoute {
  const openMail = () =>
    router.setParams({ mail: "1", map: undefined, trash: undefined, settings: undefined, vault: undefined });
  const closeMail = () => router.setParams({ mail: undefined });
  return {
    open,
    workspaceId,
    ...(me === undefined ? {} : { me }),
    openMail,
    openThread: (path: string) => {
      wantThread(path);
      openMail();
    },
    closeMail,
    toggle: () => (open ? closeMail() : openMail()),
  };
}

/*
  Which conversation Agent Mail should show when it next draws, asked for from outside the page (Dev2, 2026-11-26:
  "clicking open your mail doesnt open up in the actual mail page, it opens up the note"). Held here rather than in the
  URL: the page is already one query parameter, and a path is a conversation's name, not an address to share.
*/
let wanted: string | null = null;
const wanting = new Set<(path: string) => void>();

/** Ask Agent Mail for the conversation at `path`: a page already open switches to it, a page opening starts on it. */
export function wantThread(path: string): void {
  wanted = path;
  for (const listener of wanting) listener(path);
}

/** The page takes the asked-for conversation once, and hears later asks while it is open. */
export function takeWantedThread(): string | null {
  const path = wanted;
  wanted = null;
  return path;
}

export function onWantedThread(listener: (path: string) => void): () => void {
  wanting.add(listener);
  return () => {
    wanting.delete(listener);
  };
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
/** What the console knows that the Mail route needs: not in a demo or for a visitor, and the reader's `@handle`. */
export function mailRouteFacts(
  data: {
    demo: boolean;
    selectedContextId: string | null;
    files: { selectedPath: string | null };
    viewer: { name: string };
  },
  visitor: unknown,
): {
  available: boolean;
  workspaceId: string | null;
  selectedPath: string | null;
  me?: string;
} {
  return {
    available: !data.demo && visitor === undefined,
    workspaceId: data.selectedContextId,
    selectedPath: data.files.selectedPath,
    ...(data.viewer.name.startsWith("@") ? { me: data.viewer.name } : {}),
  };
}

/**
 * The tab strip's label override: while Agent Mail fills the document slot, the active tab says so rather than naming
 * the note behind it (Dev2's screenshot, 2026-11-26: the tab read "seyi" over the Mail page). Otherwise the title being
 * typed, as before.
 */
export function mailTabLabel<T extends { path: string; label: string | null }>(
  route: MailRoute | undefined,
  activePath: string | null,
  titleEdit: T | null | undefined,
): { path: string; label: string | null } | null | undefined {
  if (route?.open === true && activePath !== null) return { path: activePath, label: "Agent Mail" };
  return titleEdit;
}

export function useConsoleMailRoute(
  router: ConsoleRouter,
  open: boolean,
  {
    available,
    workspaceId,
    selectedPath,
    me,
  }: {
    available: boolean;
    workspaceId: string | null;
    selectedPath: string | null;
    me?: string;
  },
): MailRoute | undefined {
  const route = useMemo(
    () =>
      available && workspaceId !== null
        ? routeMail(router, open, workspaceId, me)
        : undefined,
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

import { useCallback, useState } from "react";
import type { AgentActivityView } from "../console/agents/agentActivity";
import type { FileBrowser, NoteRename } from "../console/files/browser/contract";
import type { ConsoleContext, ConsoleData, VisitorMeetings } from "../console/types";
import { UNKNOWN_INITIAL } from "../console/identity";
import { useDemoConsoleData } from "../console/useDemoConsoleData";
import type { ToastSpec } from "../design/components/Toast";
import { HOME_WORKSPACE_LABEL } from "./homeSite";

/**
 * The homepage's notes as `ConsoleData`, so the console's own frame draws them.
 *
 * The homepage is `ConsoleFrame` over the website's notes (`HomeShell`), and
 * the frame reads one object for everything it draws. This is that object for
 * somebody who has not signed in: one workspace, `@context`, holding the notes
 * `useLocalFileBrowser` keeps in this tab, and a viewer called Visitor.
 *
 * Built on the landing page's demo data, for the fields the frame reads and a
 * visitor never reaches (the map, settings' cards). Those are emptied where
 * they could show — nobody else's members, shares or activity — and `demo`
 * stays true, which is what keeps every server-backed control out: meetings,
 * the agent panel, storage settings, the emoji library. `visitor` is what
 * gives back what a visitor can do. See `VisitorActions`.
 */
export const HOME_CONTEXT: ConsoleContext = {
  id: "home",
  slug: HOME_WORKSPACE_LABEL.replace(/^@/, ""),
  displayName: HOME_WORKSPACE_LABEL,
  /*
    `owner`, because in their tab the visitor can do everything to these notes.
    It is also the role the console draws no tier chip and no "team access"
    band for, and neither is true here: nothing is held back from them.
  */
  role: "owner",
  kind: "shared",
  status: "ok",
};

const VISITOR = { name: "Visitor", detail: "Not signed in", initial: UNKNOWN_INITIAL };
/*
  Somebody signed in can read the homepage too — `/` on the web is always the
  site. They are not a visitor, and their own workspaces are a press away, but
  this page has none of their data: it asks the server nothing, so it cannot
  name them. "Signed in" is `viewerIdentity`'s own word for that gap.
*/
const SIGNED_IN = { name: "Signed in", detail: "Your workspaces are in the app", initial: UNKNOWN_INITIAL };

export function useVisitorConsoleData(
  files: FileBrowser,
  actions: {
    signedIn: boolean;
    /** Sign in or join: brings the page's `join` card into view. */
    signIn: () => void;
    openApp: () => void;
    /** The page's public address, or `null` for a note that has none. */
    linkFor: (path: string) => string | null;
    copy: (text: string) => Promise<boolean>;
    /** Recording a demo meeting into this tab. See `features/home/meeting`. */
    meetings?: VisitorMeetings;
  },
  renamed: NoteRename | null,
  /** What the homepage's cast of agents has read and written this visit. */
  agents?: AgentActivityView,
  /** A sentence the homepage itself has to say, such as a demo meeting stopping. */
  notice: { toast: ToastSpec; dismiss: () => void } | null = null,
): ConsoleData {
  const demo = useDemoConsoleData();
  const [toast, setToast] = useState<ToastSpec | null>(null);
  const { linkFor, copy, signIn, openApp, signedIn, meetings } = actions;

  const share = useCallback(
    (path: string) => {
      const link = linkFor(path);
      const say = (message: string, tone?: ToastSpec["tone"]) =>
        setToast({ id: `visitor-share-${Date.now()}`, message, tone });
      if (link === null) return say("This note is only in this tab, so it has no link yet.", "warn");
      void copy(link).then((ok) =>
        ok ? say("Link copied.") : say(`Couldn't copy the link: ${link}`, "warn"),
      );
    },
    [copy, linkFor],
  );

  const dismissToast = files.dismissToast;
  const own = [toast, notice?.toast].filter((spec): spec is ToastSpec => spec != null);
  const withToast: FileBrowser = {
    ...files,
    renamed,
    toasts: own.length === 0 ? files.toasts : [...files.toasts, ...own],
    dismissToast: (id: string) =>
      id === toast?.id ? setToast(null) : id === notice?.toast.id ? notice.dismiss() : dismissToast(id),
  };

  return {
    ...demo,
    // Invite-only: one "Sign in or join", never a separate "Create
    // workspace" (Dev2, 2026-09-28).
    visitor: signedIn ? { openApp, share, meetings } : { signIn, share, meetings },
    viewer: signedIn ? SIGNED_IN : VISITOR,
    contexts: [HOME_CONTEXT],
    selectedContextId: HOME_CONTEXT.id,
    selectContext: () => {},
    stats: [],
    clients: [],
    // No bucket to name: the storage chip and its status segment stay away.
    storage: undefined,
    activity: undefined,
    agents,
    members: { ...demo.members, members: [], invitations: [] },
    shares: { ...demo.shares, shares: [] },
    files: withToast,
  };
}

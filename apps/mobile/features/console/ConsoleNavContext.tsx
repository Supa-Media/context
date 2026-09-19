import { createContext, useContext, type ReactNode } from "react";
import type { NoteLinkOpen } from "./files/noteLinks";

/**
 * Moving between places, shared down to the pane routes.
 *
 * `ConsoleDataContext` beside this carries the console's *data*; this carries
 * the two verbs that data cannot answer on its own, because both belong to the
 * layout above `<Slot/>` and are needed by a component below it:
 *
 *  - **`follow`** is `useTabs`'s, and a link followed in the editor has to
 *    reach it. Going through `files.select` instead — which is what the editor
 *    did — opens a *preview* tab, so following a link replaced the note it came
 *    from and walking two links deep left nothing behind to come back to.
 *  - **`back` / `forward`** are `history.ts`'s, and the note's own breadcrumb
 *    draws them. They existed only in `ConsoleBottomBar`, which `frame.ts`
 *    draws at `compact` alone, so a pointer layout kept a full history and
 *    offered no way to walk it.
 *
 * A second context rather than more keys on `ConsoleData`, because that object
 * is `useLiveConsoleData`'s return value — everything in it is Convex state or
 * the file browser — and these are the *layout's* controls. Putting them there
 * would mean every consumer of the console's data re-rendering on a tab or
 * history change that most of them cannot see.
 *
 * `null` where there is nowhere to navigate: the landing page's demo console
 * renders a pane with no layout above it, and `useConsoleNav` answers `null`
 * there rather than throwing. The editor then draws links as plain text, which
 * is the honest answer for a console that has one note and no tabs.
 */
export interface ConsoleNav {
  /** A link in the open note was followed. See `useTabs`. */
  follow: (path: string, mode: NoteLinkOpen) => void;
  /** Somewhere you were. Dimmed rather than hidden at the ends. */
  back: () => void;
  forward: () => void;
  canBack: boolean;
  canForward: boolean;
}

const ConsoleNavContext = createContext<ConsoleNav | null>(null);

export function ConsoleNavProvider({
  value,
  children,
}: {
  value: ConsoleNav;
  children: ReactNode;
}) {
  return <ConsoleNavContext.Provider value={value}>{children}</ConsoleNavContext.Provider>;
}

/** The console's navigation, or `null` outside a console layout. */
export function useConsoleNav(): ConsoleNav | null {
  return useContext(ConsoleNavContext);
}

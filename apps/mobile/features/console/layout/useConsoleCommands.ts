import { useCallback, useMemo, type Dispatch, type SetStateAction } from "react";
import type { ConsoleNav } from "../ConsoleNavContext";
import { needsDecision } from "../files/editor";
import { canGoBack, canGoForward, type HistoryState } from "../files/history";
import { closeIntent, isTabDirty } from "../files/tabs";
import type { useTabs } from "../files/useTabs";
import type { ConsoleData } from "../types";

/**
 * The console's `nav` — the verbs the panes below `<Slot/>` reach through
 * `ConsoleNavContext` — and closing a tab. Lifted out of the console layout
 * whole, so the memo and the callback keep their dependencies and their order.
 */
export function useConsoleCommands({
  tabs,
  step,
  history,
  data,
  setClosingTab,
}: {
  tabs: ReturnType<typeof useTabs>;
  step: (delta: -1 | 1) => void;
  history: HistoryState;
  data: ConsoleData;
  setClosingTab: Dispatch<SetStateAction<string | null>>;
}): { nav: ConsoleNav; closeTab: (path: string) => void } {
  /**
   * The two verbs the panes below `<Slot/>` cannot reach on their own.
   *
   * `follow` is a link in the open note; `back`/`forward` are the breadcrumb's
   * `‹ ›`, which until now existed only in the phone's bottom bar. Both live
   * up here — `useTabs` and `history` are this component's state — and both
   * are needed inside `BrowsePane`, which is a separate route. See
   * `ConsoleNavContext`.
   */
  const nav = useMemo<ConsoleNav>(
    () => ({
      follow: tabs.follow,
      back: () => step(-1),
      forward: () => step(1),
      canBack: canGoBack(history),
      canForward: canGoForward(history),
    }),
    [tabs.follow, step, history],
  );

  /**
   * Close a tab: write what is pending, and ask only about what cannot be.
   *
   * The clean tabs — nearly all of them — still close on one press. A confirm
   * on every close would train people to dismiss it, which is how the one that
   * mattered gets dismissed too, and closing a tab with an ordinary draft in it
   * used to raise exactly that: a question whose honest answer was always
   * "yes, obviously save it".
   *
   * So the ordinary draft is flushed instead — by path, because the tab being
   * closed is not always the note in the editor, and closing tab B must not
   * spend a write on tab A's draft before its own timer is due. What is left is
   * `needsDecision`: a conflict, and a save that failed. Both are about the
   * note in the editor, which is the only note the console holds a draft for.
   */
  const closeTab = useCallback(
    (path: string) => {
      const editor = data.files.editor;
      const intent = closeIntent({
        dirty: isTabDirty(tabs.state, path),
        open: editor.path === path,
        undecided: needsDecision(editor),
      });
      if (intent === "confirm") return setClosingTab(path);
      // By path: closing tab B must not spend a write on tab A's draft before
      // its own timer is due. A `close` intent has nothing pending anyway.
      if (intent === "flush") data.files.flushAutosave(path);
      tabs.close(path);
    },
    // The layout's list, unchanged: `setClosingTab` is its `useState` setter,
    // stable by construction, which the rule cannot see through a parameter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.files, tabs],
  );
  return { nav, closeTab };
}

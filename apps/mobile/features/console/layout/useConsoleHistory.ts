import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  arrived,
  currentPlace,
  emptyHistory,
  placeOf,
  samePlace,
  stepped,
  type HistoryState,
  type Place,
} from "../files/history";
import { hrefFor, type ConsoleRoute, type settingsFromQuery } from "../nav";
import { selectedContext, type ConsoleData } from "../types";
import type { ConsoleRouter } from "./types";

/**
 * Where you have been in this context, and the step back or forward through
 * it — the console layout's `history` state and its `step`, lifted out whole
 * so the hooks run in the order they always did.
 */
export function useConsoleHistory({
  data,
  router,
  route,
  openSettingsSection,
}: {
  data: ConsoleData;
  router: ConsoleRouter;
  route: ConsoleRoute;
  openSettingsSection: ReturnType<typeof settingsFromQuery>;
}): { history: HistoryState; step: (delta: -1 | 1) => void } {
  /*
    Where you have been in this context, for the toolbar's `‹` and `›`.

    Recorded from the selection rather than from `select` call sites, because
    the selection moves from the tree, the tab strip, the palette, a search hit
    and a rename, and a history that only knew about some of those would send
    you back somewhere you had not been. Keyed on the context for the reason
    `useTabs` is: a path is relative to a bucket.
  */
  const [history, setHistory] = useState<HistoryState>(emptyHistory);
  /*
    THE PLACE A BACK OR FORWARD PRESS IS ON ITS WAY TO, or `null`.

    So the effect below does not record the move as a fresh visit — which would
    truncate the forward tail on the first press of `‹` and make `›` dead.

    **A place rather than the boolean it was**, because a step can now change
    two things. Reaching a note from Map is a `router.replace` *and* a
    `select`, and if those land in two renders the intermediate one is a real
    `here` — the old path under the new route — which a one-shot boolean
    spends itself on, leaving the arrival to be recorded as a fresh visit and
    the forward tail truncated by the very press that was meant to walk it.
    Holding the destination instead means every state between the press and
    the arrival is skipped, however many there are, and the flag clears on the
    place it was waiting for rather than on the next render to come along.
  */
  const navigatingTo = useRef<Place | null>(null);
  const selectedPath = data.files.selectedPath;

  useEffect(() => {
    setHistory(emptyHistory);
  }, [data.selectedContextId]);

  /** The context a path place belongs to, for a step that has left it. */
  const contextSlug = selectedContext(data)?.slug ?? null;
  /*
    WHERE YOU ARE, AS ONE PLACE, WHATEVER KIND OF PAGE IT IS.

    This effect watched `selectedPath` alone, so Settings, Search, Map and
    Connections were not somewhere you had been — they were nothing at all, and
    `‹` walked past them to the note underneath. That was the reported defect:
    open Settings, open a note from it, press back, and you land on the
    previous *note*.

    The console already knows which page it is on — the URL says so — so this
    derives the place from the same three things the render does, in the order
    the screen stacks them: the settings overlay is on top of everything when
    it is open, an app pane is not inside a context at all, and otherwise you
    are on the selected path. One expression, so the list cannot disagree with
    what is drawn.
  */
  const here = useMemo<Place | null>(
    () =>
      placeOf({
        settingsSection: openSettingsSection,
        routeKind: route.kind,
        appSection: route.kind === "app" ? route.section : null,
        selectedPath,
      }),
    [openSettingsSection, route, selectedPath],
  );

  useEffect(() => {
    if (here === null) return;
    if (navigatingTo.current !== null) {
      if (samePlace(navigatingTo.current, here)) navigatingTo.current = null;
      return;
    }
    /*
      `arrived`, not `visited`: on the web this effect is also where a press of
      the **browser's own back button** lands — it changes `?note=`, the route
      opens that note, and the selection moves. Recorded as a fresh visit that
      would truncate the forward tail, so the browser could go back and `›`
      could never go forward again. See `history.ts`.
    */
    setHistory((current) => arrived(current, here));
  }, [here]);

  const step = useCallback(
    (delta: -1 | 1) => {
      setHistory((state) => {
        const next = stepped(state, delta);
        const place = currentPlace(next);
        if (next === state || place === null) return state;
        navigatingTo.current = place;

        /*
          Applying a place is the mirror of deriving one, and each kind has to
          undo the others: arriving at a note with the settings overlay still
          up would draw the note behind a panel nobody asked to keep, and
          arriving at a settings section from Map has to be back inside the
          context first.
        */
        if (place.kind === "settings") {
          router.setParams({ settings: place.section });
          return next;
        }

        if (place.kind === "app") {
          router.setParams({ settings: undefined });
          router.replace(hrefFor({ kind: "app", section: place.section }));
          return next;
        }

        if (openSettingsSection !== null) router.setParams({ settings: undefined });
        /*
          Back into the context first, when the step is leaving an app pane:
          Map is not inside one, and selecting a path while the route still
          says `app` moves the selection under a screen that is not showing it.

          `hrefFor` rather than `contextHrefFrom`, and for two reasons. It is
          pure, so it is not a dependency declared 140 lines below this — and
          `contextHrefFrom` resolves a context to the *last place you were in
          it*, which is the opposite of what a back step wants: the place is
          already decided, and `select` below is what applies it.
        */
        if (route.kind !== "context" && contextSlug !== null) {
          router.replace(hrefFor({ kind: "context", slug: contextSlug, view: "browse" }));
        }
        // The guard can still refuse — an unsaved draft. Then the selection
        // does not move, and neither should the cursor.
        if (!data.files.select(place.path)) {
          navigatingTo.current = null;
          return state;
        }
        return next;
      });
    },
    [contextSlug, data.files, openSettingsSection, route, router],
  );
  return { history, step };
}

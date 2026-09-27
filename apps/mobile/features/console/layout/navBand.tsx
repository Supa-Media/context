import { CurrentContextPill } from "../ContextStrip";
import { currentContextPress, hrefFor, sameRoute, type ConsoleRoute } from "../nav";
import type { ConsoleContext, ConsoleData } from "../types";
import type { ConsoleRouter } from "./types";
import type { ConsoleAside } from "./useConsoleAside";

/**
 * The phone's navigation band: the context you are in, at the head of its path.
 *
 * Returns the `nodes` `NavBandProvider` takes, built fresh each render exactly
 * as the object literal it replaced was.
 */
export function consoleNavBandNodes({
  phone,
  current,
  route,
  router,
  data,
  contextHrefFrom,
}: {
  phone: boolean;
  current: ConsoleContext | null;
  route: ConsoleRoute;
  router: ConsoleRouter;
  data: ConsoleData;
  contextHrefFrom: ConsoleAside["contextHrefFrom"];
}) {
  return {
    /*
      The context you are IN, at the head of the breadcrumb — the way up
      to its root, and the long-press route to its settings. Absent
      outside a context (the app-level panes), where there is no root to
      open and nothing to name.
    */
    current:
      phone && current !== null ? (
        <CurrentContextPill
          context={current}
          /*
            `deselect()`, not `router.replace(browseHref(slug))`. That
            was the shipped fix's own words for "open the root", and it
            is exactly right about *where* the root is and exactly
            wrong about how to get there while already standing in it:
            `router.replace` is a `REPLACE` action, `StackRouter`
            mints a fresh route key for every one regardless of
            whether the params actually changed, and a fresh key
            remounts `ContextBrowseRoute` — while `ConsoleDataProvider`
            and `FileBrowser` stay mounted here in `_layout` and do
            not. `useNoteAddress`'s `seen` ref lives on the remounted
            side, so it resets to `null` on every press, and the note
            it should have closed comes right back — see
            `docs/decisions/app-and-console.md`, "the first fix did
            not hold".

            There is nothing to navigate *to*: deselecting is the
            entire effect a round trip to the same route with no
            `?note=` was standing in for. `useNoteAddress` sees the
            selection change under an unchanged URL and mirrors it —
            the same "address" step a tapped-closed tab already takes
            — so the URL still ends up at the bare context, one commit
            later, with no remount and no `seen` reset anywhere. It
            also covers standing in a top-level *folder*:
            `selectedPath` names the folder, and `deselect` clears
            that exactly as it clears a note. `E2EFixtureScreen.tsx`
            already does this for the same reason — it is what the
            navigation *does* to this browser's state, and there is no
            router in that fixture to stand in for it.
          */
          onOpenRoot={() => {
            /*
              **And on an app-level pane it is a navigation after all.**

              Everything above is about pressing this while standing
              *in* the context: there is nowhere to go, and deselecting
              is the whole of the effect. On Search, Map or Connections
              there is somewhere to go and deselecting did nothing you
              could see — which, on a phone, left those three panes with
              no way out at all: `regionsFor` draws no rail there and the
              console passes no bottom toolbar off Browse, so the strip
              is the only navigation on the glass and its own pill was
              the one dead pill in it.

              `replace`, and through the remembered place, so leaving a
              pane puts somebody back on the note they had open rather
              than at the root of a context they never left.
            */
            if (currentContextPress(route) === "navigate") {
              router.replace(contextHrefFrom(current.slug));
              return;
            }
            data.files.deselect();
          }}
          onSelect={(next) => {
            if (!sameRoute(next, route)) router.replace(hrefFor(next));
          }}
          onLeaveContext={(id) => {
            void data.leaveContext?.(id);
            router.replace("/console");
          }}
        />
      ) : null,
    /*
      No workspace chip row on a phone any more (owner, 2026-09-27, the phone
      artboards, screen 9). Switching workspaces — with the claim offer and
      New workspace — lives in the account sheet behind the top-left slot
      (`SwitcherMenu`'s `"phone"` trigger), which a phone always shows, and
      the path row keeps the context you are in at its head as the way up.
    */
    contexts: null,
  };
}

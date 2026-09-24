import { ContextStrip, CurrentContextPill } from "../ContextStrip";
import { currentContextPress, hrefFor, sameRoute, type ConsoleRoute } from "../nav";
import { DEFAULT_SETTINGS_SECTION } from "../settings/sections";
import type { ConsoleContext, ConsoleData } from "../types";
import { NEW_WORKSPACE_ROUTE } from "../../workspace/create";
import { WELCOME_ROUTE } from "../../onboarding/route";
import type { ConsoleRouter } from "./types";
import type { ConsoleAside } from "./useConsoleAside";

/**
 * The phone's navigation band: the context you are in, and the others.
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
  places,
}: {
  phone: boolean;
  current: ConsoleContext | null;
  route: ConsoleRoute;
  router: ConsoleRouter;
  data: ConsoleData;
  contextHrefFrom: ConsoleAside["contextHrefFrom"];
  places: ConsoleAside["places"];
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
    contexts: phone ? (
      <ContextStrip
        contexts={data.contexts}
        currentSlug={current?.slug ?? null}
        recent={places}
        loading={data.loading}
        /*
          Resolved at press time, never when the strip rendered: the
          log moves on every navigation, so an href worked out at
          render is the answer to where somebody was two contexts ago.

          This is what keeps a switch on the path you had open there
          rather than dropping you at the root. `contextHrefFrom` falls
          back to the root on its own when nothing is remembered, when
          the slug is no longer reachable, or when the path does not
          resolve.

          Every pill here is a context you are **not** in — the current
          one is `CurrentContextPill` above — so there is no case where
          this resolves to where somebody already is.
        */
        onOpen={(slug) => router.replace(contextHrefFrom(slug))}
        onSelect={(next) => {
          /*
            Settings on the context you are already in is a parameter,
            not a navigation: `hrefFor` emits the legacy path for a
            settings route, and replacing with it drops the `?note=`
            beside it — closing somebody's note as a side effect of
            opening settings, which is the whole defect the overlay
            exists to fix.
          */
          if (
            next.kind === "context" &&
            next.view === "settings" &&
            route.kind === "context" &&
            next.slug === route.slug
          ) {
            router.setParams({ settings: DEFAULT_SETTINGS_SECTION });
            return;
          }
          if (!sameRoute(next, route)) router.replace(hrefFor(next));
        }}
        onLeaveContext={(id) => {
          void data.leaveContext?.(id);
          router.replace("/console");
        }}
        onClaimContext={data.demo ? undefined : () => router.push(WELCOME_ROUTE)}
        onCreateWorkspace={
          data.demo ? undefined : () => router.push(NEW_WORKSPACE_ROUTE)
        }
      />
    ) : null,
  };
}

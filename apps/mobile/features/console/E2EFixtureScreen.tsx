import { useState } from "react";
import { View } from "react-native";
import { BrowsePane } from "./panes/BrowsePane";
import { ContextStrip, CurrentContextPill } from "./ContextStrip";
import { NavBandProvider } from "./NavBand";
import { selectedContext } from "./types";
import { useE2EFixtureConsoleData } from "./e2eFixtureData";

/**
 * The real phone console — `BrowsePane` under a `NavBandProvider` — on the
 * fixture data `apps/mobile/e2e/webkit` drives.
 *
 * **Not `ConsoleShell`.** That component is `Landing.tsx`'s marketing
 * mockup — a fake window with its own rail, used only so the landing page can
 * show "the real console components running on demo data" beside a hero. It
 * never wraps its content in a `NavBandProvider`, so the breadcrumb's lit
 * context pill (`nav-context-${slug}`, case (e)'s target) does not exist
 * inside it at all — the strip and the pill are supplied by whoever mounts
 * `NavBand`'s children, and on the landing page nobody does.
 *
 * The real supplier is `app/(app)/console/_layout.tsx`, which this wiring is
 * copied from (the `NavBandProvider` block, `phone` forced true, `current`
 * and `contexts` built the same way) — minus the `expo-router` navigation
 * `onSelect`/`onOpen`/`onLeaveContext` call, since there is no signed-in
 * session or URL here for them to act on. `onOpenRoot` calls
 * `files.deselect()` directly instead of `router.replace(browseHref(...))`:
 * deselect is what that navigation *does* to this browser's state, and the
 * suite is verifying that state, not a URL.
 *
 * `AppFrame`'s bottom toolbar and rail are not part of this: none of the five
 * WebKit cases presses either, and pulling in `AppFrame`, `EditorRegion` and
 * `useTabs` would mean reproducing `(app)/console/_layout.tsx`'s tab strip and
 * keyboard scope for no case that exercises them. If a future case needs the
 * toolbar, it belongs here rather than as a second fixture.
 *
 * ## `onOpenComms`, without a router
 *
 * The real route implements this by pushing `noteHref(slug, path, anchor)` —
 * a genuine navigation, because a contact's activity link names an anchor
 * `files.select` has no way to carry (see `BrowsePane`'s own comment on the
 * prop). There is no `expo-router` here to push through, so this keeps the
 * one thing that navigation actually *does* to the browser and the screen: it
 * selects the path and remembers the anchor in local state, which
 * `BrowsePane` reads back exactly as it would read `?anchor=` off a URL. A
 * context switch clears it the same way a fresh URL would.
 */
export function E2EFixtureScreen() {
  const data = useE2EFixtureConsoleData();
  const current = selectedContext(data);
  const [anchor, setAnchor] = useState<string | null>(null);

  return (
    <View style={{ flex: 1 }}>
      <NavBandProvider
        nodes={{
          current:
            current === null ? null : (
              <CurrentContextPill
                context={current}
                onOpenRoot={() => {
                  setAnchor(null);
                  data.files.deselect();
                }}
                onSelect={() => {}}
              />
            ),
          contexts: (
            <ContextStrip
              contexts={data.contexts}
              currentSlug={current?.slug ?? null}
              recent={[]}
              loading={data.loading}
              onOpen={(slug) => {
                setAnchor(null);
                data.selectContext(slug);
              }}
              onSelect={() => {}}
            />
          ),
        }}
      >
        <BrowsePane
          data={data}
          onOpenSettings={() => {}}
          anchor={anchor}
          onOpenComms={(path, targetAnchor) => {
            setAnchor(targetAnchor ?? null);
            data.files.select(path);
          }}
        />
      </NavBandProvider>
    </View>
  );
}

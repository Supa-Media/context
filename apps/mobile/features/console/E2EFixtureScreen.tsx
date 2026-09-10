import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { AccountBlock } from "./ConsoleRail";
import { BrowsePane } from "./panes/BrowsePane";
import { ContextStrip, CurrentContextPill } from "./ContextStrip";
import { NavBandProvider } from "./NavBand";
import { SettingsOverlay } from "./settings/SettingsOverlay";
import {
  DEFAULT_ACCOUNT_SETTINGS_SECTION,
  DEFAULT_SETTINGS_SECTION,
  type SettingsSectionKey,
} from "./settings/sections";
import { space } from "../design/tokens";
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
 * `AppFrame`'s bottom toolbar and rail are not part of this: none of the
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
 *
 * ## Settings, without a URL
 *
 * `SettingsOverlay` had no browser-reachable surface anywhere in this
 * repository until it was wired here, and the bill for that arrived as
 * defects that passed a fully green suite: `rowTouch` carrying a
 * `justifyContent: "center"` that centred every label in the phone's list,
 * a temporal dead zone that crashed the overlay behind an error boundary
 * with typecheck clean, and a panel that was a heading over an empty page.
 * `BrowsePane`'s own `onOpenSettings` could not close that gap — it is
 * behind a "Connect a bucket" button drawn only while a context has *no*
 * bucket, and every context in the demo data has one — so the way in here is
 * the same one a phone actually has: `AccountBlock`'s gear, the control
 * `__tests__/accountSettingsControl.test.ts` exists to keep on screen,
 * mounted from `ConsoleRail` rather than reproduced.
 *
 * The section is component state where `app/(app)/console/_layout.tsx` reads
 * it out of `?settings=` and writes it with `router.setParams`. That is the
 * same substitution the rest of this file makes: `onSelect` keeps what the
 * navigation *does* — which section is drawn — and `onDismiss` keeps what
 * dropping the query parameter does, without pretending there is a URL.
 * `onSwitchContext` is the real route's `settingsHref(slug, section)` minus
 * its href: the context changes and the open section does not, because
 * switching contexts inside settings must not also change the subject.
 *
 * Three of the overlay's props are absent rather than stubbed, for the reason
 * their own doc comments give: `onOpenSection` and `onOpenInvitation` are
 * navigations with no router behind them here, and `onSignOut` has no session
 * to end. Each is optional and each is drawn as nothing when omitted — a
 * button that cannot do what it says is the control `ClientRow`'s Revoke
 * comment refuses to draw. `AccountBlock`'s own sign-out is not optional, so
 * it is the one inert press on this screen (`onSelect={() => {}}` above is
 * the same bargain); no case presses it.
 */
export function E2EFixtureScreen() {
  const data = useE2EFixtureConsoleData();
  const current = selectedContext(data);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsSectionKey | null>(null);

  /*
    Slug in, id out — the resolution `Landing.tsx` and the console layout both
    run against a route before touching `selectContext`, which takes a
    *context id*. The two are the same string for `@seyi` and `@lk` and are
    not for `@public-worship` (id `pw`), so passing a slug straight through
    silently failed to switch to exactly the context whose binding is the
    unhealthy one — the row the settings list draws an amber dot beside.
  */
  const openContext = (slug: string) => {
    const match = data.contexts.find((context) => context.slug === slug);
    if (match !== undefined) data.selectContext(match.id);
  };

  /*
    Which section a press lands on, from the console layout: a context's own
    Overview where there is a context, and an account section where there is
    not — there is no note in the URL to preserve off a context, and the
    account scope is what somebody with nothing selected can act on.
  */
  const openSettings = () =>
    setSettings(current === null ? DEFAULT_ACCOUNT_SETTINGS_SECTION : DEFAULT_SETTINGS_SECTION);

  return (
    <View style={{ flex: 1 }}>
      {/*
        The phone top bar's account slot, reduced to the block itself:
        `AppFrame` is not mounted here (see this file's header), and the
        account menu is the one settings control that is on screen at every
        density.

        `compact` and `touch` at every width, which the real console does not
        do — it draws this block compact in the phone's top bar and full in
        the pointer layout's rail, and neither of those two containers exists
        on this screen. Both forms opened the same gear, labelled "Settings",
        for as long as `compact` drew one of its own; it no longer does
        (`ConsoleRail.tsx`'s own comment: "the compact corner used to be two
        controls, and one of them signed you out on one press"), so what this
        screen offers at every width now is the account menu's "Settings…"
        row rather than a standalone gear — `settings.spec.ts`'s pointer-width
        case goes through that same menu for exactly this reason, not through
        the rail's untouched `rail-settings` control, which this screen never
        mounts. The shape that needs no container is still the honest one to
        mount here; a case about the rail's own layout would need the rail,
        not this.
      */}
      <View style={styles.account}>
        <AccountBlock
          name={data.viewer.name}
          detail={data.viewer.detail}
          initial={data.viewer.initial}
          compact
          touch
          onOpenSettings={openSettings}
          onSignOut={() => {}}
        />
      </View>
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
                openContext(slug);
              }}
              onSelect={() => {}}
            />
          ),
        }}
      >
        <BrowsePane
          data={data}
          onOpenSettings={openSettings}
          anchor={anchor}
          onOpenComms={(path, targetAnchor) => {
            setAnchor(targetAnchor ?? null);
            data.files.select(path);
          }}
        />
      </NavBandProvider>

      {settings === null ? null : (
        <SettingsOverlay
          data={data}
          section={settings}
          onSelect={setSettings}
          onSwitchContext={(slug) => {
            setAnchor(null);
            openContext(slug);
          }}
          onDismiss={() => setSettings(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  account: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: space.x3 },
});

import { useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { AccountBlock } from "./AccountBlock";
import { SwitcherMenu } from "./SwitcherMenu";
import { BrowsePane } from "./panes/BrowsePane";
import { ContextStrip, CurrentContextPill } from "./ContextStrip";
import { NavBandProvider } from "./NavBand";
import type { CheckoutOutcome } from "@context/shared";
import { SettingsOverlay } from "./settings/SettingsOverlay";
import {
  DEFAULT_ACCOUNT_SETTINGS_SECTION,
  DEFAULT_SETTINGS_SECTION,
  type SettingsSectionKey,
} from "./settings/sections";
import { densityFor } from "../app/frame";
import { layout, space } from "../design/tokens";
import { atName } from "./format";
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
 * `AppFrame`'s bottom toolbar is not part of this: none of the WebKit cases
 * presses it, and pulling in `AppFrame`, `EditorRegion` and `useTabs` would
 * mean reproducing `(app)/console/_layout.tsx`'s tab strip and keyboard scope
 * for no case that exercises them. If a future case needs the toolbar, it
 * belongs here rather than as a second fixture.
 *
 * ## The pointer layout's switcher **is** part of this, and leaving it out was a hole
 *
 * It used to be on that list, on the same argument, and the argument was
 * wrong — not about effort but about what this screen is. Measured in a
 * browser: at 1440×900 this fixture answered three `[role=button]` elements in
 * the whole console — an avatar, one breadcrumb crumb, and the save pill —
 * while the same fixture at 390×844 drew `@lk` and `@public-worship` above the
 * path. A person could not reach another context on the larger screen at all.
 *
 * That is not what the product does. `BrowsePane` draws `NavBand` at compact
 * only, because at medium and wide the contexts are the title bar's —
 * one switcher per density, never two, which `features/app/frame.ts` argues at
 * length. A fixture that mounts the compact half and not the pointer half is
 * therefore not "the console minus a region nobody presses": above 880pt it is
 * a console with no navigation, and it reports a defect the product does not
 * have.
 *
 * So the density decision is taken here the way the product takes it —
 * `densityFor`, not a width literal — and the pointer half is the real
 * `SwitcherMenu`. **It used to be the real `ConsoleRail`, in a plain `View` at
 * `layout.railWidth`**, and that column is gone from the product: the rail
 * folded into the menu under the name in the title bar
 * (`docs/decisions/app-and-console.md`). What is still not reproduced is
 * `AppFrame` itself.
 *
 * The account block stays in the corner at every density now, because there is
 * no rail for it to be the foot of. `settings.spec.ts`'s pointer case goes
 * through `switcher-settings` in that menu, which is the control the product
 * actually has there.
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
 * mounted from `AccountBlock` rather than reproduced.
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
 * Two of the overlay's props are absent rather than stubbed, for the reason
 * their own doc comments give: `onOpenInvitation` would be a navigation with
 * no router behind it here, and `onSignOut` has no session to end. Each is
 * optional and each is drawn as nothing when omitted — a
 * button that cannot do what it says is the control `ClientRow`'s Revoke
 * comment refuses to draw. `AccountBlock`'s own sign-out is not optional, so
 * it is the one inert press on this screen (`onSelect={() => {}}` above is
 * the same bargain); no case presses it.
 */
export function E2EFixtureScreen({
  returned = null,
}: {
  /** What a return from Stripe said, read by the route and handed down. */
  returned?: CheckoutOutcome | null;
} = {}) {
  const data = useE2EFixtureConsoleData();
  const current = selectedContext(data);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsSectionKey | null>(null);
  /*
    The density, decided the way the product decides it — `densityFor`, not a
    width literal.

    It used to ask `regionsFor` which *rail* this width got, because the answer
    the screen needed was `full` at wide and `icons` at medium. There is no
    rail at any density now, so the only question left is the one `densityFor`
    answers: a phone puts its navigation in `NavBand` inside the scroller, and
    a pointer layout puts it in the switcher at the top.
  */
  const phone = densityFor(useWindowDimensions().width) === "compact";

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
  const openSettings = (section?: SettingsSectionKey) =>
    setSettings(
      // A named section wins, exactly as the real route's `setParams` lets it:
      // Browse's "Connect a bucket" asks for `storage`, and a fixture that
      // dropped the argument would hide the one thing that button does.
      section ??
        (current === null ? DEFAULT_ACCOUNT_SETTINGS_SECTION : DEFAULT_SETTINGS_SECTION),
    );

  return (
    <View style={{ flex: 1 }}>
      {/*
        The switcher above the pane on a pointer layout, and the navigation
        band inside the scroller on a phone — `densityFor`'s answer, drawn.

        **One of the two, never both**, which is the half of this that used to
        be wrong rather than merely missing. This screen drew `AccountBlock`'s
        `compact` form "at every width", because neither of the containers the
        real console puts the block in existed here: no phone top bar, no rail.

        The rail is gone from the product, so the pointer half is the real
        `SwitcherMenu` in a strip standing in for `AppFrame`'s title bar, and
        the corner below draws the compact account block only where the product
        does — a phone. Two of the one always-visible settings control on one
        screen would be the duplication this file's header refuses.

        What that costs is one press: `compact` merged its gear into the
        avatar's disclosure menu (see `AccountBlock`: "the corner used to be
        two controls, and one of them signed you out on one press"), so a phone
        reaches Settings through "Settings…" in that menu and a pointer layout
        reaches it through `switcher-settings` in the switcher's. That is the
        product's own shape, and `settings.spec.ts` presses whichever the
        viewport it runs at actually has.
      */}
      <View style={styles.frame}>
        {phone ? null : (
          <View style={styles.titleBar}>
            <SwitcherMenu
              data={data}
              label={current === null ? "Your context" : atName(current.slug)}
              kind={current?.kind ?? ""}
              tone={current?.status ?? "warn"}
              /*
                Only a context row can go anywhere from here. The menu's other
                entries are optional props this screen does not pass —
                Meetings, Claim, New workspace are all navigations out of the
                console, and there is no router behind this fixture to take
                them. It is the same substitution the rest of this file makes:
                keep what the navigation *does* to this browser's state.
              */
              onOpenContext={(slug) => {
                setAnchor(null);
                openContext(slug);
              }}
              onOpenSettings={openSettings}
            />
          </View>
        )}
        <View style={styles.main}>
          {/*
            The phone's account corner, and **only** the phone's: at a pointer
            density Settings and sign-out are in the switcher above, and
            drawing the block here as well would put two of the one
            always-visible settings control on one screen.
          */}
          {phone ? (
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
          ) : null}
          <NavBandProvider
            /*
              Both rows are the phone's, exactly as in `console/_layout`, which
              builds each of them behind the same `phone` condition. At a
              pointer density `BrowsePane` draws no band at all and the rail is
              the switcher; passing the nodes anyway would leave a second one
              built and one `NavBand` away from being on the screen beside it.
            */
            nodes={{
              current:
                phone && current !== null ? (
                  <CurrentContextPill
                    context={current}
                    onOpenRoot={() => {
                      setAnchor(null);
                      data.files.deselect();
                    }}
                    onSelect={() => {}}
                  />
                ) : null,
              contexts: phone ? (
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
              ) : null,
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
        </View>
      </View>

      {settings === null ? null : (
        <SettingsOverlay
          data={data}
          section={settings}
          /*
            The one thing this screen takes from a URL, and it takes it as a
            prop: `?checkout=done` is how somebody comes back from Stripe, and
            the state it produces — paid, webhook not yet applied — is on no
            browser-reachable screen otherwise. `settings.spec.ts` drives it.
          */
          returned={returned}
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
  /** The title bar above the pane, which is the whole of what `AppFrame` does here. */
  frame: { flex: 1, flexDirection: "column", minHeight: 0 },
  /**
   * Where `AppFrame` draws its top bar, at the height it draws it.
   *
   * The switcher and nothing else. `AppFrame` also gives that bar a surface
   * fill and the trailing slots, which are themed and are that component's to
   * own — `appFrameRender.test.ts` pins them there. What a fixture needs is
   * the control on the glass in the band the product puts it in, so that is
   * what is here; the switcher draws its own interior either way.
   */
  titleBar: {
    height: layout.topBarHeight,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.x3,
  },
  /** `minWidth: 0`, so a long note cannot push the pane off the screen. */
  main: { flex: 1, minWidth: 0 },
});

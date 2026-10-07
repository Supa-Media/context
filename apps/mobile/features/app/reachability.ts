import { DELIBERATELY_UNREACHABLE } from "./unreachableRoutes";

/**
 * Every route in the app, and what navigates to it.
 *
 * ## Why this file exists
 *
 * Twice now this product has shipped a complete, tested, working feature that
 * nothing in the app could reach. The first time, meeting capture had a list, a
 * live screen and a working recorder, and no `href`, no `router.push` and no
 * button anywhere outside `features/meetings/` — every unit test of it passed
 * (`docs/decisions/meetings.md`, *the way in is on the surface each density
 * has*). The second time, the fix for that was a rail row, the phone then lost
 * its rail (`frame.ts`; every density has since), and `/meetings` went back to being unreachable on the
 * one density that records meetings — while a real person's recording sat
 * intact on their phone with no list they could open to find it.
 *
 * Both are the same defect and neither is visible to a test of the screen. A
 * screen's own tests are about what it draws once you are on it; nothing in
 * them asks how you got there. So the guard has to be about the *set* of
 * routes rather than about any one of them, which is what this registry is:
 * `__tests__/routeReachability.test.ts` enumerates the route files from the
 * filesystem and requires each one to be listed here, either with the surfaces
 * that navigate to it — at every density — or with a stated reason it is
 * deliberately not reachable.
 *
 * **A new route cannot be added without a decision.** Adding a file under
 * `app/` and wiring nothing fails the guard; so does deleting the only entry
 * point to an existing route, which is precisely what PR #242 did.
 *
 * ## The walk is `app/`, and it used to be `app/(app)/`
 *
 * This file's own first line said "every route inside the app" over an
 * enumerator that saw eight of seventeen route files. `/login`, `/invite`,
 * `/s/<token>`, `/note/…`, `/authorize`, `/connect/dropbox`, `+not-found` and
 * the root itself were outside the walk, so the completeness claim — the one
 * thing this guard has that the mounted tests do not — was false about more
 * than half of the app. It is the whole tree now, minus Expo Router's own
 * `_`-prefixed exclusions.
 *
 * ## An entry point names BOTH ends of the press, because one end is not a way in
 *
 * Every claim used to name one file. That is enough for a claim to rot when the
 * file changes and not enough for it to rot when the *other* file does, and the
 * two halves of a way in live apart all over this app: `DestinationSheet` draws
 * the button a person presses and `useMeetingFlow` turns that press into
 * `/meetings`; `ContextStrip` draws the pill and `console/_layout` calls
 * `router.replace`. Deleting either one breaks the route and only one of them
 * was named — so deleting `DestinationSheet`'s button left the suite green over
 * a phone that could not reach its meetings. **That is the same caller/callee
 * boundary PR #242 broke.** So `evidence` is a list of files, all of which have
 * to still contain their strings, and the guard additionally requires the union
 * to contain something pressable and something that navigates.
 *
 * ## A claim names the region it is drawn in, and the region decides the densities
 *
 * `region` is what closes PR #242's class rather than remembering it. The old
 * rule was "no compact claim rests on the rail", implemented against a
 * hardcoded one-element file list that matched exactly one entry — which was
 * already `POINTER`, so the rule had no input that could fail it, and the three
 * routes that really rested on the rail claimed it from a file the list did not
 * name. Now every entry point declares where it is drawn, and `frame.ts`
 * decides which densities that is true at: `topBarLeadFor` answers `switcher`
 * at a pointer density and `account` at compact, and a claim that disagrees fails
 * whichever way somebody edits it.
 *
 * **The `rail` region became `switcher` when the rail folded into the menu
 * under the workspace's name**, and the rule it rests on moved with it rather
 * than being dropped: it used to read `Regions.rail`, which no longer exists,
 * and a guard whose input has gone is a guard that agrees with everything.
 *
 * ## What "reachable" means here, and what it does not
 *
 * It means: at this density, there is a control on a surface a person is
 * looking at whose press ends in this route. It does **not** mean a URL can be
 * typed, a deep link can be followed, or the route can be reached by going
 * back — all three are true of a route nobody can find, which is the state
 * being ruled out.
 *
 * A gesture with nothing on the screen to perform it on does not count either.
 * That is the same rule `app-and-console.md` applies to the phone's old empty
 * state, which named a long press over a screen with nothing to press.
 *
 * ## What the guard can prove, and what it cannot
 *
 * It reads. Each claim names a file and the strings that have to be in it, so
 * a claim cannot go stale silently: delete the navigation and the evidence
 * stops matching. What it cannot do is lay a screen out — jsdom hit-tests
 * nothing — so "the control is on screen at that width" is asserted by the
 * mounted tests each surface already has (`consoleChrome.test.ts` for the phone
 * console, `meetingsEntry.test.ts` and `meetingsFlow.test.ts` for the meetings
 * entries, `railGroup.test.ts` for the rail) rather than restated here.
 *
 * This is the same shape as `frame.ts`'s "what is deliberately kept although no
 * density reaches it": a list whose worth is that it is read, kept honest by
 * something that fails when it drifts.
 */

/** The three widths `frame.ts` decides between. A claim names the ones it holds at. */
export const DENSITIES = ["compact", "medium", "wide"] as const;

export type ReachabilityDensity = (typeof DENSITIES)[number];

/**
 * Where a control is drawn, which is what decides the densities it exists at.
 *
 * Not a label: the guard reads each of these off `frame.ts` and refuses a claim
 * made at a density that region is not drawn at. `bottomBar` is a `Regions`
 * key and is read directly; `switcher` and `account` are the two arms of
 * `topBarLeadFor` — the same list of destinations drawn twice, once per
 * layout. (`contextStrip` was a third, the phone's workspace strip; it went
 * into the account sheet on 2026-09-27 and its region went with it.)
 *
 * `screen` is a control the route's own surface draws — a screen, a sheet, a
 * menu, the recording bar. Those are drawn wherever the route is, so the region
 * constrains nothing and the density claim rests on the evidence alone.
 */
export type ReachabilityRegion =
  "switcher" | "bottomBar" | "account" | "screen";

/** One file that must still contain the wiring, and the strings that prove it. */
export interface Evidence {
  /** The file, relative to `apps/mobile`. */
  file: string;
  /**
   * Strings that must appear in that file.
   *
   * The point of naming them is that a claim rots loudly. A route constant, a
   * `testID`, a handler — this is evidence that the wiring is still there, not
   * a proof that it works, which is what the mounted tests beside each surface
   * are for.
   */
  contains: readonly string[];
}

/** One surface that navigates to a route, and where to read the proof. */
export interface RouteEntryPoint {
  /** What a person presses, in the words they would use. */
  surface: string;
  /**
   * The file that draws the pixels a person presses.
   *
   * **A route or a layout is never a control**, and the guard refuses one: a
   * file under `app/` wires screens together and draws none of them, so a claim
   * whose control is a layout is a claim about plumbing — and plumbing is
   * exactly what survived PR #242. The control lives in `features/`, and it is
   * what `region` is a fact about.
   *
   * Absent only when `automatic` says why there is no control at all.
   */
  control?: Evidence;
  /**
   * The files that turn that press into this route — a `router.push`, a
   * `<Redirect>`, the constant naming the href. Usually not the control's file.
   *
   * Named separately because a way in is both halves and neither survives the
   * other: `DestinationSheet.tsx` draws the button and `useMeetingFlow.ts`
   * navigates, and for as long as only the second was named, deleting the first
   * left the suite green over a phone that could not reach its meetings.
   */
  navigation: readonly Evidence[];
  /**
   * Where the control is drawn. Decides which densities may be claimed.
   *
   * A fact about `control.file`, and checked as one where it can be: a control
   * `SwitcherMenu` draws is the switcher, whatever this says.
   */
  region: ReachabilityRegion;
  /** The densities this surface is drawn at. */
  densities: readonly ReachabilityDensity[];
  /**
   * There is no control: the app arrives here on its own.
   *
   * A gate, a redirect, the resolution of the root. States why, and is the only
   * thing that exempts an entry point from having something pressable in its
   * evidence — an absent control is reported here rather than faked with a
   * nearby button that does something else.
   */
  automatic?: string;
}

export type RouteReachability =
  | {
      route: string;
      file: string;
      reachable: true;
      from: readonly RouteEntryPoint[];
    }
  /**
   * Deliberately not reachable from the UI.
   *
   * `reason` is the whole of the exemption, and the route's own file has to say
   * the same thing — the guard checks for `marker` in it, so somebody reading
   * the route finds the decision rather than having to find this list.
   */
  | {
      route: string;
      file: string;
      reachable: false;
      reason: string;
      marker: string;
    };

const EVERY_DENSITY = DENSITIES;
const POINTER = ["medium", "wide"] as const;
const PHONE = ["compact"] as const;

/** The console route's frame, which is the body `console/_layout.tsx` renders. */
const CONSOLE_LAYOUT = "features/console/ConsoleFrame.tsx";
/**
 * The layout's pieces, which it keeps under `features/console/layout/` because
 * every file under `app/` is a route. The context pill is built in
 * `navBand.tsx` and the palette in `palette.tsx` — so a claim about one of
 * those presses names that file. The phone's account sheet is `SwitcherMenu`,
 * wired in the frame itself.
 */
const CONSOLE_NAV_BAND = "features/console/layout/navBand.tsx";
const CONSOLE_PALETTE = "features/console/layout/palette.tsx";
/** The app gate, which applies every redirect decision `redirect.ts` returns. */
const APP_LAYOUT = "app/(app)/_layout.tsx";

/**
 * The account sheet on a phone, and the switcher in the title bar on a
 * pointer layout, are the same list of destinations drawn twice — so
 * most of what follows names both and neither claims all three densities on
 * its own.
 */
export const ROUTE_REACHABILITY: readonly RouteReachability[] = [
  {
    route: "/",
    file: "app/(home)/index.tsx",
    reachable: true,
    from: [
      {
        surface: "Context.lc home, on the sign-in screen",
        control: {
          file: "features/auth/LoginScreen.tsx",
          contains: ['accessibilityLabel="Context.lc home"'],
        },
        navigation: [
          {
            file: "features/auth/LoginScreen.tsx",
            contains: ["router.replace(LANDING_ROUTE)"],
          },
        ],
        region: "screen",
        densities: EVERY_DENSITY,
      },
      {
        surface:
          "the way out of a consent screen somebody does not want to complete",
        control: {
          file: "features/consent/ConsentScreen.tsx",
          contains: ["onPress={onLeaveForHome}"],
        },
        navigation: [
          {
            file: "features/consent/ConsentScreen.tsx",
            contains: ["router.replace(LANDING_ROUTE)"],
          },
        ],
        region: "screen",
        densities: EVERY_DENSITY,
      },
    ],
  },
  {
    route: "/+not-found",
    file: "app/+not-found.tsx",
    reachable: false,
    reason:
      "Expo Router's unmatched-URL sink. Declaring it is what stops the built-in " +
      "development Unmatched Route screen being served to somebody following a " +
      "link; nothing navigates to it, by construction — it is where a URL that " +
      "matched no route lands, and it forwards a recoverable note link on rather " +
      "than being a destination of its own.",
    marker: "Every URL that matched nothing",
  },
  {
    route: "/privacy",
    file: "app/privacy.tsx",
    reachable: true,
    from: [
      {
        surface: "the Privacy note in the homepage's Legal folder, which links to this page",
        /*
          The link is Markdown in the note (`legalMarkdown`), drawn and pressed
          by the note renderer, and routed out of the shell because the path is
          one of `APP_ROUTES`.
        */
        control: {
          file: "features/share/NoteBody.tsx",
          contains: ["siteLink?.(run.href)", "onPress"],
        },
        navigation: [
          {
            file: "features/home/homeSite.ts",
            contains: ["legalMarkdown(privacyContent, \"/privacy\")", "[its own page](${standalone})", '"/privacy"', "APP_ROUTES"],
          },
          {
            file: "features/home/HomeShell.tsx",
            contains: ['link.kind === "app"', "router.push(link.href"],
          },
        ],
        region: "screen",
        densities: EVERY_DENSITY,
      },
    ],
  },
  {
    route: "/terms",
    file: "app/terms.tsx",
    reachable: true,
    from: [
      {
        surface: "the Terms note in the homepage's Legal folder, which links to this page",
        /*
          The link is Markdown in the note (`legalMarkdown`), drawn and pressed
          by the note renderer, and routed out of the shell because the path is
          one of `APP_ROUTES`.
        */
        control: {
          file: "features/share/NoteBody.tsx",
          contains: ["siteLink?.(run.href)", "onPress"],
        },
        navigation: [
          {
            file: "features/home/homeSite.ts",
            contains: ["legalMarkdown(termsContent, \"/terms\")", "[its own page](${standalone})", '"/terms"', "APP_ROUTES"],
          },
          {
            file: "features/home/HomeShell.tsx",
            contains: ['link.kind === "app"', "router.push(link.href"],
          },
        ],
        region: "screen",
        densities: EVERY_DENSITY,
      },
    ],
  },
  ...DELIBERATELY_UNREACHABLE,
  {
    route: "/console",
    file: "app/(app)/console/index.tsx",
    reachable: true,
    from: [
      {
        surface:
          "the app's own root, which resolves to the console on every device",
        navigation: [
          {
            file: "features/auth/redirect.ts",
            contains: ["resolveRootRoute", "CONSOLE_ROUTE"],
          },
          {
            file: "features/home/RootScreen.tsx",
            contains: ["resolveRootRoute", "Redirect href={decision.href}"],
          },
        ],
        region: "screen",
        densities: EVERY_DENSITY,
        automatic:
          "Nobody presses anything: this is where the app opens, and the root " +
          "route resolves it. The controls that lead to the console are the " +
          "ones below; this is the way in that exists before there is a screen " +
          "to put a control on.",
      },
      {
        surface: "the meetings list's Back, when there is nothing behind it",
        control: {
          file: "features/meetings/MeetingsListScreen.tsx",
          contains: ['testID="meetings-back"'],
        },
        navigation: [
          {
            file: "features/meetings/MeetingsListScreen.tsx",
            contains: ["router.replace(CONSOLE_ROOT)"],
          },
        ],
        region: "screen",
        densities: EVERY_DENSITY,
      },
    ],
  },
  {
    route: "/console/[slug]",
    file: "app/(app)/console/[slug]/index.tsx",
    reachable: true,
    from: [
      /*
        The live map is not a route of its own: it is `?map=1` on this page, a
        page in the document slot over Browse, the way What changed is
        `?changes=1`. So its two ways in are claims about this route, and its
        navigation is `router.setParams` on the route it is already on.
      */
      {
        surface: "the live map, from the Map button in the sidebar's top row",
        control: {
          file: "features/console/files/explorer/ExplorerToolbar.tsx",
          contains: ['testID="explorer-map"', "onPress={mapRoute.toggle}"],
        },
        navigation: [
          {
            file: "features/console/map/live/route.ts",
            contains: ['router.setParams({ map: "1", changes: undefined, settings: undefined })'],
          },
        ],
        region: "screen",
        densities: POINTER,
      },
      {
        surface: "the live map, from its place on the phone's Home",
        control: {
          file: "features/console/home/PhoneHome.tsx",
          contains: ['testID="phone-home-map"', "onPress={onPress}"],
        },
        navigation: [
          {
            file: "features/console/map/live/route.ts",
            contains: ['router.setParams({ map: "1", changes: undefined, settings: undefined })'],
          },
        ],
        region: "screen",
        densities: PHONE,
      },
      {
        /*
          It was a pill on the phone's workspace strip. The strip went into
          the account sheet (owner, 2026-09-27, the phone artboards, screen
          9): the top-left slot opens the switcher's own rows as a bottom
          sheet, so a phone's claim is the same control as a pointer's, in
          the region a phone draws it in.
        */
        surface: "a workspace in the account sheet",
        control: {
          file: "features/console/SwitcherMenu.tsx",
          contains: [
            "testID: `switcher-context-${context.slug}`",
            "onOpenContext(id.slice(4))",
            'trigger === "phone"',
          ],
        },
        navigation: [
          {
            file: CONSOLE_LAYOUT,
            /*
              One needle, and it is the whole expression rather than its
              halves: the layout holds several `router.replace(` calls, so a
              split needle matches whatever the handler became. The phone arm
              resumes where you were (`contextHrefFrom`); the pointer arm opens
              the context's root.
            */
            contains: [
              "router.replace(phone ? contextHrefFrom(slug) : hrefFor(next))",
            ],
          },
        ],
        region: "account",
        densities: PHONE,
      },
      {
        surface: "a workspace in the switcher's menu",
        control: {
          file: "features/console/SwitcherMenu.tsx",
          contains: [
            "testID: `switcher-context-${context.slug}`",
            "onOpenContext(id.slice(4))",
          ],
        },
        navigation: [
          {
            file: CONSOLE_LAYOUT,
            contains: [
              "router.replace(phone ? contextHrefFrom(slug) : hrefFor(next))",
            ],
          },
        ],
        region: "switcher",
        densities: POINTER,
      },
    ],
  },
  {
    route: "/console/[slug]/settings",
    file: "app/(app)/console/[slug]/settings.tsx",
    reachable: true,
    from: [
      {
        /*
          **A long press, and no longer also a right-click.**

          `ContextRowMenu` is drawn by `ContextStrip`, and the strip is the
          phone's. It used to be drawn by the rail's rows as well, which is
          where the right-click was; the rail folded into `SwitcherMenu` and a
          menu row has no second menu behind it. So this claim narrowed to the
          density it is actually true at, and the entry below carries the
          pointer half.
        */
        surface: "Settings… on a context's own menu, opened by a long press",
        control: {
          file: "features/console/ContextRowMenu.tsx",
          contains: ["onPress={() => onSelect(item.route!)}"],
        },
        navigation: [
          {
            file: "features/console/contextMenu.ts",
            contains: ['key: "settings"', 'view: "settings"'],
          },
          {
            file: CONSOLE_NAV_BAND,
            contains: ["router.replace(hrefFor(next))"],
          },
        ],
        region: "screen",
        densities: PHONE,
      },
      {
        surface: "Settings…, under the rule at the foot of the switcher's menu",
        control: {
          file: "features/console/SwitcherMenu.tsx",
          contains: ['testID: "switcher-settings"', "onOpenSettings?.()"],
        },
        navigation: [
          {
            file: CONSOLE_LAYOUT,
            contains: ["DEFAULT_SETTINGS_SECTION", "router.setParams"],
          },
        ],
        region: "switcher",
        densities: POINTER,
      },
    ],
  },
  {
    route: "/console/connections",
    file: "app/(app)/console/connections.tsx",
    reachable: false,
    reason:
      "No door, by decision, and the same decision as the map's below. Its only " +
      'one was "Manage sharing…" on a context\'s right-click menu — a row that ' +
      "answered a per-context question by navigating out of the context, which " +
      "is what the owner asked be taken off the menu. Everything on the pane has " +
      "a home inside settings already, from the same components rather than a " +
      "copy: `MembersSection` under Settings → People, and the endpoint with the " +
      "connected AI apps under Settings → AI apps (`settings/AccountSections.tsx`). " +
      "So this is a duplicate surface losing its last entry, not a capability " +
      "leaving the product. The route and the pane are untouched and still " +
      "render: one entry point brings it back.",
    marker: "Reachable from nowhere, deliberately",
  },
  {
    route: "/console/search",
    file: "app/(app)/console/search.tsx",
    reachable: true,
    from: [
      {
        /*
          The handoff out of the palette, and the reason the page exists in the
          shape it does. The overlay is on every density — ⌘K on a pointer, the
          bottom toolbar's search key on a phone — so this claim is too, and it
          is the entry point somebody actually uses: they search, see ten rows,
          and want the rest.

          `See all results` is a row in the palette's own list rather than a
          button in its chrome, which is what makes it reachable by the keyboard
          as well as by a thumb. `Palette.tsx` is named as the control because
          that is where the row is built; the layout is named as the navigation
          because that is where the press becomes a URL.
        */
        surface:
          "“See all results”, the last row of the console's search palette",
        control: {
          file: "features/design/components/Palette.tsx",
          contains: ["seeAllItem", "onSeeAll?.(query)"],
        },
        navigation: [
          {
            file: CONSOLE_PALETTE,
            contains: ["router.push(searchHref(query))"],
          },
        ],
        region: "screen",
        densities: EVERY_DENSITY,
      },
    ],
  },
  {
    route: "/console/map",
    file: "app/(app)/console/map.tsx",
    reachable: false,
    reason:
      'No door, by decision. Its only one was the "Elsewhere in the console" ' +
      "card at the foot of settings — three destinations repeated under all " +
      "nineteen sections, drawn unconditionally *because* removing it from any " +
      "one section removed the map from the product. That is a fire escape on " +
      "every floor rather than a place in the navigation, and the owner's answer " +
      "when it was put to them was that the map can vanish. It had already lost " +
      "its rail row (`SwitcherMenu.tsx` carries the reason: Map and Connections " +
      "are facts " +
      "about a context rather than places inside one) and a phone has no left " +
      "panel at all, so there was nowhere left that it belonged. The route and " +
      "the pane are untouched and still render: this is a navigation decision, " +
      "not a deletion, and giving the map a home again is a door away.",
    marker: "Reachable from nowhere, deliberately",
  },
  {
    route: "/invite",
    file: "app/invite/index.tsx",
    reachable: true,
    from: [
      {
        surface:
          "the onboarding gate, for an account whose only context is an invitation",
        navigation: [
          {
            file: "features/onboarding/route.ts",
            contains: ['{ action: "redirect", href: INVITE_ROUTE }'],
          },
          { file: APP_LAYOUT, contains: ["Redirect href={onboarding.href}"] },
        ],
        region: "screen",
        densities: EVERY_DENSITY,
        automatic:
          "Nobody presses anything. Somebody with no context of their own and an " +
          "invitation waiting is sent here by `needsOnboarding` before any " +
          "surface with a control on it has been drawn — there is no console to " +
          "put a row in yet, which is the situation this route is for.",
      },
    ],
  },
  {
    route: "/invite/[token]",
    file: "app/invite/[token].tsx",
    reachable: false,
    reason:
      "The link somebody was emailed. The token exists in one email and nowhere " +
      "else, so no surface in the app can reproduce one — a row leading here " +
      "would have nothing to put in the URL. The list of invitations this " +
      "account holds is `/invite`, which is reachable and accepts them in place.",
    marker: "the link somebody was emailed",
  },
  {
    route: "/login",
    file: "app/(auth)/login.tsx",
    reachable: true,
    from: [
      {
        surface:
          "the app gate, which sends every signed-out request here and brings it back",
        navigation: [
          {
            file: "features/auth/redirect.ts",
            contains: ["resolveProtectedRoute", "loginHref"],
          },
          { file: APP_LAYOUT, contains: ["Redirect href={decision.href}"] },
        ],
        region: "screen",
        densities: EVERY_DENSITY,
        automatic:
          "Nobody presses anything, and deliberately: a signed-out person is " +
          "looking at a screen the gate refused to render, so the way in is the " +
          "refusal itself. `loginHref` carries where they were going, which is " +
          "what makes this a detour rather than a dead end.",
      },
    ],
  },
  {
    route: "/meetings",
    file: "app/(app)/meetings/index.tsx",
    reachable: true,
    from: [
      {
        /*
          The phone's only route to the list, and the reason this whole file
          exists.

          **It moved, and what moved it is worth recording.** It used to be a
          "Past meetings" row on the destination sheet the bottom row's meetings
          key raised — the sheet that asked where to record. That sheet is gone
          (`useMeetingFlow`: the key records now), and a route that hangs off a
          deleted surface is exactly the silent loss this file exists to catch.
          So the row is on the account menu, which is the one menu a phone
          always has, beside the only sign-out it has.
        */
        surface: "Meetings, in the account sheet",
        control: {
          file: "features/console/SwitcherMenu.tsx",
          contains: [
            'testID: "switcher-meetings"',
            "onOpenMeetings?.()",
            'trigger === "phone"',
          ],
        },
        navigation: [
          {
            file: CONSOLE_LAYOUT,
            contains: ["MEETINGS_ROUTE", "router.push(MEETINGS_ROUTE)"],
          },
        ],
        region: "account",
        densities: PHONE,
      },
      {
        surface: "Meetings, at the head of the switcher's menu",
        control: {
          file: "features/console/SwitcherMenu.tsx",
          contains: ['testID: "switcher-meetings"', "onOpenMeetings?.()"],
        },
        navigation: [
          {
            file: CONSOLE_LAYOUT,
            contains: ["MEETINGS_ROUTE", "router.push(MEETINGS_ROUTE)"],
          },
        ],
        region: "switcher",
        densities: POINTER,
      },
    ],
  },
  {
    route: "/meetings/[id]",
    file: "app/(app)/meetings/[id].tsx",
    reachable: true,
    from: [
      {
        surface: "the recording bar, which is mounted above every route",
        control: {
          file: "features/meetings/components/RecordingBar.tsx",
          contains: ['testID="recording-bar-open"', "onPress={open}"],
        },
        navigation: [
          {
            file: "features/meetings/components/RecordingBar.tsx",
            contains: ["router.push(meetingHref(live.session.id))"],
          },
        ],
        region: "screen",
        densities: EVERY_DENSITY,
      },
      {
        surface: "a row on the meetings list",
        control: {
          file: "features/meetings/components/MeetingRow.tsx",
          contains: ["onPress"],
        },
        navigation: [
          {
            file: "features/meetings/MeetingsListScreen.tsx",
            contains: ["onOpen={(id) => router.push(meetingHref(id))}"],
          },
        ],
        region: "screen",
        densities: EVERY_DENSITY,
      },
    ],
  },
  {
    route: "/note/[...address]",
    file: "app/note/[...address].tsx",
    reachable: false,
    reason:
      "The link grammar anything outside the app can produce — a URL an AI " +
      "client wrote into a chat. It redirects to the canonical console address " +
      "rather than rendering a note, so a control leading here would be a " +
      "control leading to a redirect to where the person already was.",
    marker: "the link format anything outside the app can produce",
  },
  {
    route: "/s/[token]",
    file: "app/s/[token].tsx",
    reachable: false,
    reason:
      "The link an owner minted and pasted into a chat. The token is the whole " +
      "of the access, it exists wherever they pasted it, and the console's own " +
      "share dialog copies the URL rather than opening it — a reader arrives " +
      "from outside, which is the entire point of a share.",
    marker: "the link an owner pasted into a chat",
  },
  {
    route: "/texts/[token]",
    file: "app/texts/[token].tsx",
    reachable: false,
    reason:
      "The link the texting assistant sends a phone nobody has linked. The " +
      "token exists in that one text message and nowhere in the app, and the " +
      "page only means something to the person holding that phone.",
    marker: "the link the texting assistant sends a phone nobody has",
  },
  {
    route: "/[handle]",
    file: "app/[handle]/index.tsx",
    reachable: false,
    reason:
      "A public website homepage, `/@seyi`, reached from an address its owner " +
      "publishes outside the console. The console's website panel manages the " +
      "source files rather than opening the public surface, so an in-app route " +
      "to the rendered page would duplicate that external-address contract.",
    marker: "The public website homepage somebody opens from outside the app",
  },
  {
    route: "/[handle]/[...path]",
    file: "app/[handle]/[...path].tsx",
    reachable: false,
    reason:
      "A public website path or the compatibility short link `/@seyi/intake`. " +
      "Both are addresses an owner publishes outside the console; linking to " +
      "one from app chrome would also require listing which public paths or " +
      "legacy names exist, which the public reader deliberately never does.",
    marker:
      "public website path or compatibility short link somebody was handed",
  },
  {
    route: "/welcome",
    file: "app/(app)/welcome.tsx",
    reachable: true,
    from: [
      {
        /*
          It was a pill on the phone's workspace strip. The strip went into
          the account sheet (owner, 2026-09-27, the phone artboards, screen
          9): the top-left slot opens the switcher's own rows as a bottom
          sheet, so a phone's claim is the same control as a pointer's, in
          the region a phone draws it in.
        */
        surface: "Claim your @name, in the account sheet",
        control: {
          file: "features/console/SwitcherMenu.tsx",
          contains: [
            'testID: "switcher-claim"',
            "onClaimContext?.()",
            'trigger === "phone"',
          ],
        },
        navigation: [
          {
            file: CONSOLE_LAYOUT,
            contains: ["WELCOME_ROUTE", "router.push(WELCOME_ROUTE)"],
          },
        ],
        region: "account",
        densities: PHONE,
      },
      {
        surface:
          "Claim your @name, after the workspaces in the switcher's menu",
        control: {
          file: "features/console/SwitcherMenu.tsx",
          contains: ['testID: "switcher-claim"', "onClaimContext?.()"],
        },
        navigation: [
          {
            file: CONSOLE_LAYOUT,
            contains: ["WELCOME_ROUTE", "router.push(WELCOME_ROUTE)"],
          },
        ],
        region: "switcher",
        densities: POINTER,
      },
      {
        surface:
          "the way out of an invitation for somebody with no workspace of their own",
        control: {
          file: "features/invite/InviteScreen.tsx",
          contains: ['testID="invite-welcome"'],
        },
        navigation: [
          {
            file: "features/invite/InviteScreen.tsx",
            contains: ["router.replace(WELCOME_ROUTE)"],
          },
        ],
        region: "screen",
        densities: EVERY_DENSITY,
      },
    ],
  },
  {
    route: "/workspace/new",
    file: "app/(app)/workspace/new.tsx",
    reachable: true,
    from: [
      {
        /*
          It was a pill on the phone's workspace strip. The strip went into
          the account sheet (owner, 2026-09-27, the phone artboards, screen
          9): the top-left slot opens the switcher's own rows as a bottom
          sheet, so a phone's claim is the same control as a pointer's, in
          the region a phone draws it in.
        */
        surface: "New workspace, in the account sheet",
        control: {
          file: "features/console/SwitcherMenu.tsx",
          contains: [
            'testID: "switcher-new"',
            "onNewWorkspace?.()",
            'trigger === "phone"',
          ],
        },
        navigation: [
          {
            file: CONSOLE_LAYOUT,
            contains: [
              "NEW_WORKSPACE_ROUTE",
              "router.push(NEW_WORKSPACE_ROUTE)",
            ],
          },
        ],
        region: "account",
        densities: PHONE,
      },
      {
        surface: "New workspace, after the workspaces in the switcher's menu",
        control: {
          file: "features/console/SwitcherMenu.tsx",
          contains: ['testID: "switcher-new"', "onNewWorkspace?.()"],
        },
        navigation: [
          {
            file: CONSOLE_LAYOUT,
            contains: [
              "NEW_WORKSPACE_ROUTE",
              "router.push(NEW_WORKSPACE_ROUTE)",
            ],
          },
        ],
        region: "switcher",
        densities: POINTER,
      },
    ],
  },
  {
    route: "/preview/onboarding",
    file: "app/preview/onboarding/index.tsx",
    reachable: false,
    reason:
      "The design review index for the redesigned onboarding screens. A dev " +
      "surface — nothing in the app links here — so a reviewer can look at " +
      "each new step's presentational half with mock props before the flow " +
      "state machine has been rewired. Kept in the tree rather than a " +
      "Storybook because the tokens, the theme provider and the type scale " +
      "come from this app and drift in either direction the moment they are " +
      "duplicated.",
    marker: "the design review index",
  },
  {
    route: "/preview/onboarding/[step]",
    file: "app/preview/onboarding/[step].tsx",
    reachable: false,
    reason:
      "One redesigned onboarding step, rendered with mock props. Reached " +
      "only from `/preview/onboarding`, which the reachability rule above " +
      "already marks as a dev surface not linked from the app itself.",
    marker: "one redesigned onboarding step, rendered with mock props",
  },
];

/**
 * The route a file under `app/` declares, by Expo Router's own rules.
 *
 * Group segments in parentheses do not appear in the URL, `index` is the folder
 * itself, and the extension goes. Exported so the guard and this list derive
 * the same strings from the same function rather than from two conventions.
 *
 * It accepts `.ts` and `.js` as well as their `x` forms, and the enumerator
 * beside it now does too — they disagreed, so a route written as a plain `.ts`
 * would have been silently outside the walk.
 */
export function routeFromFile(relativePath: string): string {
  const withoutExtension = relativePath.replace(/\.[jt]sx?$/, "");
  const segments = withoutExtension
    .split("/")
    .filter(
      (segment) =>
        segment !== "" && !(segment.startsWith("(") && segment.endsWith(")")),
    );
  if (segments[segments.length - 1] === "index") segments.pop();
  return `/${segments.join("/")}`;
}

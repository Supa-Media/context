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
 * its rail (`frame.ts`), and `/meetings` went back to being unreachable on the
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
 * name. Now every entry point declares where it is drawn, and
 * `regionsFor` decides which densities that is true at: the rail is hidden at
 * `compact`, the context strip is drawn exactly where the rail is not, and a
 * claim that disagrees fails whichever way somebody edits it.
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
 * entries, `railSections.test.ts` for the rail) rather than restated here.
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
 * made at a density that region is not drawn at. `rail` and `bottomBar` are
 * `Regions` keys and are read directly; `contextStrip` is derived as *the
 * densities the rail is hidden at*, which is the strip's whole reason for
 * existing — the same list of destinations drawn twice, once per layout.
 *
 * `screen` is a control the route's own surface draws — a screen, a sheet, a
 * menu, the recording bar. Those are drawn wherever the route is, so the region
 * constrains nothing and the density claim rests on the evidence alone.
 */
export type ReachabilityRegion = "rail" | "contextStrip" | "bottomBar" | "screen";

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
   * the rail draws is the rail, whatever this says.
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
  | { route: string; file: string; reachable: true; from: readonly RouteEntryPoint[] }
  /**
   * Deliberately not reachable from the UI.
   *
   * `reason` is the whole of the exemption, and the route's own file has to say
   * the same thing — the guard checks for `marker` in it, so somebody reading
   * the route finds the decision rather than having to find this list.
   */
  | { route: string; file: string; reachable: false; reason: string; marker: string };

const EVERY_DENSITY = DENSITIES;
const POINTER = ["medium", "wide"] as const;
const PHONE = ["compact"] as const;

/** The console layout, which owns every navigation the rail and the strip make. */
const CONSOLE_LAYOUT = "app/(app)/console/_layout.tsx";
/** The app gate, which applies every redirect decision `redirect.ts` returns. */
const APP_LAYOUT = "app/(app)/_layout.tsx";

/**
 * The context strip along the top of a phone, and the rail column on a pointer
 * layout, are the same list of destinations drawn twice — so most of what
 * follows names both and neither claims all three densities on its own.
 */
export const ROUTE_REACHABILITY: readonly RouteReachability[] = [
  {
    route: "/",
    file: "app/index.tsx",
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
        surface: "the way out of a consent screen somebody does not want to complete",
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
    route: "/admin",
    file: "app/(app)/admin/index.tsx",
    reachable: false,
    reason:
      "The staff console. It is platform-wide rather than about any one context, " +
      "so it is in no switcher and no strip — putting it there would imply it " +
      "belongs to whichever brain is selected — and everyone gets the same URL " +
      "while `requireAdmin` on the server decides what it renders. It is reached " +
      "by typing the address, on purpose.",
    marker: "Reached by typing the address",
  },
  {
    route: "/authorize",
    file: "app/authorize.tsx",
    reachable: false,
    reason:
      "The OAuth consent screen, arrived at from an AI client's own browser " +
      "redirect carrying a `request_id` that exists for about a minute and " +
      "nowhere else. There is nothing in the app that could reproduce one, so a " +
      "control leading here would lead to a screen with nothing to consent to.",
    marker: "the OAuth consent screen",
  },
  {
    route: "/connect/dropbox",
    file: "app/connect/dropbox.tsx",
    reachable: false,
    reason:
      "The URL Dropbox redirects back to, registered with Dropbox and matched " +
      "exactly. The app sends people out to Dropbox and Dropbox sends them here " +
      "with a code and a state that exist for about a minute; opening it from " +
      "inside the app would land on a callback with nothing to hand back.",
    marker: "the URL Dropbox redirects back to",
  },
  {
    route: "/console",
    file: "app/(app)/console/index.tsx",
    reachable: true,
    from: [
      {
        surface: "the app's own root, which resolves to the console on every device",
        navigation: [
          {
            file: "features/auth/redirect.ts",
            contains: ["resolveRootRoute", "CONSOLE_ROUTE"],
          },
          {
            file: "features/landing/RootScreen.tsx",
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
      {
        surface: "a pill on the context strip",
        control: {
          file: "features/console/ContextStrip.tsx",
          contains: ["onPress={() => onOpen(context.slug)}"],
        },
        navigation: [
          {
            file: CONSOLE_LAYOUT,
            contains: ["onOpen={(slug) => router.replace(contextHrefFrom(slug))}"],
          },
        ],
        region: "contextStrip",
        densities: PHONE,
      },
      {
        surface: "a row in the rail's context groups",
        control: {
          file: "features/console/ConsoleRail.tsx",
          contains: ["onPress={() => onNavigate(selectContextRoute(context.slug))}"],
        },
        navigation: [{ file: CONSOLE_LAYOUT, contains: ["router.replace(hrefFor(next))"] }],
        region: "rail",
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
        surface:
          "Settings… on a context's own menu — a long press on a phone, a right-click on a pointer",
        control: {
          file: "features/console/ContextRowMenu.tsx",
          contains: ["onPress={() => onSelect(item.route!)}"],
        },
        navigation: [
          {
            file: "features/console/contextMenu.ts",
            contains: ['key: "settings"', 'view: "settings"'],
          },
          { file: CONSOLE_LAYOUT, contains: ["router.replace(hrefFor(next))"] },
        ],
        region: "screen",
        densities: EVERY_DENSITY,
      },
    ],
  },
  {
    route: "/console/connections",
    file: "app/(app)/console/connections.tsx",
    reachable: true,
    from: [
      {
        surface: "the app section list at the foot of a context's settings",
        control: {
          file: "features/console/panes/SettingsPane.tsx",
          contains: ["APP_SECTIONS", "onPress={() => onOpenSection(section.key)}"],
        },
        navigation: [
          {
            file: "app/(app)/console/[slug]/settings.tsx",
            contains: ["router.push(appSectionHref(section))"],
          },
        ],
        region: "screen",
        densities: EVERY_DENSITY,
      },
      {
        surface: "Manage sharing… on a context's own menu",
        control: {
          file: "features/console/ContextRowMenu.tsx",
          contains: ["onPress={() => onSelect(item.route!)}"],
        },
        navigation: [
          { file: "features/console/contextMenu.ts", contains: ['section: "connections"'] },
          { file: CONSOLE_LAYOUT, contains: ["router.replace(hrefFor(next))"] },
        ],
        region: "screen",
        densities: EVERY_DENSITY,
      },
    ],
  },
  {
    route: "/console/map",
    file: "app/(app)/console/map.tsx",
    reachable: true,
    from: [
      {
        surface: "the app section list at the foot of a context's settings",
        control: {
          file: "features/console/panes/SettingsPane.tsx",
          contains: ["APP_SECTIONS", "onPress={() => onOpenSection(section.key)}"],
        },
        navigation: [
          {
            file: "app/(app)/console/[slug]/settings.tsx",
            contains: ["router.push(appSectionHref(section))"],
          },
        ],
        region: "screen",
        densities: EVERY_DENSITY,
      },
    ],
  },
  {
    route: "/invite",
    file: "app/invite/index.tsx",
    reachable: true,
    from: [
      {
        surface: "the onboarding gate, for an account whose only context is an invitation",
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
        surface: "the app gate, which sends every signed-out request here and brings it back",
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
          exists. See `DestinationSheet.onOpenMeetings` for why it is a row on
          that sheet rather than an eighth key or a menu over sign-out.
        */
        surface: "Past meetings, on the sheet the bottom row's meetings key opens",
        control: {
          file: "features/meetings/components/DestinationSheet.tsx",
          contains: ['label="Past meetings"', "onPress={onOpenMeetings}"],
        },
        navigation: [
          {
            file: "features/meetings/useMeetingFlow.ts",
            contains: ["MEETINGS_ROUTE", "router.push(MEETINGS_ROUTE)"],
          },
        ],
        region: "bottomBar",
        densities: PHONE,
      },
      {
        surface: "the pinned row at the head of the rail",
        control: {
          file: "features/console/ConsoleRail.tsx",
          contains: ['testID="rail-meetings"', "onPress={onOpenMeetings}"],
        },
        navigation: [
          { file: CONSOLE_LAYOUT, contains: ["MEETINGS_ROUTE", "router.push(MEETINGS_ROUTE)"] },
        ],
        region: "rail",
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
    route: "/welcome",
    file: "app/(app)/welcome.tsx",
    reachable: true,
    from: [
      {
        surface: "Claim your @name, at the end of the context strip",
        control: {
          file: "features/console/ContextStrip.tsx",
          contains: ['testID="context-strip-claim"', "onPress={onClaimContext!}"],
        },
        navigation: [
          { file: CONSOLE_LAYOUT, contains: ["WELCOME_ROUTE", "router.push(WELCOME_ROUTE)"] },
        ],
        region: "contextStrip",
        densities: PHONE,
      },
      {
        surface: "Claim your @name, at the end of the rail's Brains group",
        control: {
          file: "features/console/ConsoleRail.tsx",
          contains: ['testID="rail-claim-context"', "onPress={onClaimContext!}"],
        },
        navigation: [
          { file: CONSOLE_LAYOUT, contains: ["WELCOME_ROUTE", "router.push(WELCOME_ROUTE)"] },
        ],
        region: "rail",
        densities: POINTER,
      },
      {
        surface: "the way out of an invitation for somebody with no brain",
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
        surface: "New workspace, at the end of the context strip",
        control: {
          file: "features/console/ContextStrip.tsx",
          contains: ['testID="context-strip-create"', "onPress={onCreateWorkspace!}"],
        },
        navigation: [
          {
            file: CONSOLE_LAYOUT,
            contains: ["NEW_WORKSPACE_ROUTE", "router.push(NEW_WORKSPACE_ROUTE)"],
          },
        ],
        region: "contextStrip",
        densities: PHONE,
      },
      {
        surface: "New workspace, at the end of the rail's Workspaces group",
        control: {
          file: "features/console/ConsoleRail.tsx",
          contains: ['testID="rail-create-workspace"', "onPress={onCreateWorkspace!}"],
        },
        navigation: [
          {
            file: CONSOLE_LAYOUT,
            contains: ["NEW_WORKSPACE_ROUTE", "router.push(NEW_WORKSPACE_ROUTE)"],
          },
        ],
        region: "rail",
        densities: POINTER,
      },
    ],
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
    .filter((segment) => segment !== "" && !(segment.startsWith("(") && segment.endsWith(")")));
  if (segments[segments.length - 1] === "index") segments.pop();
  return `/${segments.join("/")}`;
}

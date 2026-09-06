/**
 * Every route inside the app, and what navigates to it.
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
 * `app/(app)/` and wiring nothing fails the guard; so does deleting the only
 * entry point to an existing route, which is precisely what PR #242 did.
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

/** One surface that navigates to a route, and where to read the proof. */
export interface RouteEntryPoint {
  /** What a person presses, in the words they would use. */
  surface: string;
  /** The file that draws it, relative to `apps/mobile`. */
  file: string;
  /**
   * Strings that must appear in that file.
   *
   * The point of naming them is that a claim rots loudly. A route constant, a
   * builder, or a callback prop is enough — this is evidence that the wiring is
   * still there, not a proof that it works, which is what the mounted tests
   * beside each surface are for.
   */
  evidence: readonly string[];
  /** The densities this surface is drawn at. */
  densities: readonly ReachabilityDensity[];
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

/**
 * The context strip along the top of a phone, and the rail column on a pointer
 * layout, are the same list of destinations drawn twice — so most of what
 * follows names both and neither claims all three densities on its own.
 */
export const ROUTE_REACHABILITY: readonly RouteReachability[] = [
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
    route: "/console",
    file: "app/(app)/console/index.tsx",
    reachable: true,
    from: [
      {
        surface: "the app's own root, which resolves to the console on every device",
        file: "features/auth/redirect.ts",
        evidence: ["resolveRootRoute", "/console"],
        densities: EVERY_DENSITY,
      },
      {
        surface: "the meetings list's Back, when there is nothing behind it",
        file: "features/meetings/MeetingsListScreen.tsx",
        evidence: ["CONSOLE_ROOT", "router.replace(CONSOLE_ROOT)"],
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
        file: "features/console/ContextStrip.tsx",
        evidence: ["onOpen"],
        densities: PHONE,
      },
      {
        surface: "a row in the rail's context groups",
        file: "features/console/ConsoleRail.tsx",
        evidence: ["onNavigate"],
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
        surface: "Settings… on a context's own menu — a long press on a phone, a right-click on a pointer",
        file: "features/console/contextMenu.ts",
        evidence: ['key: "settings"', 'view: "settings"'],
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
        file: "features/console/panes/SettingsPane.tsx",
        evidence: ["APP_SECTIONS"],
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
        file: "features/console/panes/SettingsPane.tsx",
        evidence: ["APP_SECTIONS"],
        densities: EVERY_DENSITY,
      },
      {
        surface: "Manage sharing… on a context's own menu",
        file: "features/console/contextMenu.ts",
        evidence: ['section: "connections"'],
        densities: EVERY_DENSITY,
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
        file: "features/meetings/useMeetingFlow.ts",
        evidence: ["MEETINGS_ROUTE", "onOpenMeetings"],
        densities: PHONE,
      },
      {
        surface: "the pinned row at the head of the rail",
        file: "app/(app)/console/_layout.tsx",
        evidence: ["MEETINGS_ROUTE", "onOpenMeetings"],
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
        file: "features/meetings/components/RecordingBar.tsx",
        evidence: ["meetingHref"],
        densities: EVERY_DENSITY,
      },
      {
        surface: "a row on the meetings list",
        file: "features/meetings/MeetingsListScreen.tsx",
        evidence: ["meetingHref"],
        densities: EVERY_DENSITY,
      },
    ],
  },
  {
    route: "/welcome",
    file: "app/(app)/welcome.tsx",
    reachable: true,
    from: [
      {
        surface: "Claim your @name, at the end of the context strip",
        file: "features/console/ContextStrip.tsx",
        evidence: ["onClaimContext"],
        densities: PHONE,
      },
      {
        surface: "Claim your @name, at the end of the rail's Brains group",
        file: "app/(app)/console/_layout.tsx",
        evidence: ["WELCOME_ROUTE", "onClaimContext"],
        densities: POINTER,
      },
      {
        surface: "the way out of an invitation for somebody with no brain",
        file: "features/invite/InviteScreen.tsx",
        evidence: ["WELCOME_ROUTE"],
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
        file: "features/console/ContextStrip.tsx",
        evidence: ["onCreateWorkspace"],
        densities: PHONE,
      },
      {
        surface: "New workspace, at the end of the rail's Workspaces group",
        file: "app/(app)/console/_layout.tsx",
        evidence: ["NEW_WORKSPACE_ROUTE", "onCreateWorkspace"],
        densities: POINTER,
      },
    ],
  },
];

/**
 * The route a file under `app/(app)/` declares, by Expo Router's own rules.
 *
 * Group segments in parentheses do not appear in the URL, `index` is the folder
 * itself, and the extension goes. Exported so the guard and this list derive
 * the same strings from the same function rather than from two conventions.
 */
export function routeFromFile(relativePath: string): string {
  const withoutExtension = relativePath.replace(/\.[jt]sx?$/, "");
  const segments = withoutExtension
    .split("/")
    .filter((segment) => segment !== "" && !(segment.startsWith("(") && segment.endsWith(")")));
  if (segments[segments.length - 1] === "index") segments.pop();
  return `/${segments.join("/")}`;
}

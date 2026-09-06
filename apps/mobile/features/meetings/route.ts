/**
 * Where meeting capture lives, as one string.
 *
 * Beside the feature, so a caller imports one thing — the shape
 * `features/workspace/create.ts` uses for `NEW_WORKSPACE_ROUTE` and
 * `features/onboarding/route.ts` for `WELCOME_ROUTE`.
 *
 * **Its own module, with no imports at all**, and that is the point rather than
 * tidiness. The console's rail is what navigates here, and the console must not
 * pull the meetings controller, the capture modules and their audio plumbing
 * into its own module graph to learn one path. `features/meetings/index.ts`
 * re-exports it for anyone already inside the feature.
 *
 * It is not a `ConsoleRoute`. `/meetings` sits outside `/console`, so putting it
 * in that union would mean `routeForPath` pretending it can parse a URL it never
 * sees — the same reason `onClaimContext` and `onCreateWorkspace` are callbacks
 * on `ConsoleRail` rather than routes.
 */
export const MEETINGS_ROUTE = "/meetings";

/** One meeting: `/meetings/mtg_…`. The list and the live screen share a route. */
export function meetingHref(id: string): string {
  return `${MEETINGS_ROUTE}/${id}`;
}

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

/**
 * Where `/meetings` goes on a layout with a right panel: the console, with the
 * panel open on Meetings.
 *
 * The list is a phone's page, because a phone has no panel. Anywhere else it
 * was a second, full-window copy of the panel's Meetings tab, with its own
 * record button and no chrome around it — on the Mac app, a window with no way
 * out but quitting (owner, 2026-10-21: *"the whole 'separate' meetings page
 * needs to go … people can already see meetings in this sidebar"*). So the
 * route still resolves, for an old link or a typed address, but on a pointer
 * layout it resolves to the panel. `?meetings=1` rides beside `?map=1` and
 * `?trash=1`, and the console removes it once it has opened the panel.
 */
export const MEETINGS_PANEL_HREF = "/console?meetings=1";

/**
 * The same, starting a meeting as it opens: where the home-screen widget's
 * `?quickAction=meeting` goes on an iPad, so its Record still records.
 */
export const MEETINGS_RECORD_HREF = "/console?meetings=record";

/** What `?meetings=` asks of the console: the panel, the panel and a recording, or nothing. */
export type MeetingsPanelAsk = "open" | "record" | null;

/** `?meetings=`, read the way `mapFromQuery` reads `?map=1`. Anything we did not write is nothing. */
export function meetingsPanelFromQuery(value: string | string[] | undefined): MeetingsPanelAsk {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === "1") return "open";
  if (raw === "record") return "record";
  return null;
}

/**
 * What the console does with a `?meetings=` ask, decided once and pure.
 *
 *  - `wait`: a recording was asked for and the controller is not ready yet — a
 *    cold start from the widget asks before it is configured, as the list's did;
 *  - `clear`: no panel here (a phone), so only the parameter comes off;
 *  - `record`: start a meeting, which opens the panel on it;
 *  - `open`: open the panel on Meetings — also what a Record becomes when a
 *    meeting is already running, or where nothing can record.
 */
export function meetingsAskAction({
  ask,
  hasAside,
  canRecord,
  ready,
  live,
}: {
  ask: Exclude<MeetingsPanelAsk, null>;
  hasAside: boolean;
  canRecord: boolean;
  ready: boolean;
  live: boolean;
}): "wait" | "clear" | "record" | "open" {
  if (!hasAside) return "clear";
  if (ask !== "record" || !canRecord) return "open";
  if (!ready) return "wait";
  return live ? "open" : "record";
}

/** One meeting: `/meetings/mtg_…`. The list and the live screen share a route. */
export function meetingHref(id: string): string {
  return `${MEETINGS_ROUTE}/${id}`;
}

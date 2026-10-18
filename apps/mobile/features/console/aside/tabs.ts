/**
 * The right panel's tabs, as decisions rather than as JSX.
 *
 * `features/console/capabilities.ts` states the rule this file exists for in
 * one line: every guard expressed inside a component in this app was held by
 * nothing. Which tab is showing, whether a meeting may take it, and what the
 * Meetings tab says when there is nothing to say are each decided here.
 *
 * ## What the panel holds
 *
 * What happens *beside* a note rather than in it: a recording of what is being
 * said, and, only while there is one, what an AI client is waiting on a
 * person's yes for. Meetings used
 * to float over whatever you were reading because it had nowhere to live, and
 * giving it a home is the whole of this panel.
 */

/*
  **No Chat tab** (Dev2, 2026-10-10: "remove chat from the sidebar entirely").
  The panel used to open on a conversation with an in-app agent that ran on a
  model key the person pasted into Settings; both are gone, and asking about a
  context happens in the AI clients people connect to it.
*/
export const ASIDE_TABS = [
  { key: "meetings", label: "Meetings" },
  { key: "approvals", label: "Approvals" },
] as const;

export type AsideTab = (typeof ASIDE_TABS)[number]["key"];

export const DEFAULT_ASIDE_TAB: AsideTab = "meetings";

/**
 * The tabs a console shows, in order.
 *
 * Meetings is always there. Approvals needs this console to have an approvals
 * route to ask — `approvals` is false otherwise (the homepage, the demo) — and
 * something to ask about: an email, a calendar change, a new @handle or a
 * vault key's first use waiting for the person. With nothing waiting it is
 * absent (Dev2, 2026-10-17: the widening approvals are gone, and an empty tab
 * every day was the friction). `answered` keeps it while the person reads what
 * their last answer did, so the notice does not vanish under them.
 */
export function visibleAsideTabs({
  approvals,
  waiting,
  answered = false,
}: {
  approvals: boolean;
  waiting: number;
  answered?: boolean;
}): AsideTab[] {
  const showApprovals = approvals && (waiting > 0 || answered);
  return ASIDE_TABS.map((tab) => tab.key).filter((key) => key === "meetings" || showApprovals);
}

/**
 * Which tab is showing.
 *
 * **A meeting starting does not take the tab**, and that is the decision worth
 * writing down rather than discovering. It is tempting — a recording is the
 * most urgent thing the panel knows about — and it is wrong for one concrete
 * reason: a meeting can start while somebody is halfway through typing a
 * question, and a panel that swaps out from under a composer loses what they
 * were writing and answers a question they did not ask.
 *
 * What a running meeting gets instead is a **dot on its tab**
 * (`meetingNeedsAttention`), which is the same trade the console already makes
 * for an unread anything: say it, do not seize.
 *
 * The one thing that does move the tab is a person pressing it, which is why
 * this takes what they chose and returns it unless it names a tab this build
 * has never heard of — a stale bundle, a query string somebody typed.
 */
export function asideTabFor(requested: string | null | undefined): AsideTab {
  const known = ASIDE_TABS.find((tab) => tab.key === requested);
  return known?.key ?? DEFAULT_ASIDE_TAB;
}

/**
 * Whether the Meetings tab should be marked while you are looking elsewhere.
 *
 * True only when something is *running* and you are not on that tab. A dot on
 * the tab you are already reading is a dot that means nothing, and a dot with
 * no meeting behind it is worse: this is the mark that makes "a meeting does
 * not steal the tab" safe, so it has to be exactly right or the trade fails in
 * the direction where somebody misses a recording.
 */
export function meetingNeedsAttention(showing: AsideTab, meetingLive: boolean): boolean {
  return meetingLive && showing !== "meetings";
}

/**
 * What the Meetings tab says when nothing is recording.
 *
 * A sentence and not an empty box, because "nothing here" and "this is broken"
 * look the same to somebody who has just opened a panel for the first time.
 * It names the control that starts one rather than describing the absence.
 */
export const NO_MEETING =
  "Nothing is recording. Start a meeting and its clock, its transcript and the note it becomes all land here.";


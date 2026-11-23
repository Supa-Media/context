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
 * said, and the chat with Tex. Meetings used to float over whatever you were
 * reading because it had nowhere to live, and giving it a home is the whole of
 * this panel.
 *
 * Approvals is not a tab (the owner, 2026-11-19: "no approvals tab, just make
 * the approvals happen right inside the message box"). What an AI client is
 * waiting on a person's yes for is answered inline in the Tex chat, so there
 * is nothing here to list it.
 */

/*
  **The Tex tab is not the removed in-app agent** (the owner, 2026-11-19: Tex on
  the right rail under the calendar, as the Context app's own chat with Tex, the
  same history as its texts). The agent that ran on a model key the person
  pasted into Settings is gone (Dev2, 2026-10-10: "remove chat from the sidebar
  entirely"); this tab is one chat with Tex, offered only to the owner of their
  personal workspace, and asking about a context still happens in the AI
  clients people connect to it.
*/
export const ASIDE_TABS = [
  /*
    The live map's two tabs, only while the map is open (Dev2, 2026-11-04:
    the map's own column merged into this panel). Activity is who is working
    and what is happening; Note is the note clicked on the map.
  */
  { key: "activity", label: "Activity" },
  { key: "note", label: "Note" },
  { key: "meetings", label: "Meetings" },
  /* Right after Meetings, as the rail has it: under the calendar icon. */
  { key: "tex", label: "Tex" },
  /*
    The vault: the keys an AI client uses without seeing, its own place rather
    than a page of Settings (Dev, 2026-11-23). Only with a workspace open.
  */
  { key: "vault", label: "Vault" },
] as const;

export type AsideTab = (typeof ASIDE_TABS)[number]["key"];

export const DEFAULT_ASIDE_TAB: AsideTab = "meetings";

/**
 * The tabs a console shows, in order.
 *
 * Meetings is always there. Activity, and Note with a note clicked, lead
 * while the live map is open. Tex is there only where the owner's chat is
 * open. Approvals is not a tab at all: the Tex chat answers them inline
 * (owner, 2026-11-19: "no approvals tab, just make the approvals happen right
 * inside the message box"), and the count of what is waiting rides on the Tex
 * tab's label instead.
 */
export function visibleAsideTabs({
  map = false,
  note = false,
  tex = false,
  vault = false,
}: {
  /** This console has a Tex chat to show: the owner of the personal workspace it has open. */
  tex?: boolean;
  /** The live map is open: its Activity tab leads. */
  map?: boolean;
  /** A note is clicked on the open map: its Note tab follows Activity. */
  note?: boolean;
  /** A workspace is open, so its vault can be shown, after Tex. */
  vault?: boolean;
}): AsideTab[] {
  return ASIDE_TABS.map((tab) => tab.key).filter((key) => {
    if (key === "activity") return map;
    if (key === "note") return map && note;
    if (key === "tex") return tex;
    if (key === "vault") return vault;
    return true;
  });
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
 * What the Meetings tab says with nothing recording, nothing left today and no
 * meeting notes: one short line (owner, 2026-11-19: "less text"). It used to be
 * a sentence over every list, explaining what would land there.
 */
export const NO_MEETING = "No meetings yet.";


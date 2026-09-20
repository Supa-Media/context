/**
 * The right panel's two tabs, as decisions rather than as JSX.
 *
 * `features/console/capabilities.ts` states the rule this file exists for in
 * one line: every guard expressed inside a component in this app was held by
 * nothing. Which tab is showing, whether a meeting may take it, and what the
 * Meetings tab says when there is nothing to say are each decided here.
 *
 * ## Why the panel holds two things and not one
 *
 * They are the two things that happen *beside* a note rather than in it: a
 * conversation about what is written, and a recording of what is being said.
 * Both used to float — the agent over the corner of the editor, the meeting
 * over whatever you were reading — and both floated for the same reason, which
 * is that neither had anywhere to live. Giving them a home is the whole of this
 * feature, and it is why they share one panel instead of taking two.
 */

export const ASIDE_TABS = [
  { key: "chat", label: "Chat" },
  { key: "meetings", label: "Meetings" },
] as const;

export type AsideTab = (typeof ASIDE_TABS)[number]["key"];

export const DEFAULT_ASIDE_TAB: AsideTab = "chat";

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

/** What the Chat tab is for, said once, where somebody meets it. */
export const CHAT_INTRO =
  "Ask about this note, or anything in your context. Answers come from your notes, and nothing is edited without you.";

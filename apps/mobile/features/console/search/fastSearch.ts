/**
 * Fast search, in a context's settings: the states, the copy, and the guard
 * that decides whether a control is offered at all.
 *
 * The backend contract is
 *
 *   fastSearch.status({ workspaceId })
 *     -> { state, canChange, notesIndexed?, notesPending?, error?, optedInAt? }
 *   fastSearch.enable({ workspaceId })   // owner-only
 *   fastSearch.disable({ workspaceId })  // owner-only
 *
 * and the two mutations are owner-only while the query is readable by any
 * member — knowing how a context's search is served is not privileged, and
 * deciding it is. `canChange` is the server's own answer to the second
 * question, which is why nothing here re-derives it from a role.
 *
 * With one limit: the backfill counters come back only to an OWNER. They are
 * not how search is served, they are a count of the notes, and the index
 * counts private ones a member may not read. The server drops them; this file
 * never has to know whose they are.
 *
 * ## What the switch actually does, which is why the copy is not "make search
 * faster"
 *
 * Turning it on puts a **derived copy of this context's note text, private
 * notes included, in a database Supa Media owns** — that is the whole of what
 * an owner is consenting to, and `docs/decisions/search.md` is emphatic that
 * off-by-default exists because the alternative is making that choice on
 * somebody else's behalf. Turning it off deletes the database. Neither
 * sentence may be left out of the card, so both live here rather than inline
 * in JSX where an edit could quietly drop one.
 *
 * Nothing here claims the canonical notes move: they stay in the customer's
 * bucket either way (CLAUDE.md, non-negotiable 1), and the index is a
 * disposable derivative (non-negotiable 3).
 *
 * ## Off is a working state
 *
 * Every "off" sentence has to read as a working product rather than a missing
 * feature, because it is one: search falls back to the R2 index the instant
 * `optedIn` goes false. A card that draws `off` as a warning teaches people to
 * turn on a copy of their private notes to clear a badge.
 *
 * Pure, and free of React, so the awkward cases — a state this build has never
 * heard of, a count nobody has measured, an action offered to somebody the
 * server would refuse — are pinned by tests rather than found on a phone.
 */

export const FAST_SEARCH_STATES = [
  "off",
  "preparing",
  "on",
  "failed",
  "unavailable",
] as const;

export type FastSearchState = (typeof FAST_SEARCH_STATES)[number];

/** Exactly what `fastSearch.status` returns. */
export interface FastSearchStatus {
  state: FastSearchState;
  /** The server's answer to "may this caller change it", never a role read here. */
  canChange: boolean;
  /**
   * How much of the context is in the index, and how much is waiting.
   *
   * **Optional, and absent is not zero** — the same rule the storage binding's
   * measurements follow. A `0` drawn from an absent field is a claim, so the
   * label is omitted instead.
   *
   * Absent now has two causes, and the code must treat them identically:
   * nobody has looked yet, OR the viewer is not the owner and the server
   * withheld a census of notes they may not read. Rendering a zero would leak
   * in the second case what omitting the label does not.
   */
  notesIndexed?: number;
  notesPending?: number;
  /** Our sentence for a failed provision, from the closed set in `fastSearchProvision.ts`. */
  error?: string;
  optedInAt?: number;
}

/**
 * What the settings card renders.
 *
 * `status === null` is "not asked, or not answered yet", and is deliberately
 * not a synthesised `off`: a console that reads a pending subscription as
 * "off" tells an owner their index is gone every time the page reloads, which
 * is the same class of bug `ConsoleData.storage` keeps three values for.
 *
 * `enable` and `disable` are **absent** rather than disabled for anybody the
 * server would refuse — the rule `StorageActions` states and this follows.
 */
export interface FastSearchView {
  status: FastSearchStatus | null;
  loading: boolean;
  enable?: () => Promise<void>;
  disable?: () => Promise<void>;
}

/**
 * Read a state off the wire.
 *
 * A deployment newer than this bundle can answer with a state this build has
 * never heard of, and the direction that must fail is **towards offering
 * nothing**: `unavailable` draws an explanation and no switch, where a
 * fallback of `off` would offer to provision a database against a control
 * plane whose vocabulary we do not share, and one of `on` would tell somebody
 * a copy of their notes exists when we cannot know that.
 */
export function fastSearchStateOf(raw: unknown): FastSearchState {
  return (FAST_SEARCH_STATES as readonly string[]).includes(raw as string)
    ? (raw as FastSearchState)
    : "unavailable";
}

/**
 * Which control the card draws, and the only place that decides.
 *
 * Three conditions, all of them load-bearing:
 *
 *  - the status has landed — there is nothing honest to offer before it;
 *  - `canChange`, which is the server's answer and not a role guessed here;
 *  - the action exists, which is how the demo console and a non-owner end up
 *    with a card that reads and a card that acts being the same component.
 *
 * `failed` gets `retry` rather than `enable` because the row is already opted
 * in: pressing it re-runs the provision, and a button labelled "Turn on" over
 * a switch that is already on is a lie about what the press does.
 */
export function fastSearchControl(
  view: FastSearchView,
): "none" | "enable" | "disable" | "retry" {
  const status = view.status;
  if (status === null || !status.canChange) return "none";
  switch (status.state) {
    case "off":
      return view.enable === undefined ? "none" : "enable";
    case "failed":
      return view.enable === undefined ? "none" : "retry";
    case "on":
    case "preparing":
      return view.disable === undefined ? "none" : "disable";
    case "unavailable":
      return "none";
  }
}

/**
 * The heading and the paragraph for each state.
 *
 * `off` and `on` both have to say what the copy *is* and where it lives,
 * because that is the decision being taken and reversed. `preparing` says
 * search still works, which is true and is the difference between a person
 * waiting calmly and a person pressing the switch again.
 */
export function describeFastSearch(state: FastSearchState): {
  title: string;
  blurb: string;
} {
  switch (state) {
    case "off":
      return {
        title: "Fast search is off",
        blurb:
          "Search reads the index in your own bucket, which is how this product works today. Turn fast search on and Context also keeps a searchable copy of this context's note text — private notes included — in a database Supa Media runs. Your Markdown stays in your bucket either way.",
      };
    case "preparing":
      return {
        title: "Preparing the index",
        blurb:
          "The database is being created and your notes are being copied into it. Search keeps working from your own bucket until it is ready.",
      };
    case "on":
      return {
        title: "Fast search is on",
        blurb:
          "A searchable copy of this context's note text, private notes included, is held in a database Supa Media runs. Turning it off deletes that database; your Markdown is untouched in your own bucket.",
      };
    case "failed":
      return {
        title: "The index could not be prepared",
        blurb:
          "Search is still served from your own bucket, so nothing has stopped working. Try again, and if it keeps failing the deployment's Cloudflare credentials are the place to look.",
      };
    case "unavailable":
      return {
        title: "Fast search is not available here",
        blurb:
          "This context cannot use the hosted index. Search is served from your own bucket, which is the product as it already is.",
      };
  }
}

/** The status chip beside the heading, or `null` where a chip would be noise. */
export function fastSearchPill(
  state: FastSearchState,
): { label: string; tone: "ok" | "warn" | "neutral" } | null {
  switch (state) {
    case "on":
      return { label: "On", tone: "ok" };
    case "preparing":
      return { label: "Preparing", tone: "neutral" };
    case "failed":
      return { label: "Failed", tone: "warn" };
    // `off` and `unavailable` are working states, and a chip on a working
    // state is a badge somebody clears by turning on a copy of their notes.
    case "off":
    case "unavailable":
      return null;
  }
}

/**
 * "1,284 notes indexed · 12 waiting", or `null` when nobody has counted.
 *
 * Absent stays absent, exactly as `ConsoleStorage`'s measurements do. The
 * "waiting" half is dropped at zero rather than printed, because `· 0 waiting`
 * reads as a queue that is stuck rather than one that is empty.
 */
export function indexedLabel(status: FastSearchStatus | null): string | null {
  if (status === null || status.notesIndexed === undefined) return null;
  const indexed = `${status.notesIndexed.toLocaleString("en-US")} ${
    status.notesIndexed === 1 ? "note" : "notes"
  } indexed`;
  const pending = status.notesPending ?? 0;
  return pending > 0 ? `${indexed} · ${pending.toLocaleString("en-US")} waiting` : indexed;
}

/**
 * Whether to subscribe at all.
 *
 * Any member may read the status, so the only question is whether there is a
 * context to ask about. The demo console has none: it holds a picture of a
 * console, and `useDemoConsoleData` fills this in without a round trip.
 */
export function shouldReadFastSearch(options: {
  workspaceId: string | null;
}): boolean {
  return options.workspaceId !== null;
}

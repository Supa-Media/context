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
  /**
   * The server's own "how far through is the backfill", 0–100.
   *
   * **Owner-only, on exactly the same grounds as the two counters above**, and
   * for a sharper reason than either: a percentage *is* the subtraction. A
   * member who may read only the `team` tier and is handed "62%" over a list
   * of notes they can see has been told how much of the context they are not
   * being shown, and can watch that move as private notes are written.
   *
   * Optional, and it is optional in two senses that are deliberately not
   * distinguished here: the deployment may not send it at all (it is being
   * added to `fastSearch.status` alongside this), and it is dropped for a
   * non-owner. Both come out of the wire as `undefined` and both mean the same
   * thing to this file — do not derive a percentage for this viewer from the
   * counters either, because `notesIndexed` is withheld from the same people.
   *
   * `indexProgress` prefers this over its own arithmetic when it is present
   * and sane, and falls back to `notesIndexed / (notesIndexed + notesPending)`
   * when it is not. It is range-checked rather than trusted: a total that
   * shrinks mid-backfill (notes deleted while the pass is running) can produce
   * a figure above 100, and printing that would be worse than deriving one.
   */
  percentIndexed?: number;
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

/* -------------------------------------------------------------------------- */
/*                          how much of it is indexed                          */
/* -------------------------------------------------------------------------- */

/**
 * How far through the backfill this context is, as something a surface can
 * draw.
 *
 * ## Why this is a shape and not a number
 *
 * "0 notes indexed" on one settings card was the whole of what the console
 * said about a backfill, and it is what made a **stuck** backfill and a
 * **working** one look identical for hours. The fix is a percentage — but a
 * percentage has four states that a bare number cannot tell apart, and
 * flattening any of them puts the original bug back in a new costume:
 *
 *  - **nothing at all to say** (`null`) — the viewer is not the owner, or
 *    nobody has counted. Absent is not zero, the rule every measurement in
 *    this console follows;
 *  - **there is nothing to index** — a context with no notes. A percentage of
 *    nothing is not `0%`; it is not a percentage. `0%` here accuses an empty
 *    context of being a stalled one;
 *  - **nothing is indexed yet, and notes are waiting** — which is *exactly*
 *    what the missing backfill looked like, and is the one case that must
 *    never be drawn as `0%`. A number that never moves reads as a number
 *    somebody is computing; a sentence saying nothing has arrived reads as the
 *    fact it is;
 *  - **some of it is in** — the only case with a percentage in it.
 *
 * ## The denominator is a floor, and `pending: 0` does not mean "finished"
 *
 * `notesIndexed + notesPending` is what the backfill *knows about*, not what
 * the bucket holds — the walk that discovers the rest may not have run. So a
 * `preparing` context whose queue happens to be empty is `counting`, not
 * `complete`: printing `100%` under a heading that says "Preparing the index"
 * claims a backfill has finished when the state says it has not, which is the
 * same false-confidence bug pointing the other way. Only `on` means finished,
 * because only `on` is the control plane saying so.
 *
 * ## Off has no percentage, and that is not an omission
 *
 * `off` and `unavailable` have no index, so there is no proportion of one.
 * They also draw no chip, for the reason `fastSearchPill` gives: a badge on a
 * working state is something people clear by turning on a copy of their
 * private notes. `0% indexed` beside "Fast search is off" would be that badge
 * with a number in it.
 */
export type IndexProgress =
  /** An index exists and this context has nothing to put in it. */
  | { kind: "empty" }
  /** Notes are waiting and none of them have arrived. Never `0%`. */
  | { kind: "none"; pending: number }
  /** Some are in, nothing is waiting, and the state says it is not done. */
  | { kind: "counting"; indexed: number }
  /** `percent` is 1–99: never 0 while something is in, never 100 while something waits. */
  | { kind: "partial"; percent: number; indexed: number; total: number }
  /** Everything counted is in, and the control plane says the backfill is over. */
  | { kind: "complete"; indexed: number };

/**
 * A count off the wire, or `null` where it is not a count.
 *
 * `NaN`, `Infinity` and a negative all reach this from the same place — a
 * control plane newer than this bundle, or a row patched by hand — and each of
 * them produces a percentage that is worse than no percentage.
 *
 * **It takes a `number`, never `number | undefined`, and that is the guard
 * rather than a signature detail.** `notesIndexed` is absent for a non-owner,
 * so the one line that would leak a census is
 * `wholeCount(status.notesIndexed ?? 0)` — the "absent is zero" reflex this
 * whole console is written against. Typed this way, writing it is a compile
 * error rather than a review note, which is the same trick
 * `features/offline/keys.ts` uses to make filing a cached copy under no
 * clearance impossible rather than merely discouraged.
 */
function wholeCount(raw: number): number | null {
  if (!Number.isFinite(raw) || raw < 0) return null;
  return Math.floor(raw);
}

/**
 * The digits, from the server's figure where there is one and from the counts
 * where there is not.
 *
 * Two roundings are refused rather than allowed, and they are the two that
 * matter:
 *
 *  - **never `0%` while a note is in the index.** `1` note of `20,000` rounds
 *    to zero, and a percentage sitting at 0 is the exact appearance the
 *    missing backfill had. It reads as "nothing is happening" about something
 *    that is;
 *  - **never `100%` while a note is waiting.** `9,999` of `10,000` rounds to
 *    100, and a person who reads 100 stops looking for the note that is
 *    missing.
 *
 * The server's own figure is range-checked rather than trusted, because the
 * total it was computed against can shrink under it: notes deleted while a
 * pass is running leave `indexed` above the new total, and `104%` is a bug
 * report rather than progress.
 */
function progressPercent(
  status: FastSearchStatus,
  indexed: number,
  total: number,
): number {
  const fromServer = status.percentIndexed;
  const raw =
    fromServer !== undefined && Number.isFinite(fromServer) && fromServer >= 0 && fromServer <= 100
      ? fromServer
      : (indexed / total) * 100;
  return Math.min(99, Math.max(1, Math.round(raw)));
}

/**
 * Read the progress off a status, or `null` where there is none to read.
 *
 * The **owner-only** guard is the first thing in it and is the one line in
 * this file that is a security control rather than a presentation choice.
 * `notesIndexed` is `undefined` for a non-owner because the index counts every
 * note the context has, private ones included, while a member may read only
 * the `team` tier — so the total, and any percentage of it, is the size of
 * what they are not being shown. Deriving a percentage from anything else for
 * that viewer would reintroduce exactly what the server withheld.
 */
export function indexProgress(status: FastSearchStatus | null): IndexProgress | null {
  if (status === null) return null;
  // Owner-only, and absent is "this viewer does not get this" — never zero.
  if (status.notesIndexed === undefined) return null;
  // No index exists in these two, so there is no proportion of one.
  if (status.state === "off" || status.state === "unavailable") return null;

  const indexed = wholeCount(status.notesIndexed);
  if (indexed === null) return null;
  // An absent queue is a queue of none — the server writes `notesIndexed`
  // first — but a *malformed* one is not something to guess at.
  const pending = status.notesPending === undefined ? 0 : wholeCount(status.notesPending);
  if (pending === null) return null;

  if (indexed + pending === 0) return { kind: "empty" };
  if (indexed === 0) return { kind: "none", pending };
  if (pending === 0) {
    return status.state === "on"
      ? { kind: "complete", indexed }
      : { kind: "counting", indexed };
  }
  return {
    kind: "partial",
    percent: progressPercent(status, indexed, indexed + pending),
    indexed,
    total: indexed + pending,
  };
}

/** 1284 → "1,284". The same grouping `indexedLabel` uses. */
function group(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * What every surface draws, or `null` where every surface draws nothing.
 *
 * Shaped like `describeFastSearch` — one call, all the words — and it is one
 * function rather than arithmetic at each call site for a narrower reason than
 * tidiness. Three surfaces rounding the same ratio three ways would show a
 * person `62%` in the settings card, `63%` in the status bar and `61%` under
 * the file tree for one context at one moment, and the first thing anybody
 * does with a progress figure is compare it with the last one they saw. It is
 * also the single place the owner-only rule is applied, so a fourth surface
 * added next year inherits it instead of re-deriving it.
 *
 * `tone` travels **with** the words rather than being sniffed back out of them
 * by a caller. A strip that decided its own tone by matching on "Stopped"
 * would go quiet the day this copy is reworded, silently, in the direction
 * where a failed backfill stops looking like one.
 *
 * `label` is a fragment ("62% indexed") and `detail` is the sentence. The
 * detail says what the denominator *is* — the notes the backfill has counted,
 * not the notes the bucket holds — because a percentage over a floor that can
 * grow is a percentage that can go *down*, and somebody watching that happen
 * is owed the reason.
 *
 * `null` means **render nothing**: not an em dash, not a `0%`, not a skeleton
 * implying a number is on its way. A caller that substitutes a placeholder has
 * undone the guard, because the commonest cause of `null` is a member the
 * server declined to tell.
 */
export function describeIndexProgress(
  status: FastSearchStatus | null,
): { label: string; detail: string; tone: "quiet" | "warn" } | null {
  const progress = indexProgress(status);
  if (progress === null || status === null) return null;
  const failed = status.state === "failed";
  const tone = failed ? ("warn" as const) : ("quiet" as const);
  const stopped = failed
    ? " The backfill stopped before it finished; nothing else is being copied."
    : "";

  switch (progress.kind) {
    case "empty":
      // Not "0% indexed". Nothing is missing, so nothing is behind.
      return {
        label: failed
          ? "Nothing was indexed"
          : status.state === "on"
            ? "No notes to index"
            : "Nothing indexed yet",
        detail: `This context has no notes to copy into the fast-search index.${stopped}`,
        tone,
      };
    case "none":
      // The case this whole feature exists for: a queue with nothing coming
      // out of it. Said in words, because "0%" is exactly what it looked like
      // when nobody could tell a stuck backfill from a working one.
      return {
        label: failed ? "Nothing was indexed" : "Nothing indexed yet",
        detail:
          `None of the ${group(progress.pending)} notes counted so far have reached the ` +
          `fast-search index yet.${stopped}`,
        tone,
      };
    case "counting":
      return {
        label: failed
          ? `Stopped after ${group(progress.indexed)} indexed`
          : `${group(progress.indexed)} indexed so far`,
        detail:
          `${group(progress.indexed)} notes are in the fast-search index and none are ` +
          `waiting, but this context is still being prepared — more notes may still be ` +
          `found.${stopped}`,
        tone,
      };
    case "partial":
      return {
        label: failed
          ? `Stopped at ${progress.percent}% indexed`
          : `${progress.percent}% indexed`,
        detail:
          `${group(progress.indexed)} of the ${group(progress.total)} notes counted so far ` +
          `are in the fast-search index. That total is what the backfill has counted, not ` +
          `everything in your bucket, so it can still grow.${stopped}`,
        tone,
      };
    case "complete":
      return {
        label: "100% indexed",
        detail:
          `Every one of the ${group(progress.indexed)} notes in this context is in the ` +
          `fast-search index.`,
        tone,
      };
  }
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

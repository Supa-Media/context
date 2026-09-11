/**
 * Where you have been in this context, and the way back.
 *
 * Obsidian's mobile toolbar leads with `‹` and `›`, and they are the first two
 * of its six controls — before search, before new, before tabs. That placement
 * is not decoration: a phone shows one note at a time, so "the note I was just
 * looking at" is a destination you reach constantly and cannot see. Our toolbar
 * had no answer to it at all; the only way back to the previous note was to
 * open the drawer and find it in the tree again.
 *
 * ## Why a separate stack from the tab strip
 *
 * Tabs are a *set* of open notes; history is an *order* of visits. Two tabs can
 * be open while you have moved between them six times, and `⌘⇧T` reopening a
 * closed tab is not the same act as stepping back to where you were. Deriving
 * one from the other would make both wrong: back would skip a revisit, and
 * closing a tab would erase somewhere you had been.
 *
 * ## The shape is a browser's, deliberately
 *
 * A cursor into a list, not a stack of two. Stepping back and then visiting
 * somewhere new **truncates the forward tail**, because a forward entry is a
 * prediction about a branch you have just left — every browser does this, and
 * the alternative is a forward button that goes somewhere you never chose.
 *
 * Pure, so the interesting cases — a revisit, a step back followed by a new
 * visit, the ends of the list — are tested without a renderer.
 */

export interface HistoryState {
  /** Visited paths, oldest first. */
  entries: readonly string[];
  /** Cursor into `entries`. `-1` only while nothing has been visited. */
  at: number;
}

export const emptyHistory: HistoryState = { entries: [], at: -1 };

/** The note the cursor is on, or `null` before anything has been visited. */
export function currentPath(state: HistoryState): string | null {
  return state.at < 0 ? null : (state.entries[state.at] ?? null);
}

/**
 * Record a visit.
 *
 * Re-visiting where you already are is a **no-op**, not an entry. Otherwise
 * every re-render that re-selects the open note would grow the list, and back
 * would need two presses to go anywhere — which is the bug that makes people
 * stop trusting a back button.
 */
export function visited(state: HistoryState, path: string): HistoryState {
  if (currentPath(state) === path) return state;
  const kept = state.entries.slice(0, state.at + 1);
  return { entries: [...kept, path], at: kept.length };
}

/**
 * How many rows the Recent sheet offers.
 *
 * A sheet is `maxHeight: 70%` and scrolls, so the cap is not about fitting —
 * it is about what is still recognisable. Past a dozen or so the rows are
 * somewhere you were this morning, which is a search, not a jump.
 */
export const MAX_RECENT = 15;

/**
 * Where you have been, as a list — newest first, each place once.
 *
 * The phone's `‹` reaches the previous note; this reaches the previous fifteen,
 * and it is what the Recent sheet draws. **Derived from `entries` rather than
 * kept beside them**, which is the whole point: the tab switcher this replaced
 * was a second model of "which notes am I working with" living on the same
 * toolbar as this one, and it could not be reconciled with navigation — closing
 * its last row left the note on screen, because a tab set knows nothing about
 * where you are. One array, walked forwards by `‹ ›` and backwards by this, has
 * no second answer to disagree with.
 *
 * It inherits the cost of that, and the cost is real: stepping back and then
 * visiting somewhere new truncates the forward tail, so a note you looked at two
 * minutes ago can leave this list. That is `visited`'s browser rule, argued at
 * the top of this file, and a non-truncating log beside it would buy those rows
 * back at the price of the thing being removed.
 *
 * Duplicates are collapsed even though `entries` keeps them — a repeat visit is
 * a real step for `‹`, and two identical rows in a sheet is a list that reads as
 * broken. Folders are kept: history records the *selection*, and "back to the
 * folder I was in" is a destination a phone reaches constantly.
 */
export function recentPaths(state: HistoryState): string[] {
  const seen = new Set<string>();
  const recent: string[] = [];
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const path = state.entries[index];
    if (seen.has(path)) continue;
    seen.add(path);
    recent.push(path);
    if (recent.length === MAX_RECENT) break;
  }
  return recent;
}

/**
 * Whether the Recent sheet has anywhere to send you.
 *
 * Not `recentPaths(state).length > 0`. The list always contains the note on
 * screen — the sheet marks that row rather than hiding it, so a person opening
 * it can see where they stand — which makes "one entry, and it is the one I am
 * looking at" the real empty case. It is also the *ordinary* case on the first
 * note of a session, and a control that offers to take somebody where they
 * already are is one they learn to stop pressing.
 *
 * `selected` is the selection rather than the editor's path, because a folder is
 * a place this list holds too: standing in `1-projects` with `1-projects` as the
 * only entry is the same dead end.
 */
export function hasSomewhereToGo(state: HistoryState, selected: string | null): boolean {
  return state.entries.some((path) => path !== selected);
}

export function canGoBack(state: HistoryState): boolean {
  return state.at > 0;
}

export function canGoForward(state: HistoryState): boolean {
  return state.at >= 0 && state.at < state.entries.length - 1;
}

/**
 * Move the cursor. Refuses to run off either end rather than clamping silently,
 * so a caller can tell "nothing happened" from "moved to the same place".
 */
export function stepped(state: HistoryState, delta: -1 | 1): HistoryState {
  const next = state.at + delta;
  if (next < 0 || next >= state.entries.length) return state;
  return { ...state, at: next };
}

/**
 * Forget everything.
 *
 * Switching context is the case. Paths are relative to a bucket, so a history
 * carried across would offer to take somebody "back" to a note that does not
 * exist where they now are — and the refusal would arrive as a read failure
 * against somebody else's context.
 */
export function clearedHistory(): HistoryState {
  return emptyHistory;
}

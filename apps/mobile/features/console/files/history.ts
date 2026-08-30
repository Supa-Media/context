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
